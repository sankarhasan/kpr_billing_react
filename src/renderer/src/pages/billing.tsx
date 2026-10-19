import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Eye,
  Minus,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
  X,
  Loader2
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { InvoiceViewDialog } from '@/components/billing/invoice-view-dialog'
import { ClearDraftDialog } from '@/components/billing/clear-draft-dialog'
import { draftTotals, parseQuantity, useBillingStore } from '@/store/billing-store'
import { formatPaiseDisplay } from '@shared/products'
import { computeLineAmounts } from '@shared/invoices'
import type { Customer } from '@shared/customers'
import type { Product } from '@shared/products'

const money = (p: number) => `₹${formatPaiseDisplay(p)}`

export function BillingPage() {
  const {
    customerMode,
    selectedCustomer,
    custName,
    custPhone,
    custAddress,
    lines,
    notes,
    saving,
    error,
    statusMessage,
    lineErrors,
    lastSaved,
    viewing,
    draftNumber,
    openingInvoice,
    setWalkInMode,
    selectExistingCustomer,
    setCustField,
    addProduct,
    setQuantity,
    commitQuantity,
    changeQuantity,
    removeLine,
    setNotes,
    clearMessages,
    save,
    resetDraft,
    openInvoiceByNumber,
    closeViewing,
    reserveDraftNumber
  } = useBillingStore()

  // ── product search + keyboard navigation ──
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Product[]>([])
  const [highlight, setHighlight] = useState(-1)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const optionRefs = useRef<(HTMLLIElement | null)[]>([])
  const qtyRefs = useRef<Record<number, HTMLInputElement | null>>({})
  const [focusTarget, setFocusTarget] = useState<'search' | number | null>(null)

  // ── clear-draft confirmation ──
  const [clearOpen, setClearOpen] = useState(false)

  // ── customer search (existing mode) ──
  const [custQuery, setCustQuery] = useState('')
  const [custResults, setCustResults] = useState<Customer[]>([])
  const [openNumber, setOpenNumber] = useState('')

  const dropdownOpen = query.trim().length > 0 && results.length > 0

  // Autofocus the product search when the page opens (new invoice).
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // The DRAFT number is allocated by the main process (never invented here).
  useEffect(() => {
    void reserveDraftNumber()
  }, [reserveDraftNumber])

  // Keep the keyboard-highlighted result visible: scroll the dropdown only
  // (block: 'nearest' never scrolls the page when the item is already shown).
  useLayoutEffect(() => {
    if (highlight >= 0) {
      optionRefs.current[highlight]?.scrollIntoView({ block: 'nearest' })
    }
  }, [highlight, results])

  // Debounced product search.
  useEffect(() => {
    const term = query.trim()
    if (term.length < 1) {
      setResults([])
      setHighlight(-1)
      return
    }
    const t = setTimeout(() => {
      window.kpr.products
        .list({ search: term, pageSize: 10 })
        .then((r) => {
          setResults(r.items)
          setHighlight(r.items.length > 0 ? 0 : -1)
        })
        .catch(() => setResults([]))
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  // Debounced customer search.
  useEffect(() => {
    const term = custQuery.trim()
    if (term.length < 1) {
      setCustResults([])
      return
    }
    const t = setTimeout(() => {
      window.kpr.customers
        .list({ search: term, pageSize: 8 })
        .then((r) => setCustResults(r.items))
        .catch(() => setCustResults([]))
    }, 200)
    return () => clearTimeout(t)
  }, [custQuery])

  // Focus management: move caret to the requested field after actions.
  useEffect(() => {
    if (focusTarget === null) return
    if (focusTarget === 'search') {
      const el = searchRef.current
      if (el) {
        el.focus()
        el.select()
      }
    } else {
      const el = qtyRefs.current[focusTarget]
      if (el) {
        el.focus()
        el.select()
      }
    }
    setFocusTarget(null)
  }, [focusTarget])

  const totals = useMemo(() => draftTotals(lines), [lines])

  const chooseProduct = (p: Product) => {
    addProduct(p)
    setQuery('')
    setResults([])
    setHighlight(-1)
    setFocusTarget(p.id) // jump to the new/updated row's quantity
  }

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!dropdownOpen) {
      if (e.key === 'Escape') setQuery('')
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlight((h) => Math.min(h + 1, results.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlight((h) => Math.max(h - 1, 0))
        break
      case 'Enter': {
        e.preventDefault()
        const idx = highlight >= 0 ? highlight : 0
        const pick = results[idx]
        if (pick) chooseProduct(pick)
        break
      }
      case 'Escape':
        e.preventDefault()
        setResults([])
        setHighlight(-1)
        break
    }
  }

  const onQtyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, productId: number) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitQuantity(productId)
      setFocusTarget('search') // back to search for the next product
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      changeQuantity(productId, 1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      changeQuantity(productId, -1)
    }
  }

  return (
    <div className="flex h-full flex-col gap-3 p-5">
      {/* Header: customer mode + open saved invoice */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="bill-cust" checked={customerMode === 'walkin'} onChange={setWalkInMode} />
            Walk-in customer
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="bill-cust"
              checked={customerMode === 'existing'}
              onChange={() => useBillingStore.setState({ customerMode: 'existing', selectedCustomer: null })}
            />
            Existing customer
          </label>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Badge variant="outline" className="text-xs font-mono" title="Reserved by the main process for this draft">
            {draftNumber ? `Current Invoice: ${draftNumber}` : 'Reserving invoice number…'}
          </Badge>
          <Input
            value={openNumber}
            onChange={(e) => setOpenNumber(e.target.value)}
            onKeyDown={(e) => {
              // Enter performs the LOOKUP only — it must never save the draft.
              if (e.key === 'Enter') {
                e.preventDefault()
                void openInvoiceByNumber(openNumber)
              }
            }}
            placeholder="Find: 8540 or KPR-INV-8540"
            className="h-8 w-48 font-mono text-xs"
            aria-label="Find saved invoice by number or last 4 digits"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openInvoiceByNumber(openNumber)}
            disabled={!openNumber.trim() || openingInvoice}
          >
            {openingInvoice ? <Loader2 className="size-4 animate-spin" /> : <Eye />} Open
          </Button>
        </div>
      </div>

      {/* Customer details block */}
      <Card>
        <CardContent className="grid grid-cols-1 gap-3 p-4 md:grid-cols-4">
          {customerMode === 'existing' && (
            <div className="relative md:col-span-4">
              {selectedCustomer ? (
                <div className="flex h-8 items-center justify-between rounded-md border bg-background px-3 text-sm">
                  <span className="truncate">
                    Selected: <span className="font-medium">{selectedCustomer.name}</span>
                    {selectedCustomer.phone ? ` — ${selectedCustomer.phone}` : ''}
                  </span>
                  <button type="button" onClick={() => useBillingStore.setState({ selectedCustomer: null })} aria-label="Clear selected customer">
                    <X className="size-4 text-muted-foreground" />
                  </button>
                </div>
              ) : (
                <>
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={custQuery}
                    onChange={(e) => setCustQuery(e.target.value)}
                    placeholder="Search existing customer by name or phone…"
                    className="pl-8"
                    aria-label="Search existing customer"
                  />
                  {custResults.length > 0 && (
                    <ul className="absolute z-40 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
                      {custResults.map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-accent"
                            onClick={() => {
                              selectExistingCustomer(c)
                              setCustQuery('')
                              setCustResults([])
                            }}
                          >
                            <span className="truncate">{c.name}</span>
                            <span className="ml-2 shrink-0 font-mono text-xs text-muted-foreground">{c.phone || '—'}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="cust-name">
              Customer Name {customerMode === 'walkin' && <span className="opacity-60">(optional)</span>}
            </label>
            <Input
              id="cust-name"
              value={custName}
              onChange={(e) => setCustField('custName', e.target.value)}
              placeholder={customerMode === 'walkin' ? 'Walk-in Customer' : 'Selected customer name'}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="cust-phone">
              Phone Number <span className="opacity-60">(optional)</span>
            </label>
            <Input id="cust-phone" value={custPhone} onChange={(e) => setCustField('custPhone', e.target.value)} placeholder="98765 43210" />
          </div>
          <div className="flex flex-col gap-1 md:col-span-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="cust-address">
              Address <span className="opacity-60">(optional)</span>
            </label>
            <Input id="cust-address" value={custAddress} onChange={(e) => setCustField('custAddress', e.target.value)} placeholder="Street, area, city" />
          </div>
          {customerMode === 'existing' && (
            <p className="text-[11px] text-muted-foreground md:col-span-4">
              Editing these details affects only this invoice — the saved customer record is not changed.
            </p>
          )}
          {lineErrors.__customer && <p className="text-xs text-destructive md:col-span-4">{lineErrors.__customer}</p>}
        </CardContent>
      </Card>

      {/* banners */}
      {lineErrors.__open && <p className="rounded-md bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{lineErrors.__open}</p>}
      {error && (
        <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <button type="button" onClick={clearMessages} aria-label="Dismiss error">
            <X className="size-4" />
          </button>
        </div>
      )}
      {statusMessage && (
        <div className="flex items-center justify-between rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <span className="flex items-center gap-2">
            {statusMessage}
            {lastSaved && (
              <button type="button" className="font-medium underline" onClick={() => void openInvoiceByNumber(lastSaved.invoiceNumber)}>
                View invoice
              </button>
            )}
          </span>
          <button type="button" onClick={clearMessages} aria-label="Dismiss message">
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_300px] gap-4">
        {/* Left: product search + items table */}
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShoppingCart className="size-4" /> Items
            </CardTitle>
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value.replace(/[%_]/g, ''))}
                onKeyDown={onSearchKeyDown}
                placeholder="Type product code or name — ↑/↓ to navigate, Enter to add, Esc to close"
                className="pl-8"
                aria-label="Search products to add"
                role="combobox"
                aria-expanded={dropdownOpen}
                aria-controls="product-results"
                aria-activedescendant={dropdownOpen && highlight >= 0 ? `product-opt-${highlight}` : undefined}
              />
              {dropdownOpen && (
                <ul
                  id="product-results"
                  role="listbox"
                  className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover shadow-md"
                >
                  {results.map((p, i) => (
                    <li key={p.id} ref={(el) => { optionRefs.current[i] = el }}>
                      <button
                        type="button"
                        id={`product-opt-${i}`}
                        role="option"
                        aria-selected={i === highlight}
                        onMouseEnter={() => setHighlight(i)}
                        onClick={() => chooseProduct(p)}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm ${i === highlight ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
                      >
                        <span className="truncate">
                          <span className={`mr-2 font-mono text-xs ${i === highlight ? 'opacity-80' : 'text-muted-foreground'}`}>{p.productCode}</span>
                          {p.productName}
                        </span>
                        <span className="shrink-0 font-medium tabular-nums">{money(p.finalRatePaise)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col p-0">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted text-left text-[11px] uppercase text-muted-foreground">
                  <tr>
                    <th className="w-10 px-2 py-1.5 text-center">S.NO</th>
                    <th className="px-2 py-1.5">PRODUCT NAME &amp; CODE</th>
                    <th className="w-24 px-2 py-1.5 text-right">RATE</th>
                    <th className="w-20 px-2 py-1.5 text-right">DISCOUNT</th>
                    <th className="w-32 px-2 py-1.5 text-center">QTY</th>
                    <th className="w-24 px-2 py-1.5 text-right">FINAL RATE</th>
                    <th className="w-28 px-2 py-1.5 text-right">AMOUNT</th>
                    <th className="w-10 px-2 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={8} className="h-28 px-3 text-center text-sm text-muted-foreground">
                        No items yet — type above and press Enter to add products.
                      </td>
                    </tr>
                  )}
                  {lines.map((l, i) => {
                    const qty = parseQuantity(l.quantityText) ?? 0
                    const amt = computeLineAmounts({
                      originalRatePaise: l.originalRatePaise,
                      unitPricePaise: l.unitPricePaise,
                      quantity: qty
                    })
                    const hasDiscount = l.originalRatePaise > l.unitPricePaise
                    const lineErr = lineErrors[`lines[${i}]`]
                    return (
                      <tr key={l.productId} className="border-t align-middle">
                        <td className="px-2 py-1.5 text-center tabular-nums text-muted-foreground">{i + 1}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-baseline gap-2">
                            <span className="truncate font-medium">{l.productName}</span>
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">({l.productCode})</span>
                          </div>
                          {lineErr && <p className="text-[11px] text-destructive">{lineErr}</p>}
                        </td>
                        <td className={`px-2 py-1.5 text-right tabular-nums ${hasDiscount ? 'text-muted-foreground line-through' : ''}`}>
                          {money(l.originalRatePaise)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-emerald-700">
                          {hasDiscount ? `₹${formatPaiseDisplay(Math.max(0, l.originalRatePaise - l.unitPricePaise))}` : '—'}
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center justify-center gap-1">
                            <Button variant="outline" size="icon" className="size-6" onClick={() => changeQuantity(l.productId, -1)} aria-label={`Decrease ${l.productName}`}>
                              <Minus className="size-3" />
                            </Button>
                            <Input
                              ref={(el) => {
                                qtyRefs.current[l.productId] = el
                              }}
                              value={l.quantityText}
                              onChange={(e) => setQuantity(l.productId, e.target.value.replace(/[^\d]/g, ''))}
                              onKeyDown={(e) => onQtyKeyDown(e, l.productId)}
                              onBlur={() => commitQuantity(l.productId)}
                              inputMode="numeric"
                              aria-label={`Quantity for ${l.productName}`}
                              className="h-7 w-14 text-center tabular-nums"
                            />
                            <Button variant="outline" size="icon" className="size-6" onClick={() => changeQuantity(l.productId, 1)} aria-label={`Increase ${l.productName}`}>
                              <Plus className="size-3" />
                            </Button>
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-medium">{money(l.unitPricePaise)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{money(amt.lineTotalPaise)}</td>
                        <td className="px-2 py-1.5 text-right">
                          <Button variant="ghost" size="icon" className="size-7 text-destructive" onClick={() => removeLine(l.productId)} aria-label={`Remove ${l.productName}`}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {lineErrors.__lines && <p className="border-t bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{lineErrors.__lines}</p>}
          </CardContent>
        </Card>

        {/* Right: summary + actions */}
        <Card className="flex min-h-0 flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Summary</CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="tabular-nums">{money(totals.subtotalPaise)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Discount</span>
                <span className="tabular-nums text-emerald-700">
                  {totals.discountPaise > 0 ? `- ${money(totals.discountPaise)}` : money(0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Round off</span>
                <span className="tabular-nums">{money(totals.roundOffPaise)}</span>
              </div>
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>GST (disabled)</span>
                <span>₹0.00</span>
              </div>
              <div className="flex justify-between border-t pt-1.5 text-base font-bold">
                <span>Grand Total</span>
                <span className="tabular-nums">{money(totals.totalPaise)}</span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="bill-notes">
                Notes
              </label>
              <textarea
                id="bill-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional note for this invoice"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            </div>

            <div className="mt-auto flex flex-col gap-2">
              <Button onClick={() => void save()} disabled={saving || lines.length === 0}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus />}
                {saving ? 'Saving…' : 'Save Invoice'}
              </Button>
              <Button variant="ghost" onClick={() => setClearOpen(true)} disabled={saving}>
                Clear draft
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <InvoiceViewDialog open={viewing !== null} onOpenChange={(o) => !o && closeViewing()} invoice={viewing} />

      <ClearDraftDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        onConfirm={() => {
          // Explicit confirmation only: reset the draft + all transient
          // selection/search state. Database, saved invoices and settings are
          // untouched, and the reserved draft number stays consistent.
          resetDraft()
          setQuery('')
          setResults([])
          setHighlight(-1)
          setCustQuery('')
          setCustResults([])
          setFocusTarget('search')
        }}
      />
    </div>
  )
}
