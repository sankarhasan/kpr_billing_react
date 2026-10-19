/**
 * Shared invoice domain logic — pure, dependency-free TypeScript.
 *
 * Historical integrity rules:
 *  - An invoice stores SNAPSHOT copies of customer and product data.
 *  - Line unit price comes from the product's stored final_rate_paise
 *    at save time; it is NEVER recomputed from rate/discount later.
 *  - All money is INTEGER paise; totals are recalculated in the main
 *    process — renderer-supplied totals are never trusted.
 *  - Quantity is a positive WHOLE NUMBER (no decimals) for billing.
 *
 * Totals model (integer paise, no floating-point money):
 *  - subtotal  = SUM(original_rate_paise x qty)
 *  - discount  = SUM((original_rate_paise - final_rate_paise) x qty)   [>= 0]
 *  - payable   = SUM(final_rate_paise x qty)  == subtotal - discount
 *  - round-off = round(payable to nearest rupee) - payable   [only if enabled]
 *  - total     = payable + round-off
 *  - GST stays 0 (disabled by default; never added automatically)
 */
import type { DiscountType } from './products.ts'

export const WALK_IN_NAME = 'Walk-in Customer'

/** line total = unit price (paise) x integer quantity (exact, no rounding needed) */
export function lineTotalPaise(unitPricePaise: number, quantity: number): number {
  return Math.round(unitPricePaise * quantity)
}

// ─── Totals engine (single source of truth for main + renderer) ────────

export interface LineAmountInput {
  originalRatePaise: number
  /** authoritative unit selling price = stored final_rate_paise */
  unitPricePaise: number
  quantity: number
}

export interface LineAmounts {
  rateAmountPaise: number
  lineTotalPaise: number
  discountAmountPaise: number
}

/** Per-line monetary breakdown in integer paise. */
export function computeLineAmounts(l: LineAmountInput): LineAmounts {
  const qty = l.quantity
  const rateAmountPaise = l.originalRatePaise * qty
  const lineTotal = l.unitPricePaise * qty
  const perUnitDiscount = Math.max(0, l.originalRatePaise - l.unitPricePaise)
  return {
    rateAmountPaise,
    lineTotalPaise: lineTotal,
    discountAmountPaise: perUnitDiscount * qty
  }
}

export interface InvoiceTotals {
  subtotalPaise: number
  discountPaise: number
  roundOffPaise: number
  taxAmountPaise: number
  totalPaise: number
}

/**
 * Compute invoice totals from line inputs using integer paise arithmetic.
 * round-off rounds the payable amount to the nearest rupee (100 paise) only
 * when enabled; otherwise it is exactly 0.
 */
export function computeInvoiceTotals(lines: LineAmountInput[], roundOffEnabled = false): InvoiceTotals {
  let subtotal = 0
  let payable = 0
  for (const l of lines) {
    const a = computeLineAmounts(l)
    subtotal += a.rateAmountPaise
    payable += a.lineTotalPaise
  }
  const discount = subtotal - payable
  let roundOff = 0
  if (roundOffEnabled) {
    const rounded = Math.round(payable / 100) * 100
    roundOff = rounded - payable
  }
  return {
    subtotalPaise: subtotal,
    discountPaise: discount,
    roundOffPaise: roundOff,
    taxAmountPaise: 0,
    totalPaise: payable + roundOff
  }
}

// ─── Stored shapes (as returned by the main process) ───────────────────

export interface InvoiceLine {
  id: number
  invoiceId: number
  productId: number | null
  productCode: string
  productName: string
  quantity: number
  unitPricePaise: number
  lineTotalPaise: number
  originalRatePaise: number
  discountType: DiscountType
  discountPercent: number
  discountAmountPaise: number
}

export interface Invoice {
  id: number
  invoiceNumber: string
  customerId: number | null
  customerName: string
  customerPhone: string
  customerAddress: string
  invoiceDate: string
  subtotalPaise: number
  discountPaise: number
  roundOffPaise: number
  taxAmountPaise: number
  totalPaise: number
  paymentMode: string
  status: string
  notes: string
  createdAt: string
  lines: InvoiceLine[]
}

// ─── Submitted shape ───────────────────────────────────────────────────

export interface InvoiceLineInput {
  productId: number
  quantity: number
}

export interface InvoiceCreateInput {
  /** null => walk-in customer */
  customerId: number | null
  /** Snapshot customer details (optional for walk-in; pre-filled for existing). */
  customerName?: string
  customerPhone?: string
  customerAddress?: string
  lines: InvoiceLineInput[]
  notes?: string
  /**
   * Draft number previously reserved BY THE MAIN PROCESS and shown to the
   * user. Never trusted: it is only honoured if the main process still holds
   * a live reservation for exactly this number.
   */
  draftNumber?: string
}

// ─── Invoice lookup (reopen by full number OR last-4-digit suffix) ─────

export const INVOICE_SUFFIX_RE = /^\d{4}$/
export const INVOICE_LOOKUP_FULL_RE = /^[A-Za-z][A-Za-z0-9 _/.-]{0,59}$/

export type InvoiceLookup =
  | { ok: true; mode: 'suffix'; digits: string }
  | { ok: true; mode: 'full'; value: string }
  | { ok: false; message: string }

/**
 * Parse an untrusted invoice-lookup string from the UI.
 * Accepts: exactly 4 digits (suffix search) or a full invoice number
 * (letter-led, case-insensitive, legacy numbers allowed). Whitespace around
 * the input is ignored; everything else is rejected with a clear message.
 */
export function parseInvoiceLookup(raw: unknown): InvoiceLookup {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) {
    return { ok: false, message: 'Enter an invoice number or its last 4 digits.' }
  }
  if (INVOICE_SUFFIX_RE.test(trimmed)) {
    return { ok: true, mode: 'suffix', digits: trimmed }
  }
  if (/^\d+$/.test(trimmed)) {
    return { ok: false, message: 'Suffix search needs exactly 4 digits — enter the last 4 digits or the full invoice number.' }
  }
  if (INVOICE_LOOKUP_FULL_RE.test(trimmed)) {
    return { ok: true, mode: 'full', value: trimmed }
  }
  return { ok: false, message: 'Invalid invoice number. Enter the full number (e.g. KPR-INV-8540) or its last 4 digits.' }
}

const MAX_LINES = 200
const MAX_QTY = 1_000_000
const QTY_RE = /^\d{1,7}$/ // positive whole number only

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

const PHONE_RE = /^[0-9+\-()\s]{0,25}$/

/**
 * Validate an untrusted invoice submission from the renderer.
 * Quantity must be a positive whole number. Product existence/active state
 * is verified separately in the repository (needs DB access).
 */
export function validateInvoiceInput(raw: unknown): {
  errors: Record<string, string>
  value: {
    customerId: number | null
    customerName: string
    customerPhone: string
    customerAddress: string
    lines: InvoiceLineInput[]
    notes: string
  }
} {
  const errors: Record<string, string> = {}
  const o = (raw ?? {}) as Record<string, unknown>

  const customerId = o.customerId === null || o.customerId === undefined ? null : o.customerId
  if (customerId !== null && !isPosInt(customerId)) {
    errors.customerId = 'Invalid customer selection.'
  }

  const customerName = typeof o.customerName === 'string' ? o.customerName.trim() : ''
  const customerPhone = typeof o.customerPhone === 'string' ? o.customerPhone.trim() : ''
  const customerAddress = typeof o.customerAddress === 'string' ? o.customerAddress.trim() : ''
  if (customerName.length > 200) errors.customerName = 'Customer name is too long (max 200).'
  if (customerPhone !== '' && !PHONE_RE.test(customerPhone)) {
    errors.customerPhone = 'Phone may contain digits and + - ( ) spaces only (max 25).'
  }
  if (customerAddress.length > 500) errors.customerAddress = 'Address is too long (max 500).'

  if (!Array.isArray(o.lines) || o.lines.length === 0) {
    errors.lines = 'Add at least one product to the invoice.'
  } else if (o.lines.length > MAX_LINES) {
    errors.lines = `An invoice can have at most ${MAX_LINES} lines.`
  }

  const lines: InvoiceLineInput[] = []
  if (Array.isArray(o.lines)) {
    o.lines.forEach((rawLine, i) => {
      const l = (rawLine ?? {}) as Record<string, unknown>
      if (!isPosInt(l.productId)) {
        errors[`lines[${i}]`] = 'Line is missing a valid product.'
        return
      }
      const qty = typeof l.quantity === 'number' ? l.quantity : Number(String(l.quantity ?? '').trim())
      if (!Number.isInteger(qty) || !QTY_RE.test(String(qty)) || qty <= 0) {
        errors[`lines[${i}]`] = `Line ${i + 1}: quantity must be a positive whole number.`
        return
      }
      if (qty > MAX_QTY) {
        errors[`lines[${i}]`] = `Line ${i + 1}: quantity is too large.`
        return
      }
      lines.push({ productId: l.productId, quantity: qty })
    })
    if (lines.length === 0 && !errors.lines) {
      errors.lines = 'Add at least one valid product line.'
    }
  }

  const notes = typeof o.notes === 'string' ? o.notes.trim() : ''
  if (notes.length > 1000) {
    errors.notes = 'Notes must be at most 1000 characters.'
  }

  return {
    errors,
    value: {
      customerId: customerId as number | null,
      customerName,
      customerPhone,
      customerAddress,
      lines,
      notes
    }
  }
}
