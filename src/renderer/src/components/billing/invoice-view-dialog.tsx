import { useEffect, useState } from 'react'
import { Eye, FileDown, Printer } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatPaiseDisplay } from '@shared/products'
import { computeLineAmounts, type Invoice } from '@shared/invoices'
import { describePrintOutcome, type PrintFormat, type PrintWindowMode } from '@shared/print'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice: Invoice | null
}

const money = (p: number) => `₹${formatPaiseDisplay(p)}`

/**
 * Read-only view of a SAVED invoice. Renders ONLY the stored snapshot rows.
 * Subtotal / discount are aggregated from the stored line snapshots so the
 * summary always reconciles with the item table (also for legacy invoices).
 */
export function InvoiceViewDialog({ open, onOpenChange, invoice }: Props) {
  const [printStatus, setPrintStatus] = useState<string | null>(null)

  // Results of main-driven PDF exports / prints are pushed to this window.
  useEffect(() => {
    if (!open) return
    setPrintStatus(null)
    return window.kpr.print.onPdfResult((ev) => setPrintStatus(describePrintOutcome(ev.result)))
  }, [open])

  if (!invoice) return null

  const act = (format: PrintFormat, mode: PrintWindowMode) => {
    if (mode === 'pdf') setPrintStatus('Preparing PDF — choose the destination in the save dialog…')
    void window.kpr.print
      .openInvoice({ invoiceId: invoice.id, format, mode })
      .then((res) => {
        // For preview/print-start failures the immediate answer matters most.
        if (!res.ok) setPrintStatus(res.error.message)
      })
      .catch((err: unknown) => setPrintStatus(err instanceof Error ? err.message : 'Print request failed.'))
  }

  const agg = invoice.lines.reduce(
    (acc, l) => {
      const a = computeLineAmounts({
        originalRatePaise: l.originalRatePaise,
        unitPricePaise: l.unitPricePaise,
        quantity: l.quantity
      })
      acc.subtotal += a.rateAmountPaise
      acc.discount += a.discountAmountPaise
      acc.payable += a.lineTotalPaise
      return acc
    },
    { subtotal: 0, discount: 0, payable: 0 }
  )
  const roundOff = invoice.roundOffPaise ?? 0
  const grandTotal = invoice.totalPaise

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Invoice {invoice.invoiceNumber}
            <Badge variant="secondary" className="gap-1 font-normal">
              <Eye className="size-3" /> Read-only snapshot
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {invoice.invoiceDate} · {invoice.paymentMode}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <div className="font-medium">{invoice.customerName}</div>
          {(invoice.customerPhone || invoice.customerAddress) && (
            <div className="text-xs text-muted-foreground">
              {invoice.customerPhone && <span className="mr-3">{invoice.customerPhone}</span>}
              {invoice.customerAddress}
            </div>
          )}
        </div>

        <div className="max-h-80 overflow-y-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted text-left text-[11px] uppercase text-muted-foreground">
              <tr>
                <th className="w-10 px-2 py-1.5 text-center">S.NO</th>
                <th className="px-2 py-1.5">Product &amp; Code</th>
                <th className="w-20 px-2 py-1.5 text-right">Rate</th>
                <th className="w-20 px-2 py-1.5 text-right">Discount</th>
                <th className="w-12 px-2 py-1.5 text-center">Qty</th>
                <th className="w-24 px-2 py-1.5 text-right">Final Rate</th>
                <th className="w-24 px-2 py-1.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((l, i) => {
                const hasDiscount = l.originalRatePaise > l.unitPricePaise
                const perUnitDiscount = Math.max(0, l.originalRatePaise - l.unitPricePaise)
                return (
                  <tr key={l.id} className="border-t">
                    <td className="px-2 py-1.5 text-center tabular-nums text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-1.5">
                      <span className="font-medium">{l.productName}</span>{' '}
                      <span className="font-mono text-[11px] text-muted-foreground">({l.productCode || '—'})</span>
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${hasDiscount ? 'text-muted-foreground line-through' : ''}`}>
                      {money(l.originalRatePaise)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-emerald-700">
                      {hasDiscount ? money(perUnitDiscount) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-center tabular-nums">{l.quantity}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{money(l.unitPricePaise)}</td>
                    <td className="px-2 py-1.5 text-right font-medium tabular-nums">{money(l.lineTotalPaise)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="ml-auto w-64 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="tabular-nums">{money(agg.subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Discount</span>
            <span className="tabular-nums text-emerald-700">
              {agg.discount > 0 ? `- ${money(agg.discount)}` : money(0)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Round off</span>
            <span className="tabular-nums">{money(roundOff)}</span>
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>GST (disabled)</span>
            <span>₹0.00</span>
          </div>
          <div className="flex justify-between border-t pt-1 text-base font-bold">
            <span>Grand Total</span>
            <span className="tabular-nums">{money(grandTotal)}</span>
          </div>
        </div>

        {invoice.notes && (
          <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{invoice.notes}</p>
        )}

        {/* Phase 6 — print / PDF actions on the SAVED snapshot (read-only). */}
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
          <span className="mr-1 text-xs font-medium text-muted-foreground">Print / PDF:</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => act('a4', 'preview')}>
            <Eye className="size-3.5" /> Preview A4
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => act('receipt', 'preview')}>
            <Eye className="size-3.5" /> Preview 80mm
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => act('a4', 'print')}>
            <Printer className="size-3.5" /> Print A4
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => act('receipt', 'print')}>
            <Printer className="size-3.5" /> Print 80mm
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => act('a4', 'pdf')}>
            <FileDown className="size-3.5" /> Save PDF (A4)
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => act('receipt', 'pdf')}>
            <FileDown className="size-3.5" /> Save PDF (Receipt)
          </Button>
        </div>
        {printStatus && <p className="text-xs text-muted-foreground">{printStatus}</p>}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
