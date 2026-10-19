/**
 * IPC handlers — main process only.
 * Every handler validates its inputs before touching the database or disk.
 * The renderer can only reach these channels through the preload bridge.
 */
import { ipcMain, app, BrowserWindow, dialog } from 'electron'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC_CHANNELS, type AppInfo, type CsvFilePicked, type CsvSaveRequest, type CsvSaveResult, type ImagePickResult } from '@shared/ipc'
import { getDbStatus, getImagesDir, getDatabase } from './db'
import * as repo from './db/products-repo'
import * as customersRepo from './db/customers-repo'
import * as invoicesRepo from './db/invoices-repo'
import {
  ipcErr,
  type IpcResult,
  type ProductListParams,
  type DuplicateStrategy,
  type ProductImportItem,
  type ProductImportSummary
} from '@shared/products'
import type { CustomerListParams } from '@shared/customers'

const MAX_CSV_BYTES = 20 * 1024 * 1024 // 20 MB import cap
const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5 MB image pick cap
const MAX_IMPORT_ROWS = 20_000

// ─── Validation helpers ────────────────────────────────────────────────

class ValidationError extends Error {
  constructor(
    public code: 'INVALID_PARAMS' | 'FILE_TOO_LARGE',
    message: string
  ) {
    super(message)
  }
}

function asOptionalObject(value: unknown, channel: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('INVALID_PARAMS', `Invalid arguments for "${channel}".`)
  }
  return value as Record<string, unknown>
}

function requireObject(value: unknown, channel: string): Record<string, unknown> {
  const o = asOptionalObject(value, channel)
  if (Object.keys(o).length === 0) {
    throw new ValidationError('INVALID_PARAMS', `Missing arguments for "${channel}".`)
  }
  return o
}

function validId(value: unknown, channel: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 1e12) {
    throw new ValidationError('INVALID_PARAMS', `Invalid id for "${channel}".`)
  }
  return value
}

function validString(value: unknown, maxLen: number, channel: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > maxLen) {
    throw new ValidationError('INVALID_PARAMS', `Invalid string argument ("${channel}").`)
  }
  return value
}

// ─── Registration wrapper ──────────────────────────────────────────────

type IpcHandler = (args: unknown[]) => unknown

function trustedHandle(channel: string, handler: IpcHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error(`Untrusted IPC sender on channel "${channel}"`)
    }
    try {
      return await handler(args)
    } catch (err) {
      if (err instanceof ValidationError) {
        return ipcErr(err.code, err.message)
      }
      console.error(`[ipc] "${channel}" failed:`, err)
      return ipcErr('DB_ERROR', err instanceof Error ? err.message : 'Unexpected error.')
    }
  })
}

function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  try {
    // Our app only ever runs from file:// (prod) or the dev server URL.
    const frameUrl: string = event.senderFrame?.url ?? event.sender.getURL() ?? ''
    return frameUrl.startsWith('file://') || frameUrl.startsWith('http://localhost')
  } catch {
    return false
  }
}

function ownerWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
}

// ─── Product list params ───────────────────────────────────────────────

function parseListParams(value: unknown): ProductListParams {
  const o = asOptionalObject(value, IPC_CHANNELS.PRODUCTS_LIST)
  const params: ProductListParams = {}
  const search = validString(o.search, 200, 'search')
  if (search !== undefined) params.search = search
  const category = validString(o.category, 100, 'category')
  if (category !== undefined) params.category = category
  if (typeof o.includeInactive === 'boolean') params.includeInactive = o.includeInactive
  if (typeof o.page === 'number' && Number.isInteger(o.page) && o.page > 0) params.page = Math.min(o.page, 1_000_000)
  if (typeof o.pageSize === 'number' && Number.isInteger(o.pageSize) && o.pageSize > 0 && o.pageSize <= 500) {
    params.pageSize = o.pageSize
  }
  return params
}

function parseCustomerListParams(value: unknown): CustomerListParams {
  const o = asOptionalObject(value, IPC_CHANNELS.CUSTOMERS_LIST)
  const params: CustomerListParams = {}
  const search = validString(o.search, 200, 'search')
  if (search !== undefined) params.search = search
  if (typeof o.includeArchived === 'boolean') params.includeArchived = o.includeArchived
  if (typeof o.page === 'number' && Number.isInteger(o.page) && o.page > 0) params.page = Math.min(o.page, 1_000_000)
  if (typeof o.pageSize === 'number' && Number.isInteger(o.pageSize) && o.pageSize > 0 && o.pageSize <= 500) {
    params.pageSize = o.pageSize
  }
  return params
}

// ─── Import: image data URL extraction (stored as local files, never DB) ─

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/

function persistImageDataUrl(input: Record<string, unknown>, savedFiles: string[]): void {
  const dataUrl = input.imageDataUrl
  if (typeof dataUrl !== 'string' || dataUrl === '') return
  delete input.imageDataUrl
  const m = DATA_URL_RE.exec(dataUrl)
  if (!m) {
    return // unsupported image type: drop silently is wrong; mark as path-less warning via error field
  }
  const ext = m[1] === 'jpeg' || m[1] === 'jpg' ? 'jpg' : m[1]
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
    throw new ValidationError('FILE_TOO_LARGE', 'Embedded image exceeds the 5 MB limit.')
  }
  const fileName = `${randomUUID()}.${ext}`
  writeFileSync(join(getImagesDir(), fileName), buf)
  savedFiles.push(fileName)
  input.imagePath = fileName
}

// ─── CSV export filename sanitisation ──────────────────────────────────

function sanitizeFileName(name: unknown): string {
  if (typeof name !== 'string') return 'products_export.csv'
  const base = basename(name)
  return /^[\w\-. ()]+\.csv$/i.test(base) ? base : 'products_export.csv'
}

// ─── Registration ──────────────────────────────────────────────────────

export function registerIpcHandlers(): void {
  // ── Phase 1 channels (plain payloads, kept stable) ──
  trustedHandle(IPC_CHANNELS.APP_GET_INFO, (args) => {
    expectNoArgs(IPC_CHANNELS.APP_GET_INFO, args)
    const info: AppInfo = {
      name: 'KPR Billing',
      version: app.getVersion(),
      platform: process.platform,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node
    }
    return info
  })

  trustedHandle(IPC_CHANNELS.DB_GET_STATUS, (args) => {
    expectNoArgs(IPC_CHANNELS.DB_GET_STATUS, args)
    return getDbStatus()
  })

  // ── Products CRUD ──
  trustedHandle(IPC_CHANNELS.PRODUCTS_LIST, (args) => {
    const params = parseListParams(args[0])
    return repo.listProducts(getDatabase(), params)
  })

  trustedHandle(IPC_CHANNELS.PRODUCTS_GET, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.PRODUCTS_GET)
    const id = validId(o.id, IPC_CHANNELS.PRODUCTS_GET)
    const product = repo.getProduct(getDatabase(), id)
    return product ? { ok: true, data: product } : ipcErr('NOT_FOUND', 'Product not found.')
  })

  trustedHandle(IPC_CHANNELS.PRODUCTS_CREATE, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.PRODUCTS_CREATE)
    return repo.createProduct(getDatabase(), o.input)
  })

  trustedHandle(IPC_CHANNELS.PRODUCTS_UPDATE, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.PRODUCTS_UPDATE)
    const id = validId(o.id, IPC_CHANNELS.PRODUCTS_UPDATE)
    return repo.updateProduct(getDatabase(), id, o.input)
  })

  trustedHandle(IPC_CHANNELS.PRODUCTS_DELETE, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.PRODUCTS_DELETE)
    const id = validId(o.id, IPC_CHANNELS.PRODUCTS_DELETE)
    return repo.deleteProduct(getDatabase(), id, getImagesDir())
  })

  trustedHandle(IPC_CHANNELS.PRODUCTS_CATEGORIES, (args) => {
    expectNoArgs(IPC_CHANNELS.PRODUCTS_CATEGORIES, args)
    return repo.listCategories(getDatabase())
  })

  // ── Customers CRUD ──
  trustedHandle(IPC_CHANNELS.CUSTOMERS_LIST, (args) => {
    const params = parseCustomerListParams(args[0])
    return customersRepo.listCustomers(getDatabase(), params)
  })

  trustedHandle(IPC_CHANNELS.CUSTOMERS_GET, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.CUSTOMERS_GET)
    const id = validId(o.id, IPC_CHANNELS.CUSTOMERS_GET)
    const customer = customersRepo.getCustomer(getDatabase(), id)
    return customer ? { ok: true, data: customer } : ipcErr('NOT_FOUND', 'Customer not found.')
  })

  trustedHandle(IPC_CHANNELS.CUSTOMERS_CREATE, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.CUSTOMERS_CREATE)
    return customersRepo.createCustomer(getDatabase(), o.input)
  })

  trustedHandle(IPC_CHANNELS.CUSTOMERS_UPDATE, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.CUSTOMERS_UPDATE)
    const id = validId(o.id, IPC_CHANNELS.CUSTOMERS_UPDATE)
    return customersRepo.updateCustomer(getDatabase(), id, o.input)
  })

  trustedHandle(IPC_CHANNELS.CUSTOMERS_DELETE, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.CUSTOMERS_DELETE)
    const id = validId(o.id, IPC_CHANNELS.CUSTOMERS_DELETE)
    return customersRepo.deleteCustomer(getDatabase(), id)
  })

  // ── Invoices ──
  trustedHandle(IPC_CHANNELS.INVOICES_CREATE, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.INVOICES_CREATE)
    return invoicesRepo.createInvoice(getDatabase(), o.input)
  })

  trustedHandle(IPC_CHANNELS.INVOICES_GET, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.INVOICES_GET)
    const id = validId(o.id, IPC_CHANNELS.INVOICES_GET)
    const invoice = invoicesRepo.getInvoice(getDatabase(), id)
    return invoice ? { ok: true, data: invoice } : ipcErr('NOT_FOUND', 'Invoice not found.')
  })

  trustedHandle(IPC_CHANNELS.INVOICES_GET_BY_NUMBER, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.INVOICES_GET_BY_NUMBER)
    const number = validString(o.number, 60, 'number')?.trim()
    if (!number) {
      throw new ValidationError('INVALID_PARAMS', 'A valid invoice number is required.')
    }
    const invoice = invoicesRepo.getInvoiceByNumber(getDatabase(), number)
    return invoice ? { ok: true, data: invoice } : ipcErr('NOT_FOUND', `No invoice found with number "${number}".`)
  })

  // ── Bulk CSV import (single transaction inside the repo) ──
  trustedHandle(IPC_CHANNELS.PRODUCTS_IMPORT, (args) => {
    const o = requireObject(args[0], IPC_CHANNELS.PRODUCTS_IMPORT)
    const strategy = o.strategy
    if (strategy !== 'skip' && strategy !== 'update') {
      throw new ValidationError('INVALID_PARAMS', 'strategy must be "skip" or "update".')
    }
    if (!Array.isArray(o.items) || o.items.length > MAX_IMPORT_ROWS) {
      throw new ValidationError('INVALID_PARAMS', `items must be an array of at most ${MAX_IMPORT_ROWS} rows.`)
    }

    const savedFiles: string[] = []
    try {
      const items: ProductImportItem[] = (o.items as unknown[]).map((raw, idx) => {
        const item = asOptionalObject(raw, `items[${idx}]`)
        const sourceRow =
          typeof item.sourceRow === 'number' && Number.isInteger(item.sourceRow) && item.sourceRow > 0
            ? item.sourceRow
            : idx + 1
        const input = asOptionalObject(item.input, `items[${idx}].input`)
        persistImageDataUrl(input, savedFiles)
        return { sourceRow, input }
      })

      const result: IpcResult<ProductImportSummary> = repo.importProducts(
        getDatabase(),
        items,
        strategy as DuplicateStrategy
      )
      if (!result.ok) {
        cleanupSavedFiles(savedFiles)
      }
      return result
    } catch (err) {
      // Catastrophic failure: transaction already rolled back; do not leave orphan images.
      cleanupSavedFiles(savedFiles)
      throw err
    }
  })

  // ── CSV file pick (read-only: the source file is never written) ──
  trustedHandle(IPC_CHANNELS.CSV_PICK_FILE, async (args) => {
    expectNoArgs(IPC_CHANNELS.CSV_PICK_FILE, args)
    const { canceled, filePaths } = await dialog.showOpenDialog(ownerWindow()!, {
      title: 'Import products from CSV',
      properties: ['openFile'],
      filters: [
        { name: 'CSV files', extensions: ['csv', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (canceled || filePaths.length === 0) {
      return { canceled: true } satisfies CsvFilePicked
    }
    const path = filePaths[0]
    const size = statSync(path).size
    if (size > MAX_CSV_BYTES) {
      throw new ValidationError('FILE_TOO_LARGE', `CSV file is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB.`)
    }
    const content = readFileSync(path, 'utf8')
    return {
      canceled: false,
      fileName: basename(path),
      content
    } satisfies CsvFilePicked
  })

  // ── CSV save (native dialog + explicit overwrite confirmation) ──
  trustedHandle(IPC_CHANNELS.CSV_SAVE_FILE, async (args) => {
    const req = requireObject(args[0], IPC_CHANNELS.CSV_SAVE_FILE) as unknown as CsvSaveRequest
    if (typeof req.content !== 'string' || req.content.length > 50_000_000) {
      throw new ValidationError('INVALID_PARAMS', 'Invalid CSV content.')
    }
    const defaultName = sanitizeFileName(req.defaultFileName)
    const saveOptions = {
      title: 'Export products to CSV',
      defaultPath: join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'CSV files', extensions: ['csv'] }]
    }
    const win0 = ownerWindow()
    const { canceled, filePath } = win0
      ? await dialog.showSaveDialog(win0, saveOptions)
      : await dialog.showSaveDialog(saveOptions)
    if (canceled || !filePath) {
      return { canceled: true } satisfies CsvSaveResult
    }
    if (existsSync(filePath)) {
      const win = ownerWindow()
      const choice = win
        ? dialog.showMessageBoxSync(win, {
            type: 'warning',
            buttons: ['Overwrite', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'File exists',
            message: `${basename(filePath)} already exists.`,
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
      if (choice !== 0) {
        return { canceled: true } satisfies CsvSaveResult
      }
    }
    // UTF-8 with BOM so Excel displays ₹ and accented text correctly.
    writeFileSync(filePath, '\ufeff' + req.content, 'utf8')
    return { canceled: false, filePath } satisfies CsvSaveResult
  })

  // ── Product image pick: copied into the app images folder ──
  trustedHandle(IPC_CHANNELS.IMAGE_PICK, async (args) => {
    expectNoArgs(IPC_CHANNELS.IMAGE_PICK, args)
    const { canceled, filePaths } = await dialog.showOpenDialog(ownerWindow()!, {
      title: 'Choose product image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (canceled || filePaths.length === 0) {
      return { canceled: true } satisfies ImagePickResult
    }
    const path = filePaths[0]
    const size = statSync(path).size
    if (size > MAX_IMAGE_BYTES) {
      throw new ValidationError('FILE_TOO_LARGE', 'Image is larger than 5 MB.')
    }
    const ext = basename(path).toLowerCase().split('.').pop() ?? ''
    const normalizedExt = ext === 'jpeg' ? 'jpg' : ext
    if (!['png', 'jpg', 'webp'].includes(normalizedExt)) {
      throw new ValidationError('INVALID_PARAMS', 'Unsupported image type.')
    }
    const buf = readFileSync(path)
    const fileName = `${randomUUID()}.${normalizedExt}`
    writeFileSync(join(getImagesDir(), fileName), buf)
    const mime = normalizedExt === 'png' ? 'image/png' : normalizedExt === 'webp' ? 'image/webp' : 'image/jpeg'
    return {
      canceled: false,
      fileName,
      previewDataUrl: `data:${mime};base64,${buf.toString('base64')}`
    } satisfies ImagePickResult
  })
}

function expectNoArgs(channel: string, args: unknown[]): void {
  if (args.length > 0) {
    throw new ValidationError('INVALID_PARAMS', `Invalid call to "${channel}": expected no arguments.`)
  }
}

function cleanupSavedFiles(fileNames: string[]): void {
  for (const name of fileNames) {
    try {
      rmSync(join(getImagesDir(), name), { force: true })
    } catch {
      /* best effort */
    }
  }
}
