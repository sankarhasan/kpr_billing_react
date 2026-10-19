/**
 * Billing (new invoice) draft state — Zustand.
 * Draft lines hold product snapshots + a raw quantity string so invalid
 * input is shown to the user instead of being silently altered.
 * All persistence goes through the secure preload IPC bridge.
 */
import { create } from 'zustand'
import { computeInvoiceTotals } from '@shared/invoices'
import type { Invoice } from '@shared/invoices'
import type { Customer } from '@shared/customers'
import type { DiscountType, Product } from '@shared/products'

export interface DraftLine {
  productId: number
  productCode: string
  productName: string
  /** authoritative unit selling price = product's stored final rate */
  unitPricePaise: number
  originalRatePaise: number
  discountType: DiscountType
  discountPercent: number
  discountAmountPaise: number
  quantityText: string
}

const QTY_INT_RE = /^\d{1,7}$/
const MAX_QTY = 1_000_000

/** Parse a positive WHOLE-number quantity (null when invalid). */
export function parseQuantity(text: string): number | null {
  const t = text.trim()
  if (!QTY_INT_RE.test(t)) return null
  const n = Number(t)
  return n >= 1 && n <= MAX_QTY ? n : null
}

interface BillingState {
  customerMode: 'walkin' | 'existing'
  selectedCustomer: Customer | null
  custName: string
  custPhone: string
  custAddress: string
  lines: DraftLine[]
  notes: string
  saving: boolean
  error: string | null
  statusMessage: string | null
  lineErrors: Record<string, string>
  lastSaved: Invoice | null
  viewing: Invoice | null

  setWalkInMode: () => void
  selectExistingCustomer: (c: Customer) => void
  setCustField: (field: 'custName' | 'custPhone' | 'custAddress', value: string) => void
  addProduct: (p: Product) => void
  setQuantity: (productId: number, text: string) => void
  commitQuantity: (productId: number) => void
  changeQuantity: (productId: number, delta: number) => void
  removeLine: (productId: number) => void
  setNotes: (notes: string) => void
  clearMessages: () => void
  save: () => Promise<boolean>
  resetDraft: () => void
  openInvoiceByNumber: (number: string) => Promise<void>
  closeViewing: () => void
}

export const useBillingStore = create<BillingState>((set, get) => ({
  customerMode: 'walkin',
  selectedCustomer: null,
  custName: '',
  custPhone: '',
  custAddress: '',
  lines: [],
  notes: '',
  saving: false,
  error: null,
  statusMessage: null,
  lineErrors: {},
  lastSaved: null,
  viewing: null,

  setWalkInMode: () =>
    set({ customerMode: 'walkin', selectedCustomer: null, custName: '', custPhone: '', custAddress: '' }),

  selectExistingCustomer: (c) =>
    set({
      customerMode: 'existing',
      selectedCustomer: c,
      custName: c.name,
      custPhone: c.phone,
      custAddress: c.address
    }),

  setCustField: (field, value) => set({ [field]: value } as Partial<BillingState>),

  addProduct: (p) => {
    const { lines } = get()
    const existing = lines.find((l) => l.productId === p.id)
    if (existing) {
      // Duplicate product -> increment quantity (never create accidental dup lines).
      const q = parseQuantity(existing.quantityText) ?? 0
      const next = Math.min(MAX_QTY, q + 1)
      set({
        lines: lines.map((l) => (l.productId === p.id ? { ...l, quantityText: String(next) } : l)),
        statusMessage: `"${p.productName}" already added — quantity is now ${next}.`
      })
      return
    }
    set({
      lines: [
        ...lines,
        {
          productId: p.id,
          productCode: p.productCode,
          productName: p.productName,
          unitPricePaise: p.finalRatePaise,
          originalRatePaise: p.ratePaise,
          discountType: p.discountType,
          discountPercent: p.discountPercent,
          discountAmountPaise: p.discountAmountPaise,
          quantityText: '1'
        }
      ],
      statusMessage: null
    })
  },

  setQuantity: (productId, text) =>
    set({
      lines: get().lines.map((l) => (l.productId === productId ? { ...l, quantityText: text } : l))
    }),

  // On commit (Enter/blur): coerce invalid/zero quantities back to 1.
  commitQuantity: (productId) =>
    set({
      lines: get().lines.map((l) => {
        if (l.productId !== productId) return l
        const q = parseQuantity(l.quantityText)
        return { ...l, quantityText: q === null ? '1' : String(q) }
      })
    }),

  changeQuantity: (productId, delta) =>
    set({
      lines: get().lines.map((l) => {
        if (l.productId !== productId) return l
        const current = parseQuantity(l.quantityText) ?? 1
        const next = Math.min(MAX_QTY, Math.max(1, current + delta))
        return { ...l, quantityText: String(next) }
      })
    }),

  removeLine: (productId) => set({ lines: get().lines.filter((l) => l.productId !== productId) }),

  setNotes: (notes) => set({ notes }),

  clearMessages: () => set({ error: null, statusMessage: null, lineErrors: {} }),

  save: async () => {
    const { lines, customerMode, selectedCustomer, custName, custPhone, custAddress, notes, saving } = get()
    if (saving) return false // duplicate-submission guard

    // Normalise quantities (invalid/zero -> 1) before validating so the user
    // never loses a line and never sends an invalid quantity.
    const normalized = lines.map((l) => ({ ...l, quantity: parseQuantity(l.quantityText) ?? null }))
    const lineErrors: Record<string, string> = {}
    if (lines.length === 0) {
      lineErrors.__lines = 'Add at least one product.'
    }
    if (customerMode === 'existing' && !selectedCustomer) {
      lineErrors.__customer = 'Select a customer or switch to walk-in.'
    }
    normalized.forEach((l, i) => {
      if (l.quantity === null) lineErrors[`lines[${i}]`] = 'Quantity must be a positive whole number.'
    })
    if (Object.keys(lineErrors).length > 0) {
      // repair invalid quantities in-place too
      set({
        lineErrors,
        error: null,
        lines: lines.map((l) => {
          const q = parseQuantity(l.quantityText)
          return q === null ? { ...l, quantityText: '1' } : l
        })
      })
      return false
    }

    set({ saving: true, lineErrors: {}, error: null })
    try {
      const res = await window.kpr.invoices.create({
        customerId: customerMode === 'existing' ? selectedCustomer!.id : null,
        customerName: custName,
        customerPhone: custPhone,
        customerAddress: custAddress,
        lines: normalized.map((l) => ({ productId: l.productId, quantity: l.quantity! })),
        notes
      })
      if (!res.ok) {
        set({ saving: false, error: res.error.message, lineErrors: res.error.fields ?? {} })
        return false // keep the draft intact on failure
      }
      set({
        saving: false,
        lastSaved: res.data,
        statusMessage: `Invoice ${res.data.invoiceNumber} saved successfully.`,
        lines: [],
        notes: '',
        customerMode: 'walkin',
        selectedCustomer: null,
        custName: '',
        custPhone: '',
        custAddress: ''
      })
      return true
    } catch (err) {
      set({ saving: false, error: err instanceof Error ? err.message : 'Saving failed.' })
      return false
    }
  },

  resetDraft: () =>
    set({
      lines: [],
      notes: '',
      customerMode: 'walkin',
      selectedCustomer: null,
      custName: '',
      custPhone: '',
      custAddress: '',
      lineErrors: {},
      error: null,
      statusMessage: null,
      lastSaved: null
    }),

  openInvoiceByNumber: async (number) => {
    const trimmed = number.trim()
    if (!trimmed) {
      set({ lineErrors: { __open: 'Enter an invoice number.' } })
      return
    }
    try {
      const res = await window.kpr.invoices.getByNumber(trimmed)
      if (res.ok) {
        set({ viewing: res.data, lineErrors: {}, error: null })
      } else {
        set({ lineErrors: { __open: res.error.message } })
      }
    } catch (err) {
      set({ lineErrors: { __open: err instanceof Error ? err.message : 'Lookup failed.' } })
    }
  },

  closeViewing: () => set({ viewing: null })
}))

/** Live totals for the draft (renderer preview; main re-computes on save). */
export function draftTotals(lines: DraftLine[]) {
  return computeInvoiceTotals(
    lines.map((l) => ({
      originalRatePaise: l.originalRatePaise,
      unitPricePaise: l.unitPricePaise,
      quantity: parseQuantity(l.quantityText) ?? 0
    })),
    false
  )
}
