/**
 * Invoice data-access layer. Pure module (no Electron imports) so it runs
 * in the main process AND in plain Node automated tests.
 *
 * Rules enforced HERE (never trusted from the renderer):
 *  - unit price = product's stored final_rate_paise at save time
 *  - subtotal / discount / round-off / total recalculated with integer paise
 *    via the shared computeInvoiceTotals engine
 *  - invoice number = KPR-INV- + a cryptographically-random unused 4-digit
 *    suffix, allocated inside the same transaction (UNIQUE is the guard);
 *    draft numbers shown in the UI are RESERVED in this process first and
 *    only honoured on save when the reservation is still live
 *  - reopen lookup (full number or last-4-digit suffix) runs here with
 *    parameterized SQL and returns one / none / many (ambiguity) results
 *  - customer + product snapshots copied into the invoice rows
 */
import type Database from 'better-sqlite3'
import { randomInt } from 'node:crypto'
import {
  validateInvoiceInput,
  computeInvoiceTotals,
  parseInvoiceLookup,
  isValidDateOnly,
  WALK_IN_NAME,
  type Invoice,
  type InvoiceLine,
  type InvoiceHistoryParams,
  type InvoiceHistoryRow,
  type InvoiceHistoryResult
} from '../../shared/invoices.ts'
import { ipcErr, ipcOk, type IpcResult, type DiscountType } from '../../shared/products.ts'

type Db = Database.Database

/** Fixed human-facing prefix for NEW invoices (legacy numbers are preserved). */
export const INVOICE_NUMBER_PREFIX = 'KPR-INV-'
const NUMBER_MIN = 1000
const NUMBER_SPAN = 9000 // 1000..9999

class InvoiceNumberExhausted extends Error {}

const DRAFT_NUMBER_RE = /^KPR-INV-\d{4}$/

// ─── Draft-number reservations (main-process only, per app session) ────
// Numbers shown on a draft are RESERVED here. Abandoned drafts are safe:
// reservations live only in this process and expire after the TTL, so a
// number is never handed out twice while still reserved, and nothing is
// ever WRITTEN to the database just to reserve a draft number.
const RESERVATION_TTL_MS = 60 * 60 * 1000 // 1 hour
const reservedNumbers = new Map<string, number>() // number -> expiry timestamp

function pruneReservations(now: number): void {
  for (const [num, expiry] of reservedNumbers) {
    if (expiry <= now) reservedNumbers.delete(num)
  }
}

function invoiceNumberTaken(db: Db, number: string): boolean {
  return !!db
    .prepare<[string], { x: number }>('SELECT 1 AS x FROM invoices WHERE invoice_number = ?')
    .get(number)
}

/** Reserve an unused KPR-INV-XXXX number for the current draft. */
export function reserveInvoiceNumber(db: Db): string {
  const now = Date.now()
  pruneReservations(now)
  for (let attempt = 0; attempt < NUMBER_SPAN; attempt++) {
    const candidate = `${INVOICE_NUMBER_PREFIX}${NUMBER_MIN + randomInt(0, NUMBER_SPAN)}`
    if (!reservedNumbers.has(candidate) && !invoiceNumberTaken(db, candidate)) {
      reservedNumbers.set(candidate, now + RESERVATION_TTL_MS)
      return candidate
    }
  }
  throw new InvoiceNumberExhausted()
}

/** Explicitly give back a reserved number (true when this process held it). */
export function releaseInvoiceNumber(number: string): boolean {
  return reservedNumbers.delete(number)
}

/**
 * A draft number supplied by the renderer is honoured ONLY if this process
 * reserved it, it has not expired, and it is still unused in the database.
 * The reservation is released by createInvoice AFTER a successful save, so a
 * failed save keeps the displayed draft number valid for a retry.
 */
function hasLiveReservation(db: Db, number: string): boolean {
  const expiry = reservedNumbers.get(number)
  if (expiry === undefined || expiry <= Date.now()) return false
  return !invoiceNumberTaken(db, number)
}

/** Test helper: number of live (unexpired) reservations. */
export function pendingReservationCount(): number {
  pruneReservations(Date.now())
  return reservedNumbers.size
}

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

/** Case-insensitive exact-number read (legacy numbers included). */
function getInvoiceByNumberNoCase(db: Db, invoiceNumber: string): Invoice | null {
  const row = db
    .prepare<[{ n: string }], InvoiceRow>(
      `SELECT ${INVOICE_COLS} FROM invoices WHERE invoice_number = @n COLLATE NOCASE`
    )
    .get({ n: invoiceNumber })
  return row ? mapInvoice(row, linesFor(db, row.id)) : null
}

/**
 * Reopen an invoice from an untrusted lookup string: either the last four
 * digits of the number OR the full invoice number (case-insensitive, legacy
 * compatible). Returns exactly one invoice, a NOT_FOUND error, an AMBIGUOUS
 * error listing the candidates, or a VALIDATION error for bad input.
 * Parameterized SQL only; the '%' wildcard is built exclusively from four
 * validated ASCII digits.
 */
export function searchInvoice(db: Db, rawInput: unknown): IpcResult<Invoice> {
  const parsed = parseInvoiceLookup(rawInput)
  if (!parsed.ok) {
    return ipcErr<Invoice>('VALIDATION', parsed.message)
  }

  if (parsed.mode === 'suffix') {
    const matches = db
      .prepare<[{ p: string }], { invoice_number: string }>(
        `SELECT invoice_number FROM invoices WHERE invoice_number LIKE @p ORDER BY invoice_number LIMIT 6`
      )
      .all({ p: `%${parsed.digits}` })
    if (matches.length === 0) {
      return ipcErr<Invoice>('NOT_FOUND', `No invoice found for ${parsed.digits}`)
    }
    if (matches.length > 1) {
      const list = matches.map((m) => m.invoice_number).join(', ')
      return ipcErr<Invoice>(
        'AMBIGUOUS',
        `Multiple invoices end with ${parsed.digits}: ${list}. Enter the full invoice number.`
      )
    }
    const invoice = getInvoiceByNumber(db, matches[0].invoice_number)
    return invoice ? ipcOk(invoice) : ipcErr<Invoice>('NOT_FOUND', `No invoice found for ${parsed.digits}`)
  }

  const invoice = getInvoiceByNumberNoCase(db, parsed.value)
  if (!invoice) {
    return ipcErr<Invoice>('NOT_FOUND', `No invoice found for ${parsed.value}`)
  }
  return ipcOk(invoice)
}

// ─── Sales History listing (search / date filters / sort / page / summary) ───

/** Escape LIKE wildcards (and the escape char) in user text. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/** The calendar day AFTER 'YYYY-MM-DD' — used for an inclusive end date. */
function dayAfterLocal(dateOnly: string): string {
  const [y, mo, d] = dateOnly.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10)
}

interface HistoryWhere {
  sql: string // includes leading WHERE when non-empty
  bind: Record<string, unknown>
}

function buildHistoryWhere(params: InvoiceHistoryParams): HistoryWhere {
  const parts: string[] = []
  const bind: Record<string, unknown> = {}

  if (params.invoiceNumber) {
    // Reuse the billing-page lookup rules: exact-4-digit suffix and full
    // numbers match precisely; anything else (partially typed) falls back to
    // a safe escaped contains-search so legacy numbers stay findable.
    const parsed = parseInvoiceLookup(params.invoiceNumber)
    if (parsed.ok && parsed.mode === 'suffix') {
      parts.push('invoice_number LIKE @invPattern')
      bind.invPattern = `%${parsed.digits}`
    } else if (parsed.ok && parsed.mode === 'full') {
      parts.push('invoice_number = @invExact COLLATE NOCASE')
      bind.invExact = parsed.value
    } else {
      parts.push(`invoice_number LIKE @invPattern ESCAPE '\\'`)
      bind.invPattern = `%${escapeLike(params.invoiceNumber)}%`
    }
  }

  if (params.customer) {
    // Snapshot columns (NOT the live customers table) — historical truth.
    parts.push(`(customer_name LIKE @cust ESCAPE '\\' OR customer_phone LIKE @cust ESCAPE '\\')`)
    bind.cust = `%${escapeLike(params.customer)}%`
  }

  // invoice_date is 'YYYY-MM-DD HH:MM:SS' local text: lexicographic range
  // checks are exact, with BOTH boundary days included.
  if (params.startDate) {
    parts.push('invoice_date >= @startDate')
    bind.startDate = params.startDate
  }
  if (params.endDate) {
    parts.push('invoice_date < @endDateNext')
    bind.endDateNext = dayAfterLocal(params.endDate)
  }

  return { sql: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', bind }
}

interface HistoryRowRaw {
  id: number
  invoice_number: string
  invoice_date: string
  customer_name: string
  customer_phone: string
  item_count: number | null
  subtotal_paise: number
  discount_paise: number
  round_off_paise: number
  total_paise: number
}

export function listInvoices(db: Db, params: InvoiceHistoryParams): IpcResult<InvoiceHistoryResult> {
  // Defensive re-checks (the IPC layer validates first).
  if (params.startDate && !isValidDateOnly(params.startDate)) {
    return ipcErr<InvoiceHistoryResult>('VALIDATION', 'Start date must be a real date (YYYY-MM-DD).')
  }
  if (params.endDate && !isValidDateOnly(params.endDate)) {
    return ipcErr<InvoiceHistoryResult>('VALIDATION', 'End date must be a real date (YYYY-MM-DD).')
  }
  if (params.startDate && params.endDate && params.startDate > params.endDate) {
    return ipcErr<InvoiceHistoryResult>('VALIDATION', 'Start date must not be later than the end date.')
  }

  const { sql: whereSql, bind } = buildHistoryWhere(params)
  const from = `FROM invoices i ${whereSql}`

  const counts = db
    .prepare<Record<string, unknown>, { c: number }>(`SELECT COUNT(*) AS c ${from}`)
    .get(bind)
  const totalMatches = counts?.c ?? 0

  // Summary over ALL matching invoices (integer paise aggregation).
  const agg = db
    .prepare<
      Record<string, unknown>,
      { invoice_count: number; total_sales: number; total_discounts: number; total_items: number | null }
    >(
      `SELECT COUNT(*) AS invoice_count,
              COALESCE(SUM(i.total_paise), 0) AS total_sales,
              COALESCE(SUM(i.discount_paise), 0) AS total_discounts,
              COALESCE(SUM((SELECT SUM(ii.quantity) FROM invoice_items ii WHERE ii.invoice_id = i.id)), 0) AS total_items
       ${from}`
    )
    .get(bind)

  const offset = (params.page - 1) * params.pageSize
  const rows = db
    .prepare<Record<string, unknown>, HistoryRowRaw>(
      `SELECT i.id, i.invoice_number, i.invoice_date, i.customer_name, i.customer_phone,
              i.subtotal_paise, i.discount_paise, i.round_off_paise, i.total_paise,
              (SELECT SUM(ii.quantity) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS item_count
       ${from}
       ORDER BY i.invoice_date DESC, i.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...bind, limit: params.pageSize, offset })

  const items: InvoiceHistoryRow[] = rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    itemCount: Math.round(r.item_count ?? 0),
    subtotalPaise: r.subtotal_paise,
    discountPaise: r.discount_paise,
    roundOffPaise: r.round_off_paise ?? 0,
    totalPaise: r.total_paise
  }))

  return ipcOk({
    items,
    page: params.page,
    pageSize: params.pageSize,
    totalMatches,
    summary: {
      invoiceCount: agg?.invoice_count ?? 0,
      totalSalesPaise: agg?.total_sales ?? 0,
      totalDiscountPaise: agg?.total_discounts ?? 0,
      totalItemsSold: Math.round(agg?.total_items ?? 0)
    }
  })
}

/** Allocate an unused KPR-INV-XXXX number (cryptographic randomness). */
function generateInvoiceNumber(db: Db): string {
  const now = Date.now()
  pruneReservations(now)
  for (let attempt = 0; attempt < NUMBER_SPAN; attempt++) {
    const candidate = `${INVOICE_NUMBER_PREFIX}${NUMBER_MIN + randomInt(0, NUMBER_SPAN)}`
    // Never steal a number that is reserved for an open draft elsewhere.
    if (reservedNumbers.has(candidate)) continue
    if (!invoiceNumberTaken(db, candidate)) return candidate
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
  // Draft number shown to the user: honoured only when this process still
  // holds a live reservation for it (validated against the DB too).
  let reservedDraft: string | null = null
  const rawDraftNumber = (rawInput as { draftNumber?: unknown } | null)?.draftNumber
  if (typeof rawDraftNumber === 'string' && DRAFT_NUMBER_RE.test(rawDraftNumber)) {
    if (hasLiveReservation(db, rawDraftNumber)) reservedDraft = rawDraftNumber
  }

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
      subtotal_paise, discount_paise, round_off_paise, tax_amount_paise, total_paise,
      payment_mode, notes
    ) VALUES (
      @number, @customerId, @customerName, @customerPhone, @customerAddress,
      @subtotal, @discount, @roundOff, @tax, @total,
      @paymentMode, @notes
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
    // Honour ONLY a main-process-reserved draft number; anything else the
    // renderer sends is ignored and a fresh number is allocated instead.
    const invoiceNumber = reservedDraft ?? generateInvoiceNumber(db)
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
      // Already validated to 'CASH' | 'UPI' by validateInvoiceInput (main boundary).
      paymentMode: value.paymentMethod,
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
  // Save succeeded: the draft reservation is now consumed by the invoice.
  if (reservedDraft) reservedNumbers.delete(reservedDraft)

  const created = getInvoice(db, invoiceId)
  if (!created) return ipcErr<Invoice>('DB_ERROR', 'Invoice saved but could not be re-read.')
  return ipcOk(created)
}
