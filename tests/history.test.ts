/**
 * Sales History (Phase 5) tests — throwaway OS-temp databases only.
 * Covers: listing + ordering (newest first, stable tie-break), invoice /
 * customer / legacy search (incl. ambiguous suffix = BOTH rows, never one
 * arbitrary), inclusive date-range filters, pagination boundaries and no
 * duplicates, main-process summary aggregation in integer paise, historical
 * integrity (master edits never change history rows) and query validation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openTempDb } from './_util.ts'
import { migrateDatabase } from '../src/main/db/migrate.ts'
import {
  createInvoice,
  getInvoice,
  listInvoices,
  reserveInvoiceNumber
} from '../src/main/db/invoices-repo.ts'
import { createProduct } from '../src/main/db/products-repo.ts'
import { createCustomer, updateCustomer } from '../src/main/db/customers-repo.ts'
import { validateInvoiceHistoryParams, formatInvoiceDate } from '../src/shared/invoices.ts'
import type { InvoiceHistoryParams } from '../src/shared/invoices.ts'

function setup() {
  const t = openTempDb()
  migrateDatabase(t.db)
  return t
}

type Temp = ReturnType<typeof setup>

let seq = 0

/** Create one saved invoice (reserved draft number) at a fixed timestamp. */
function makeInvoice(
  t: Temp,
  opts: {
    finalPaise?: number
    qty?: number
    customerName?: string
    customerPhone?: string
    date?: string
    extraLine?: boolean
  } = {}
): { number: string; id: number } {
  seq += 1
  const code = `HC${seq}`
  const prod = createProduct(t.db, {
    productCode: code,
    productName: `History Product ${code}`,
    category: 'A',
    brand: '',
    ratePaise: (opts.finalPaise ?? 1000) * 2,
    discountType: 'percent',
    discountPercent: 50,
    discountAmountPaise: 0,
    finalRatePaise: opts.finalPaise ?? 1000,
    greenCracker: false,
    description: '',
    imagePath: ''
  })
  assert.ok(prod.ok, 'seed product must succeed')

  const lines: { productId: number; quantity: number }[] = [
    { productId: prod.data.id, quantity: opts.qty ?? 1 }
  ]
  if (opts.extraLine) {
    // second line adds 2 more units so itemCount == qty + 2
    lines.push({ productId: prod.data.id, quantity: 2 })
  }

  const draft = reserveInvoiceNumber(t.db)
  const res = createInvoice(t.db, {
    customerId: null,
    customerName: opts.customerName ?? '',
    customerPhone: opts.customerPhone ?? '',
    lines,
    notes: '',
    draftNumber: draft
  })
  if (!res.ok) assert.fail(`seed invoice must succeed: ${JSON.stringify(res.error)}`)
  if (opts.date) {
    t.db.prepare('UPDATE invoices SET invoice_date = ? WHERE id = ?').run(opts.date, res.data.id)
  }
  return { number: res.data.invoiceNumber, id: res.data.id }
}

/** Direct legacy-style insert (arbitrary number/date, one item line). */
function insertLegacy(t: Temp, number: string, date: string, name = 'Walk-in Customer', phone = ''): number {
  const info = t.db
    .prepare(
      `INSERT INTO invoices (invoice_number, customer_name, customer_phone, invoice_date, subtotal_paise, discount_paise, total_paise)
       VALUES (?, ?, ?, ?, 5000, 2000, 3000)`
    )
    .run(number, name, phone, date)
  const id = Number(info.lastInsertRowid)
  t.db
    .prepare(
      `INSERT INTO invoice_items (invoice_id, product_name, quantity, unit_price_paise, line_total_paise)
       VALUES (?, 'Legacy Item', 4, 3000, 3000)`
    )
    .run(id)
  return id
}

function list(t: Temp, params: Partial<InvoiceHistoryParams> = {}) {
  const res = listInvoices(t.db, { page: 1, pageSize: 25, ...params })
  if (!res.ok) assert.fail(`list must succeed: ${JSON.stringify(res.error)}`)
  return res.data
}

// ─── A. Listing & ordering ─────────────────────────────────────────────

test('history lists newest first across new-format, legacy, walk-in and named invoices', () => {
  const t = setup()
  try {
    const a = makeInvoice(t, { customerName: 'Ramesh', customerPhone: '9876543210', qty: 3, date: '2026-10-17 09:00:00' })
    const b = makeInvoice(t, { date: '2026-10-18 14:30:00' })
    const legacyId = insertLegacy(t, 'KPR-3', '2026-10-19 08:00:00')

    const data = list(t)
    assert.equal(data.totalMatches, 3)
    assert.deepEqual(
      data.items.map((r) => r.invoiceNumber),
      ['KPR-3', b.number, a.number]
    )

    const ramesh = data.items.find((r) => r.invoiceNumber === a.number)!
    assert.equal(ramesh.customerName, 'Ramesh') // snapshot, not master
    assert.equal(ramesh.customerPhone, '9876543210')
    assert.equal(ramesh.itemCount, 3) // total quantity sold
    assert.equal(ramesh.subtotalPaise, 2000 * 3)
    assert.equal(ramesh.discountPaise, 1000 * 3)
    assert.equal(ramesh.totalPaise, 1000 * 3)

    const legacy = data.items.find((r) => r.id === legacyId)!
    assert.equal(legacy.itemCount, 4)
    assert.equal(legacy.totalPaise, 3000)
    assert.ok(!legacy.invoiceNumber.startsWith('KPR-INV-'), 'legacy number preserved exactly')
  } finally {
    t.cleanup()
  }
})

test('same timestamp ordering is stable: higher id first', () => {
  const t = setup()
  try {
    const same = '2026-10-15 10:00:00'
    const first = makeInvoice(t, { date: same })
    const second = makeInvoice(t, { date: same })
    const data = list(t)
    assert.ok(second.id > first.id)
    assert.equal(data.items[0].invoiceNumber, second.number)
    assert.equal(data.items[1].invoiceNumber, first.number)
  } finally {
    t.cleanup()
  }
})

// ─── B. Search ─────────────────────────────────────────────────────────

test('invoice-number search: full (case-insensitive), last-4 suffix, legacy, partial, none', () => {
  const t = setup()
  try {
    const inv = makeInvoice(t, { date: '2026-10-16 10:00:00' })
    insertLegacy(t, 'KPR-3', '2026-10-14 10:00:00')
    const digits = inv.number.slice(-4)

    assert.deepEqual(list(t, { invoiceNumber: inv.number }).items.map((r) => r.invoiceNumber), [inv.number])
    assert.deepEqual(list(t, { invoiceNumber: inv.number.toLowerCase() }).items.map((r) => r.invoiceNumber), [inv.number])
    assert.deepEqual(list(t, { invoiceNumber: `  ${digits}  ` }).items.map((r) => r.invoiceNumber), [inv.number])
    assert.deepEqual(list(t, { invoiceNumber: 'KPR-3' }).items.map((r) => r.invoiceNumber), ['KPR-3'])
    assert.deepEqual(list(t, { invoiceNumber: 'HC5-parti' }).totalMatches, 0) // no such number
    assert.equal(list(t, { invoiceNumber: '0000' }).totalMatches, 0)

    // Ambiguous suffix: the LIST shows BOTH matches (never one arbitrary).
    insertLegacy(t, 'KPR-INV-2020', '2026-10-13 10:00:00')
    insertLegacy(t, 'OLD-2020', '2026-10-12 10:00:00')
    const amb = list(t, { invoiceNumber: '2020' })
    assert.deepEqual(amb.items.map((r) => r.invoiceNumber).sort(), ['KPR-INV-2020', 'OLD-2020'])
  } finally {
    t.cleanup()
  }
})

test('customer search matches the saved snapshot by name or phone, case-insensitively', () => {
  const t = setup()
  try {
    makeInvoice(t, { customerName: 'Ramesh Kumar', customerPhone: '9876543210' })
    makeInvoice(t, { customerName: 'Suresh', customerPhone: '9111122222' })
    const walkin = makeInvoice(t, {}) // no details -> Walk-in Customer

    assert.equal(list(t, { customer: 'ramesh' }).totalMatches, 1)
    assert.equal(list(t, { customer: 'KUMAR' }).totalMatches, 1)
    assert.equal(list(t, { customer: '98765' }).totalMatches, 1)
    assert.equal(list(t, { customer: 'zzz' }).totalMatches, 0)
    assert.equal(list(t).totalMatches, 3, 'walk-in rows are never hidden')
    assert.equal(list(t).items.find((r) => r.invoiceNumber === walkin.number)!.customerName, 'Walk-in Customer')

    // LIKE wildcards in user text are escaped, not treated as patterns
    assert.equal(list(t, { customer: '%' }).totalMatches, 0)
    assert.equal(list(t, { customer: '_' }).totalMatches, 0)
  } finally {
    t.cleanup()
  }
})

// ─── C. Date filters ───────────────────────────────────────────────────

test('date ranges are inclusive on both ends and combine with other filters', () => {
  const t = setup()
  try {
    makeInvoice(t, { customerName: 'Ramesh', date: '2026-10-17 00:00:01' })
    makeInvoice(t, { customerName: 'Ramesh', date: '2026-10-18 23:59:59' })
    makeInvoice(t, { customerName: 'Suresh', date: '2026-10-19 12:00:00' })

    assert.equal(list(t, { startDate: '2026-10-18' }).totalMatches, 2, 'start-only: from that day onward')
    assert.equal(list(t, { endDate: '2026-10-18' }).totalMatches, 2, 'end-only: up to and including that day')
    assert.equal(list(t, { startDate: '2026-10-18', endDate: '2026-10-18' }).totalMatches, 1, 'both ends inclusive')
    assert.equal(list(t, { startDate: '2026-10-20' }).totalMatches, 0, 'empty range yields zero')

    // combined: customer + date
    const comb = list(t, { customer: 'ramesh', startDate: '2026-10-18', endDate: '2026-10-18' })
    assert.equal(comb.totalMatches, 1)
    assert.equal(comb.summary.invoiceCount, 1, 'summary uses the same criteria')
  } finally {
    t.cleanup()
  }
})

test('invalid date ranges and formats are rejected by repository and validator', () => {
  const t = setup()
  try {
    const bad = listInvoices(t.db, {
      page: 1,
      pageSize: 25,
      startDate: '2026-10-19',
      endDate: '2026-10-18'
    })
    assert.ok(!bad.ok)
    assert.equal(bad.error.code, 'VALIDATION')
    assert.match(bad.error.message, /not be later/)

    const bogus = listInvoices(t.db, { page: 1, pageSize: 25, startDate: '2026-13-45' })
    assert.ok(!bogus.ok)
    assert.equal(bogus.error.code, 'VALIDATION')
  } finally {
    t.cleanup()
  }
})

// ─── D. Pagination ─────────────────────────────────────────────────────

test('pagination: first/middle/last pages, boundaries and no duplicate rows', () => {
  const t = setup()
  try {
    for (let i = 0; i < 7; i++) makeInvoice(t, { date: `2026-10-0${i + 1} 09:00:00` })

    const p1 = list(t, { page: 1, pageSize: 3 })
    const p2 = list(t, { page: 2, pageSize: 3 })
    const p3 = list(t, { page: 3, pageSize: 3 })
    assert.deepEqual([p1.items.length, p2.items.length, p3.items.length], [3, 3, 1])
    assert.equal(p1.totalMatches, 7)

    // beyond the last page: empty items, totals/summary still correct
    const p4 = list(t, { page: 4, pageSize: 3 })
    assert.equal(p4.items.length, 0)
    assert.equal(p4.totalMatches, 7)
    assert.equal(p4.summary.invoiceCount, 7)

    const ids = [...p1.items, ...p2.items, ...p3.items].map((r) => r.id)
    assert.equal(new Set(ids).size, 7, 'no duplicate records across pages')

    // a filter reducing the result set repaginates correctly
    const filtered = list(t, { customer: 'NoSuch', pageSize: 3 })
    assert.equal(filtered.totalMatches, 0)
    assert.equal(filtered.items.length, 0)
  } finally {
    t.cleanup()
  }
})

// ─── E. Summary ────────────────────────────────────────────────────────

test('summary aggregates saved integer-paise values over ALL matching invoices, not the page', () => {
  const t = setup()
  try {
    // odd paise amounts exercise integer precision; final 3345 rate 10000
    const a = makeInvoice(t, { finalPaise: 3345, qty: 3, date: '2026-10-17 10:00:00' })
    const b = makeInvoice(t, { finalPaise: 100, qty: 2, date: '2026-10-18 10:00:00' })
    const c = makeInvoice(t, { finalPaise: 999, qty: 1, date: '2026-10-19 10:00:00' })

    const all = list(t, { pageSize: 2 }) // page smaller than the match count
    assert.equal(all.summary.invoiceCount, 3)
    assert.equal(all.summary.totalSalesPaise, 3345 * 3 + 100 * 2 + 999)
    // seed rate is ALWAYS 2x final: per-unit discount == final
    assert.equal(all.summary.totalDiscountPaise, 3345 * 3 + 100 * 2 + 999)
    assert.equal(all.summary.totalItemsSold, 3 + 2 + 1)
    assert.equal(all.items.length, 2, 'table still paginated independently')

    const ranged = list(t, { startDate: '2026-10-18' })
    assert.equal(ranged.summary.invoiceCount, 2)
    assert.equal(ranged.summary.totalSalesPaise, 100 * 2 + 999)
    assert.equal(ranged.summary.totalItemsSold, 3)

    const none = list(t, { customer: 'nothing-matches' })
    assert.deepEqual(none.summary, {
      invoiceCount: 0,
      totalSalesPaise: 0,
      totalDiscountPaise: 0,
      totalItemsSold: 0
    })

    // references used to keep TS from complaining about unused vars
    assert.ok(a.number && b.number && c.number)
  } finally {
    t.cleanup()
  }
})

test('multi-line invoice counts total quantity sold in items and summary', () => {
  const t = setup()
  try {
    const m = makeInvoice(t, { qty: 3, extraLine: true, date: '2026-10-16 09:00:00' })
    const data = list(t)
    assert.equal(data.items.find((r) => r.invoiceNumber === m.number)!.itemCount, 5)
    assert.equal(data.summary.totalItemsSold, 5)
  } finally {
    t.cleanup()
  }
})

// ─── F. Historical integrity ───────────────────────────────────────────

test('product/customer edits or archiving never change saved history rows or the summary', () => {
  const t = setup()
  try {
    const cust = createCustomer(t.db, { name: 'Original Name', phone: '9000000000', address: 'A', notes: '' })
    assert.ok(cust.ok)
    const prod = createProduct(t.db, {
      productCode: 'HP9',
      productName: 'Orig Product',
      category: 'A',
      brand: '',
      ratePaise: 10000,
      discountType: 'none',
      discountPercent: 0,
      discountAmountPaise: 0,
      finalRatePaise: 8000,
      greenCracker: false,
      description: '',
      imagePath: ''
    })
    assert.ok(prod.ok)
    const draft = reserveInvoiceNumber(t.db)
    const inv = createInvoice(t.db, {
      customerId: cust.data.id,
      lines: [{ productId: prod.data.id, quantity: 2 }],
      notes: '',
      draftNumber: draft
    })
    assert.ok(inv.ok)

    const before = JSON.stringify(list(t))

    // price revision + rename + archive + master customer edit AFTER the sale
    t.db
      .prepare('UPDATE products SET final_rate_paise = 99999, product_name = ? WHERE product_code = ?')
      .run('Renamed Product', 'HP9')
    t.db.prepare('UPDATE products SET is_active = 0 WHERE product_code = ?').run('HP9')
    updateCustomer(t.db, cust.data.id, { name: 'Renamed Customer', phone: '111', address: 'B', notes: '' })

    assert.equal(JSON.stringify(list(t)), before, 'history must be byte-identical after master edits')
    const opened = getInvoice(t.db, inv.data.id)
    assert.ok(opened)
    assert.equal(opened.customerName, 'Original Name') // snapshot intact
    assert.equal(opened.lines[0].unitPricePaise, 8000) // historical price intact
  } finally {
    t.cleanup()
  }
})

// ─── G. Query validation (shared validator used by the IPC layer) ─────

test('validateInvoiceHistoryParams: defaults, bounds, dates and bad input', () => {
  const ok = validateInvoiceHistoryParams({})
  assert.deepEqual(ok.errors, {})
  assert.deepEqual(ok.value, { page: 1, pageSize: 25 })

  assert.ok(validateInvoiceHistoryParams({ page: 0 }).errors.page)
  assert.ok(validateInvoiceHistoryParams({ page: -3 }).errors.page)
  assert.ok(validateInvoiceHistoryParams({ page: 1.5 }).errors.page)
  assert.ok(validateInvoiceHistoryParams({ pageSize: 0 }).errors.pageSize)
  assert.ok(validateInvoiceHistoryParams({ pageSize: 500 }).errors.pageSize)

  assert.ok(validateInvoiceHistoryParams({ startDate: '17-10-2026' }).errors.startDate)
  assert.ok(validateInvoiceHistoryParams({ startDate: '2026-13-01' }).errors.startDate)
  assert.ok(validateInvoiceHistoryParams({ endDate: '2026-02-30' }).errors.endDate)
  const range = validateInvoiceHistoryParams({ startDate: '2026-10-19', endDate: '2026-10-18' })
  assert.match(range.errors.endDate ?? '', /not be later/)

  assert.ok(validateInvoiceHistoryParams({ customer: 'x'.repeat(201) }).errors.customer)
  assert.ok(validateInvoiceHistoryParams({ invoiceNumber: 42 }).errors.invoiceNumber)
  assert.ok(validateInvoiceHistoryParams(null).errors !== undefined || Object.keys(validateInvoiceHistoryParams(null).errors).length === 0)

  // trimming + valid values pass through
  const valid = validateInvoiceHistoryParams({ invoiceNumber: ' 8540 ', page: 3, pageSize: 50, startDate: '2026-01-31' })
  assert.deepEqual(valid.errors, {})
  assert.equal(valid.value.invoiceNumber, '8540')
  assert.equal(valid.value.page, 3)
  assert.equal(valid.value.pageSize, 50)
})

test('formatInvoiceDate renders dd-mm-yyyy hh:mm AM/PM and falls back safely', () => {
  assert.equal(formatInvoiceDate('2026-10-19 14:30:00'), '19-10-2026 02:30 PM')
  assert.equal(formatInvoiceDate('2026-10-19 00:05:00'), '19-10-2026 12:05 AM')
  assert.equal(formatInvoiceDate('2026-10-19 12:00:00'), '19-10-2026 12:00 PM')
  assert.equal(formatInvoiceDate('2026-10-19 13:00:00'), '19-10-2026 01:00 PM')
  assert.equal(formatInvoiceDate('2026-10-19'), '19-10-2026')
  assert.equal(formatInvoiceDate('not a date'), 'not a date')
})
