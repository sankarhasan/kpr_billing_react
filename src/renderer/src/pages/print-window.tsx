/**
 * Phase 6 — the invoice print/PDF window (a separate BrowserWindow created
 * ONLY by the main process, loading this same packaged app with a controlled
 * ?print=1&invoiceId=..&format=.. query).
 *
 * It renders the saved invoice snapshot read-only (A4 or 80mm) and offers
 * Print / Save as PDF / Close. Previewing or cancelling never changes the
 * invoice; there is no save/edit path at all in this window.
 */
import { useEffect, useMemo, useState } from 'react'
import { Eye, FileDown, Loader2, Printer, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  A4InvoiceDocument,
  PrintStyles,
  Receipt80Document
} from '@/components/print/invoice-documents'
import {
  buildPrintDocument,
  describePrintOutcome,
  type PrintWindowRequest
} from '@shared/print'
import type { Invoice } from '@shared/invoices'
import type { PrintInfo } from '@shared/print'

export function PrintWindowPage({ request }: { request: PrintWindowRequest }) {
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [printInfo, setPrintInfo] = useState<PrintInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Fetch the SAVED invoice by id (main resolves it from the DB snapshots).
  useEffect(() => {
    let alive = true
    setError(null)
    void Promise.all([window.kpr.invoices.getById(request.invoiceId), window.kpr.settings.getPrintInfo()])
      .then(([invRes, infoRes]) => {
        if (!alive) return
        if (!invRes.ok) {
          setError(invRes.error.message)
          return
        }
        if (!infoRes.ok) {
          setError(infoRes.error.message)
          return
        }
        setInvoice(invRes.data)
        setPrintInfo(infoRes.data)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load the invoice.')
      })
    return () => {
      alive = false
    }
  }, [request.invoiceId])

  // Tell main the document rendered → it runs the armed action (print/pdf).
  useEffect(() => {
    if (!invoice || !printInfo) return
    void window.kpr.print.signalDocumentReady().then((res) => {
      if (res && res.pending !== 'none' && res.result) {
        setStatus(describePrintOutcome(res.result))
      }
    })
  }, [invoice, printInfo])

  const doc = useMemo(() => (invoice && printInfo ? buildPrintDocument(invoice, printInfo) : null), [invoice, printInfo])

  const act = async (fn: () => Promise<Awaited<ReturnType<typeof window.kpr.print.printNow>>>) => {
    if (busy) return // one privileged action at a time
    setBusy(true)
    try {
      setStatus(describePrintOutcome(await fn()))
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The action failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-screen flex-col bg-slate-200">
      <PrintStyles format={request.format} />

      {/* Toolbar — never printed (kpr-no-print) */}
      <div className="kpr-no-print flex shrink-0 items-center gap-2 border-b bg-card px-3 py-2">
        <span className="text-sm font-semibold">
          {request.format === 'receipt' ? '80mm Thermal Receipt' : 'A4 Invoice'}
        </span>
        {invoice && <span className="font-mono text-xs text-muted-foreground">{invoice.invoiceNumber}</span>}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void act(window.kpr.print.savePdfSelf)} disabled={busy || !doc}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <FileDown />} Save as PDF
          </Button>
          <Button size="sm" onClick={() => void act(window.kpr.print.printNow)} disabled={busy || !doc}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Printer />} Print
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void window.kpr.print.closeSelf()} aria-label="Close preview">
            <X /> Close
          </Button>
        </div>
      </div>

      {status && (
        <div className="kpr-no-print shrink-0 border-b bg-emerald-50 px-3 py-1.5 text-xs text-emerald-900">{status}</div>
      )}

      {/* Document */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error && (
          <div className="kpr-no-print mx-auto mt-8 max-w-md rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <Eye className="mr-1 inline size-4" />
            {error}
          </div>
        )}
        {!error && !doc && (
          <div className="kpr-no-print flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading invoice…
          </div>
        )}
        {doc &&
          (request.format === 'receipt' ? <Receipt80Document doc={doc} /> : <A4InvoiceDocument doc={doc} />)}
      </div>
    </div>
  )
}
