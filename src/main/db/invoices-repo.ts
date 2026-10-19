/**
 * Invoice data-access layer. Pure module (no Electron imports) so it runs
 * in the main process AND in plain Node automated tests.
 *
 * Rules enforced HERE (never trusted from the renderer):
 *  - unit price = product's stored final_rate_paise at save time
 *  - subtotal / discount / round-off / total recalculated with integer paise
 *    via the shared computeInvoiceTotals engine
 *  - invoice number = KPR-INV- + a cryptographically-random unused 4-digit
 *    suffix, allocated inside the same transaction (UNIQUE is the guard)
 *  - customer + product snapshots copied into the invoice rows
 */
import type Database from 'better-sqlite3'
import { randomInt } from 'node:crypto'
import {
  validateInvoiceInput,
  computeInvoiceTotals,
  WALK_IN_NAME,
  type Invoice,
  type InvoiceLine
} from '../../shared/invoices.ts'
import { ipcErr, ipcOk, type IpcResult, type DiscountType } from '../../shared/products.ts'

type Db = Database.Database

/** Fixed human-facing prefix for NEW invoices (legacy numbers are preserved). */
export const INVOICE_NUMBER_PREFIX = 'KPR-INV-'
const NUMBER_MIN = 1000
const NUMBER_SPAN = 9000 // 1000..9999

class InvoiceNumberExhausted extends Error {}

interface InvoiceRow {
  id: number
  invoice_number: string
  customer_id: number | null
  customer_name: string
  customer_phone: string
  customer_address: string
  invoice_date: string
  subtotal_paise: number
  discount_paise: number
  round_off_paise: number
  tax_amount_paise: number
  total_paise: number
  payment_mode: string
  status: string
  notes: string
  created_at: string
}

interface ItemRow {
  id: number
  invoice_id: number
  product_id: number | null
  product_code: string
  product_name: string
  quantity: number
  unit_price_paise: number
  line_total_paise: number
  original_rate_paise: number
  discount_type: string
  discount_percent: number
  discount_amount_paise: number
}

interface ProductSnapRow {
  id: number
  product_code: string
  product_name: string
  rate_paise: number
  final_rate_paise: number
  discount_type: string
  discount_percent: number
  discount_amount_paise: number
  is_active: number
}

function asDiscountType(v: string): DiscountType {
  return v === 'percent' || v === 'amount' ? v : 'none'
}

function getSettingValue(db: Db, key: string): string | undefined {
  const row = db
    .prepare<[{ key: string }], { value: string }>('SELECT value FROM settings WHERE key = @key')
    .get({ key })
  return row?.value
}

function mapInvoice(row: InvoiceRow, lines: InvoiceLine[]): Invoice {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerAddress: row.customer_address,
    invoiceDate: row.invoice_date,
    subtotalPaise: row.subtotal_paise,
    discountPaise: row.discount_paise,
    roundOffPaise: row.round_off_paise ?? 0,
    taxAmountPaise: row.tax_amount_paise,
    totalPaise: row.total_paise,
    paymentMode: row.payment_mode,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    lines
  }
}

function mapLine(r: ItemRow): InvoiceLine {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    productId: r.product_id,
    productCode: r.product_code,
    productName: r.product_name,
    quantity: r.quantity,
    unitPricePaise: r.unit_price_paise,
    lineTotalPaise: r.line_total_paise,
    originalRatePaise: r.original_rate_paise,
    discountType: asDiscountType(r.discount_type),
    discountPercent: r.discount_percent,
    discountAmountPaise: r.discount_amount_paise
  }
}

const INVOICE_COLS = `id, invoice_number, customer_id, customer_name, customer_phone, customer_address,
  invoice_date, subtotal_paise, discount_paise, round_off_paise, tax_amount_paise, total_paise,
  payment_mode, status, notes, created_at`

const LINE_COLS = `id, invoice_id, product_id, product_code, product_name, quantity,
  unit_price_paise, line_total_paise, original_rate_paise, discount_type, discount_percent, discount_amount_paise`

function linesFor(db: Db, invoiceId: number): InvoiceLine[] {
  return (
    db
      .prepare<[{ iid: number }], ItemRow>(
        `SELECT ${LINE_COLS} FROM invoice_items WHERE invoice_id = @iid ORDER BY id`
      )
      .all({ iid: invoiceId }) ?? []
  ).map(mapLine)
}

// ─── Reads (from stored snapshots only) ────────────────────────────────

export function getInvoice(db: Db, id: number): Invoice | null {
  const row = db
    .prepare<[{ id: number }], InvoiceRow>(`SELECT ${INVOICE_COLS} FROM invoices WHERE id = @id`)
    .get({ id })
  return row ? mapInvoice(row, linesFor(db, row.id)) : null
}

export function getInvoiceByNumber(db: Db, invoiceNumber: string): Invoice | null {
  const row = db
    .prepare<[{ n: string }], InvoiceRow>(`SELECT ${INVOICE_COLS} FROM invoices WHERE invoice_number = @n`)
    .get({ n: invoiceNumber })
  return row ? mapInvoice(row, linesFor(db, row.id)) : null
}

/** Allocate an unused KPR-INV-XXXX number (cryptographic randomness). */
function generateInvoiceNumber(db: Db): string {
  const exists = db.prepare<[string], { x: number }>('SELECT 1 AS x FROM invoices WHERE invoice_number = ?')
  for (let attempt = 0; attempt < NUMBER_SPAN; attempt++) {
    const candidate = `${INVOICE_NUMBER_PREFIX}${NUMBER_MIN + randomInt(0, NUMBER_SPAN)}`
    if (!exists.get(candidate)) return candidate
  }
  throw new InvoiceNumberExhausted()
}

// ─── Create ────────────────────────────────────────────────────────────

export function createInvoice(db: Db, rawInput: unknown): IpcResult<Invoice> {
  const { errors, value } = validateInvoiceInput(rawInput)
  if (Object.keys(errors).length > 0) {
    return ipcErr<Invoice>('VALIDATION', 'Please correct the highlighted fields.', errors)
  }

  // Resolve + validate product lines against CURRENT data; snapshot prices.
  const selectProduct = db.prepare<
    [number],
    ProductSnapRow
  >(`SELECT id, product_code, product_name, rate_paise, final_rate_paise, discount_type,
            discount_percent, discount_amount_paise, is_active
     FROM products WHERE id = ?`)

  const lineErrors: Record<string, string> = { ...errors }
  const resolved: { product: ProductSnapRow; quantity: number }[] = []
  value.lines.forEach((l, i) => {
    const product = selectProduct.get(l.productId)
    if (!product) {
      lineErrors[`lines[${i}]`] = `Line ${i + 1}: product no longer exists.`
      return
    }
    if (product.is_active !== 1) {
      lineErrors[`lines[${i}]`] = `Line ${i + 1}: "${product.product_name}" is archived and cannot be billed.`
      return
    }
    resolved.push({ product, quantity: l.quantity })
  })
  if (Object.keys(lineErrors).length > 0) {
    return ipcErr<Invoice>('VALIDATION', 'Please correct the highlighted fields.', lineErrors)
  }

  // Resolve the customer snapshot.
  //  - existing customer: use the (reviewable) submitted details, falling back
  //    to the master record for any blank field. The master is NEVER modified.
  //  - walk-in: use whatever optional details were typed; blank name -> Walk-in.
  let customer: { id: number | null; name: string; phone: string; address: string }
  if (value.customerId !== null) {
    const c = db
      .prepare<[{ id: number }], { id: number; name: string; phone: string; address: string; archived_at: string | null }>(
        'SELECT id, name, phone, address, archived_at FROM customers WHERE id = @id'
      )
      .get({ id: value.customerId })
    if (!c) {
      return ipcErr<Invoice>('VALIDATION', 'Please correct the highlighted fields.', {
        customerId: 'Customer no longer exists.'
      })
    }
    if (c.archived_at) {
      return ipcErr<Invoice>('VALIDATION', 'Please correct the highlighted fields.', {
        customerId: 'This customer is archived.'
      })
    }
    customer = {
      id: c.id,
      name: value.customerName || c.name,
      phone: value.customerPhone || c.phone,
      address: value.customerAddress || c.address
    }
  } else {
    customer = {
      id: null,
      name: value.customerName || WALK_IN_NAME,
      phone: value.customerPhone,
      address: value.customerAddress
    }
  }

  // Recalculate ALL money with integer paise — renderer values ignored.
  const roundOffEnabled = getSettingValue(db, 'round_off_enabled') === '1'
  const totals = computeInvoiceTotals(
    resolved.map(({ product, quantity }) => ({
      originalRatePaise: product.rate_paise,
      unitPricePaise: product.final_rate_paise,
      quantity
    })),
    roundOffEnabled
  )

  const insertInvoice = db.prepare(`
    INSERT INTO invoices (
      invoice_number, customer_id, customer_name, customer_phone, customer_address,
      subtotal_paise, discount_paise, round_off_paise, tax_amount_paise, total_paise, notes
    ) VALUES (
      @number, @customerId, @customerName, @customerPhone, @customerAddress,
      @subtotal, @discount, @roundOff, @tax, @total, @notes
    )
  `)
  const insertItem = db.prepare(`
    INSERT INTO invoice_items (
      invoice_id, product_id, product_code, product_name, quantity,
      unit_price_paise, line_total_paise, original_rate_paise,
      discount_type, discount_percent, discount_amount_paise
    ) VALUES (
      @invoiceId, @productId, @productCode, @productName, @quantity,
      @unitPricePaise, @lineTotalPaise, @originalRatePaise,
      @discountType, @discountPercent, @discountAmountPaise
    )
  `)

  const tx = db.transaction((): number => {
    const invoiceNumber = generateInvoiceNumber(db)
    const info = insertInvoice.run({
      number: invoiceNumber,
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      customerAddress: customer.address,
      subtotal: totals.subtotalPaise,
      discount: totals.discountPaise,
      roundOff: totals.roundOffPaise,
      tax: totals.taxAmountPaise,
      total: totals.totalPaise,
      notes: value.notes
    })
    const invoiceId = Number(info.lastInsertRowid)

    for (const { product, quantity } of resolved) {
      insertItem.run({
        invoiceId,
        productId: product.id,
        productCode: product.product_code,
        productName: product.product_name,
        quantity,
        unitPricePaise: product.final_rate_paise,
        lineTotalPaise: product.final_rate_paise * quantity,
        originalRatePaise: product.rate_paise,
        discountType: asDiscountType(product.discount_type),
        discountPercent: product.discount_percent,
        discountAmountPaise: product.discount_amount_paise
      })
    }
    return invoiceId
  })

  let invoiceId: number
  try {
    invoiceId = tx()
  } catch (err) {
    if (err instanceof InvoiceNumberExhausted) {
      return ipcErr<Invoice>('DB_ERROR', 'Invoice number space is exhausted (all KPR-INV-#### used).')
    }
    const code = (err as { code?: string }).code ?? ''
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
      return ipcErr<Invoice>('DB_ERROR', 'Invoice number conflict — the invoice was NOT saved. Please try again.')
    }
    throw err
  }

  const created = getInvoice(db, invoiceId)
  if (!created) return ipcErr<Invoice>('DB_ERROR', 'Invoice saved but could not be re-read.')
  return ipcOk(created)
}
