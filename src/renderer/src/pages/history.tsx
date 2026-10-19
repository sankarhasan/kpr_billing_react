import { useEffect, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  Search,
  X
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { InvoiceViewDialog } from '@/components/billing/invoice-view-dialog'
import { HISTORY_PAGE_SIZE_OPTIONS, useHistoryStore } from '@/store/history-store'
import { formatInvoiceDate } from '@shared/invoices'
import { formatPaiseDisplay } from '@shared/products'
import type { Invoice } from '@shared/invoices'

/** Search debounce (ms) — same convention as the Products page. */
const SEARCH_DEBOUNCE = 350

const money = (p: number) => `₹${formatPaiseDisplay(p)}`

export function HistoryPage() {
  const {
    items,
    totalMatches,
    page,
    pageSize,
    summary,
    startDate,
    endDate,
    loading,
    error,
    setFilters,
    clearDateFilters,
    clearAllFilters,
    setPage,
    load,
    clearError
  } = useHistoryStore()

  const [invoiceInput, setInvoiceInput] = useState('')
  const [customerInput, setCustomerInput] = useState('')

  // ── read-only invoice viewer (reuses the Billing page's snapshot dialog) ──
  const [viewing, setViewing] = useState<Invoice | null>(null)
  const [viewLoadingId, setViewLoadingId] = useState<number | null>(null)
  const [viewError, setViewError] = useState<string | null>(null)

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced filter text — each filter is independent and never resets another.
  useEffect(() => {
    const t = setTimeout(() => setFilters({ invoiceNumber: invoiceInput }), SEARCH_DEBOUNCE)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceInput])

  useEffect(() => {
    const t = setTimeout(() => setFilters({ customer: customerInput }), SEARCH_DEBOUNCE)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerInput])

  const openInvoice = async (id: number) => {
    setViewLoadingId(id)
    setViewError(null)
    try {
      const res = await window.kpr.invoices.getById(id)
      if (res.ok) setViewing(res.data)
      else setViewError(res.error.message)
    } catch (err) {
      setViewError(err instanceof Error ? err.message : 'Could not open the invoice.')
    } finally {
      setViewLoadingId(null)
    }
  }

  const from = totalMatches === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(totalMatches, page * pageSize)
  const lastPage = Math.max(1, Math.ceil(totalMatches / pageSize))
  const hasFilters =
    invoiceInput.trim() !== '' || customerInput.trim() !== '' || startDate !== '' || endDate !== ''

  return (
    <div className="flex h-full flex-col gap-3 p-5">
      {/* Filter toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={invoiceInput}
            onChange={(e) => setInvoiceInput(e.target.value)}
            placeholder="Invoice no: KPR-INV-8540 or 8540"
            className="w-56 pl-8 font-mono text-xs"
            aria-label="Search by invoice number"
          />
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={customerInput}
            onChange={(e) => setCustomerInput(e.target.value)}
            placeholder="Customer name or phone"
            className="w-52 pl-8"
            aria-label="Search by customer name or phone"
          />
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          From
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setFilters({ startDate: e.target.value })}
            className="h-8 w-36 text-xs"
            aria-label="Start date"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          To
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setFilters({ endDate: e.target.value })}
            className="h-8 w-36 text-xs"
            aria-label="End date"
          />
        </label>

        {(startDate || endDate) && (
          <Button variant="ghost" size="sm" onClick={clearDateFilters}>
            <X className="size-3.5" /> Clear dates
          </Button>
        )}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setInvoiceInput('')
              setCustomerInput('')
              clearAllFilters()
            }}
          >
            <X className="size-3.5" /> Clear all filters
          </Button>
        )}
      </div>

      {/* Sales summary — computed in the MAIN process over ALL filtered rows */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardContent className="p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Invoices</div>
            <div className="text-lg font-bold tabular-nums">{summary.invoiceCount.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Sales</div>
            <div className="text-lg font-bold tabular-nums">{money(summary.totalSalesPaise)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Items Sold</div>
            <div className="text-lg font-bold tabular-nums">{summary.totalItemsSold.toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <button type="button" onClick={clearError} aria-label="Dismiss error">
            <X className="size-4" />
          </button>
        </div>
      )}
      {viewError && (
        <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{viewError}</span>
          <button type="button" onClick={() => setViewError(null)} aria-label="Dismiss view error">
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* Invoice table */}
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10">
                <TableRow>
                  <TableHead className="w-12 text-center">S.No</TableHead>
                  <TableHead className="w-36">Invoice No.</TableHead>
                  <TableHead className="w-40">Date &amp; Time</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="w-32">Phone</TableHead>
                  <TableHead className="w-16 text-right">Items</TableHead>
                  <TableHead className="w-28 text-right">Subtotal</TableHead>
                  <TableHead className="w-24 text-right">Discount</TableHead>
                  <TableHead className="w-20 text-right">Round Off</TableHead>
                  <TableHead className="w-28 text-right">Grand Total</TableHead>
                  <TableHead className="w-20 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} className="h-32 text-center text-muted-foreground">
                      <Loader2 className="mr-2 inline size-4 animate-spin" />
                      Loading invoices…
                    </TableCell>
                  </TableRow>
                )}

                {!loading && items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} className="h-32 text-center text-muted-foreground">
                      {totalMatches === 0 && !hasFilters
                        ? 'No invoices yet — saved invoices will appear here.'
                        : 'No invoices match the current search / filters.'}
                    </TableCell>
                  </TableRow>
                )}

                {items.map((inv, i) => (
                  <TableRow key={inv.id}>
                    <TableCell className="text-center tabular-nums text-muted-foreground">
                      {(page - 1) * pageSize + i + 1}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{inv.invoiceNumber}</TableCell>
                    <TableCell className="text-xs">{formatInvoiceDate(inv.invoiceDate)}</TableCell>
                    <TableCell className="max-w-56 truncate">{inv.customerName}</TableCell>
                    <TableCell className="text-xs">{inv.customerPhone || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{inv.itemCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(inv.subtotalPaise)}</TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-700">
                      {inv.discountPaise > 0 ? `- ${money(inv.discountPaise)}` : money(0)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(inv.roundOffPaise)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{money(inv.totalPaise)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => void openInvoice(inv.id)}
                        disabled={viewLoadingId === inv.id}
                        aria-label={`View invoice ${inv.invoiceNumber}`}
                      >
                        {viewLoadingId === inv.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Eye className="size-3.5" />
                        )}{' '}
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t bg-card px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>
                Showing {from.toLocaleString()}–{to.toLocaleString()} of {totalMatches.toLocaleString()} matching
                invoices
              </span>
              <select
                value={pageSize}
                onChange={(e) => setFilters({ pageSize: Number(e.target.value) })}
                className="h-7 rounded-md border border-input bg-background px-1.5"
                aria-label="Rows per page"
              >
                {HISTORY_PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
                <ChevronLeft className="size-3.5" /> Prev
              </Button>
              <span className="px-2 tabular-nums">
                {page} / {lastPage}
              </span>
              <Button variant="outline" size="sm" disabled={page >= lastPage || loading} onClick={() => setPage(page + 1)}>
                Next <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Read-only snapshot dialog — the SAME viewer the Billing page uses.
          Opening it never mutates the invoice or the unsaved billing draft. */}
      <InvoiceViewDialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)} invoice={viewing} />
    </div>
  )
}
