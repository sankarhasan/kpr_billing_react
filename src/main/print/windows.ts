/**
 * Phase 6 — print / PDF window management (Electron main process only).
 *
 * Security model:
 *  - The renderer can only ask (over validated IPC) to open/preview/print/
 *    export an invoice BY DATABASE ID in one of two whitelisted formats.
 *    It can never supply a URL, filesystem path, HTML or print options.
 *  - Windows are loaded exclusively with this app's own packaged renderer
 *    URL + a controlled `?print=1…` query the MAIN process builds.
 *  - print()/printToPDF() run only against webContents this module created
 *    (tracked by id); the save-dialog filename comes from the STORED invoice
 *    number, sanitized here in main.
 *  - Printing/exporting is strictly read-only for the database.
 */
import { app, BrowserWindow, dialog, webContents } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDatabase } from '../db'
import { getInvoice } from '../db/invoices-repo'
import { IPC_EVENTS } from '@shared/ipc'
import {
  pdfPageSizeInches,
  safePdfFileName,
  validatePrintWindowRequest,
  type PrintFormat,
  type PrintOutcome,
  type PrintRunResult,
  type PrintWindowMode
} from '@shared/print'
import { ipcErr, ipcOk } from '@shared/products'

interface TrackedWindow {
  win: BrowserWindow
  invoiceId: number
  format: PrintFormat
}

interface PendingAction {
  mode: Extract<PrintWindowMode, 'print' | 'pdf'>
  requesterId: number
  timer: NodeJS.Timeout
}

/** webContents.id → created print windows (the ONLY printable surfaces). */
const printWindows = new Map<number, TrackedWindow>()
/** webContents.id → main-triggered action awaiting document-ready. */
const pendingActions = new Map<number, PendingAction>()

/** Max wait for the print window's React document to render. */
const READY_TIMEOUT_MS = 15_000

function pdfOptions(format: PrintFormat): Electron.PrintToPDFOptions {
  const size = pdfPageSizeInches(format)
  const narrow = format === 'receipt'
  return {
    printBackground: true,
    landscape: false,
    pageSize: format === 'a4' ? 'A4' : { width: size.width, height: size.height },
    margins: {
      top: narrow ? 0.1 : 0.3,
      bottom: narrow ? 0.15 : 0.3,
      left: narrow ? 0.08 : 0.3,
      right: narrow ? 0.08 : 0.3
    }
  }
}

function loadRenderer(win: BrowserWindow, invoiceId: number, format: PrintFormat): void {
  const query = { print: '1', invoiceId: String(invoiceId), format }
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const url = new URL(devUrl)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}

function createPrintWindow(invoiceId: number, format: PrintFormat, show: boolean): BrowserWindow {
  const win = new BrowserWindow({
    title: `Invoice — ${format === 'receipt' ? '80mm receipt' : 'A4'}`,
    width: format === 'receipt' ? 460 : 860,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  const wcId = win.webContents.id
  printWindows.set(wcId, { win, invoiceId, format })

  if (show) win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    const timer = pendingActions.get(wcId)?.timer
    if (timer) clearTimeout(timer)
    printWindows.delete(wcId)
    pendingActions.delete(wcId)
  })

  loadRenderer(win, invoiceId, format)
  return win
}

function notifyRequester(requesterId: number, invoiceId: number, format: PrintFormat, result: PrintOutcome): void {
  try {
    const wc = webContents.fromId(requesterId)
    wc?.send(IPC_EVENTS.PRINT_PDF_RESULT, { invoiceId, format, result })
  } catch {
    /* requester window gone — nothing to notify */
  }
}

function runPrint(wc: Electron.WebContents): Promise<PrintOutcome> {
  return new Promise<PrintOutcome>((resolve) => {
    try {
      wc.print({ silent: false, printBackground: true, deviceName: '' }, (success, failureReason) => {
        if (success) resolve(ipcOk({ printed: true }))
        else if (/cancel/i.test(failureReason ?? '')) resolve(ipcErr('CANCELLED', 'Printing was cancelled.'))
        else resolve(ipcErr('IO_ERROR', `Printing failed${failureReason ? `: ${failureReason}` : '.'}`))
      })
    } catch (err) {
      resolve(ipcErr('IO_ERROR', err instanceof Error ? err.message : 'Printing failed.'))
    }
  })
}

async function runSavePdf(wc: Electron.WebContents, invoiceId: number, format: PrintFormat): Promise<PrintOutcome> {
  // Filename ALWAYS derives from the STORED invoice number (never from the renderer).
  const invoice = getInvoice(getDatabase(), invoiceId)
  if (!invoice) return ipcErr('NOT_FOUND', 'Invoice no longer exists.')

  let data: Buffer
  try {
    data = await wc.printToPDF(pdfOptions(format))
  } catch (err) {
    return ipcErr('IO_ERROR', err instanceof Error ? err.message : 'PDF generation failed.')
  }

  const defaultName = safePdfFileName(invoice.invoiceNumber)
  const saveOptions = {
    title: 'Save invoice as PDF',
    defaultPath: join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'PDF files', extensions: ['pdf'] }]
  }
  const win = BrowserWindow.fromWebContents(wc)
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, saveOptions)
    : await dialog.showSaveDialog(saveOptions)
  if (canceled || !filePath) {
    return ipcErr('CANCELLED', 'PDF save was cancelled.')
  }
  if (existsSync(filePath)) {
    const choice = win
      ? dialog.showMessageBoxSync(win, {
          type: 'warning',
          buttons: ['Overwrite', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'File exists',
          message: `${filePath} already exists.`,
          detail: 'Overwrite it?'
        })
      : dialog.showMessageBoxSync({
          type: 'warning',
          buttons: ['Overwrite', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'File exists',
          message: 'File already exists. Overwrite?'
        })
    if (choice !== 0) return ipcErr('CANCELLED', 'PDF save was cancelled (existing file kept).')
  }
  try {
    writeFileSync(filePath, data)
  } catch (err) {
    return ipcErr('IO_ERROR', err instanceof Error ? `Could not write PDF: ${err.message}` : 'Could not write PDF.')
  }
  return ipcOk({ filePath })
}

function armPendingAction(targetWcId: number, mode: 'print' | 'pdf', requesterId: number): void {
  const previous = pendingActions.get(targetWcId)
  if (previous) clearTimeout(previous.timer)
  const timer = setTimeout(() => {
    pendingActions.delete(targetWcId)
    const err = ipcErr<PrintRunResult>('IO_ERROR', 'The invoice document did not become ready in time. Use the window buttons to retry.')
    if (mode === 'pdf') {
      notifyRequester(requesterId, printWindows.get(targetWcId)?.invoiceId ?? 0, printWindows.get(targetWcId)?.format ?? 'a4', err)
      const tracked = printWindows.get(targetWcId)
      if (tracked && !tracked.win.isDestroyed() && !tracked.win.isVisible()) tracked.win.close()
    }
  }, READY_TIMEOUT_MS)
  pendingActions.set(targetWcId, { mode, requesterId, timer })
}

// ─── IPC entry points (event carries the validated sender) ─────────────

/** Open a FRESH preview window, or run print / PDF export for a saved invoice. */
export function openPrintWindow(sender: Electron.WebContents, raw: unknown): PrintOutcome {
  const check = validatePrintWindowRequest(raw)
  if (!check.ok) return ipcErr<PrintRunResult>('INVALID_PARAMS', check.message)
  const { invoiceId, format, mode } = check.value

  // Read-only existence check — printing/exporting NEVER touches the DB.
  const invoice = getInvoice(getDatabase(), invoiceId)
  if (!invoice) return ipcErr<PrintRunResult>('NOT_FOUND', `Invoice #${invoiceId} was not found.`)

  // FRESHNESS (Phase 7): every request rebuilds its window so the document
  // always re-fetches the CURRENT shop settings (and the stored snapshot)
  // from main — reusing an open window could print stale shop details.
  // Any previous window for the same invoice+format is closed first, which
  // also prevents two print surfaces racing on one document.
  for (const t of printWindows.values()) {
    if (t.invoiceId === invoiceId && t.format === format && !t.win.isDestroyed()) {
      t.win.close()
    }
  }

  const win = createPrintWindow(invoiceId, format, mode !== 'pdf')
  if (mode === 'print' || mode === 'pdf') {
    armPendingAction(win.webContents.id, mode, sender.id)
  }
  return ipcOk({})
}

/** The print window reports its document rendered → run the armed action. */
export async function handleDocumentReady(sender: Electron.WebContents): Promise<PrintOutcome | null> {
  const pending = pendingActions.get(sender.id)
  if (!pending) return null
  clearTimeout(pending.timer)
  pendingActions.delete(sender.id)

  const tracked = printWindows.get(sender.id)
  if (!tracked || tracked.win.isDestroyed()) {
    return ipcErr('IO_ERROR', 'The print window was closed before the action ran.')
  }

  if (pending.mode === 'print') {
    const res = await runPrint(sender)
    notifyRequester(pending.requesterId, tracked.invoiceId, tracked.format, res)
    return res
  }

  const res = await runSavePdf(sender, tracked.invoiceId, tracked.format)
  notifyRequester(pending.requesterId, tracked.invoiceId, tracked.format, res)
  // Hidden export windows are single-use.
  if (!tracked.win.isVisible()) tracked.win.close()
  return res
}

/** Toolbar "Print" — only tracked print windows may print themselves. */
export async function printNow(sender: Electron.WebContents): Promise<PrintOutcome> {
  const tracked = printWindows.get(sender.id)
  if (!tracked || tracked.win.isDestroyed()) {
    return ipcErr('INVALID_PARAMS', 'Only invoice print windows may print.')
  }
  return runPrint(sender)
}

/** Toolbar "Save as PDF" — PDF of the sender's own document + native dialog. */
export async function savePdfSelf(sender: Electron.WebContents): Promise<PrintOutcome> {
  const tracked = printWindows.get(sender.id)
  if (!tracked || tracked.win.isDestroyed()) {
    return ipcErr('INVALID_PARAMS', 'Only invoice print windows may export PDF.')
  }
  return runSavePdf(sender, tracked.invoiceId, tracked.format)
}

/** Toolbar "Close" — closes only the requesting print window. */
export function closeSelf(sender: Electron.WebContents): void {
  const tracked = printWindows.get(sender.id)
  if (tracked && !tracked.win.isDestroyed()) tracked.win.close()
}
