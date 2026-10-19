/**
 * Invoice tests — all on throwaway OS-temp databases (never the live DB).
 * Covers: creation/persistence, main-process recalculation, integer-paise
 * totals, discount derivation, round-off, KPR-INV-XXXX numbering (format,
 * uniqueness, collision-skip, exhaustion), walk-in + existing customer
 * snapshots, invalid/empty invoices, rollback, historical integrity,
 * legacy-number compatibility and the v3 -> v4 -> v5 migration chain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { openTempDb } from './_util.ts'
import { migrateDatabase } from '../src/main/db/migrate.ts'
import { createInvoice, getInvoice, getInvoiceByNumber } from '../src/main/db/invoices-repo.ts'
import { createProduct } from '../src/main/db/products-repo.ts'
import { createCustomer, deleteCustomer, updateCustomer } from '../src/main/db/customers-repo.ts'
import {
  computeInvoiceTotals,
  computeLineAmounts,
  validateInvoiceInput,
  lineTotalPaise
} from '../src/shared/invoices.ts'
import { LEGACY_V3_INVOICES_SQL } from '../src/main/db/schema.ts'

function setup() {
  const t = openTempDb()
  migrateDatabase(t.db)
  return t
}

// seedProduct: rate defaults to 2x final, so per-unit discount == final.
function seedProduct(t: ReturnType<typeof setup>, code: string, finalPaise: number, ratePaise = finalPaise * 2) {
  const res = createProduct(t.db, {
    productCode: code,
    productName: `Product ${code}`,
    category: 'A',
    brand: '',
    ratePaise,
    discountType: 'percent',
    discountPercent: 50,
    discountAmountPaise: 0,
    finalRatePaise: finalPaise,
    greenCracker: false,
    description: '',
    imagePath: ''
  })
  assert.ok(res.ok, 'seed product must succeed')
  return res.data
}

function seedCustomer(t: ReturnType<typeof setup>, name: string) {
  const res = createCustomer(t.db, { name, phone: '999', address: 'Somewhere', notes: '' })
  assert.ok(res.ok, 'seed customer must succeed')
  return res.data
}

const INV_NUM_RE = /^KPR-INV-\d{4}$/

// ─── Pure calculation engine ───────────────────────────────────────────

test('lineTotalPaise multiplies integer paise by quantity', () => {
  assert.equal(lineTotalPaise(10000, 3), 30000)
  assert.equal(lineTotalPaise(450000, 2), 900000)
})

test('computeLineAmounts: rate x qty, final x qty, per-unit discount x qty', () => {
  const a = computeLineAmounts({ originalRatePaise: 10000, unitPricePaise: 2000, quantity: 3 })
  assert.equal(a.rateAmountPaise, 30000) // 10000 * 3
  assert.equal(a.lineTotalPaise, 6000) // final 2000 * 3
  assert.equal(a.discountAmountPaise, 24000) // (10000-2000) * 3
})

test('computeInvoiceTotals reconciles: subtotal - discount == payable', () => {
  const totals = computeInvoiceTotals([
    { originalRatePaise: 10000, unitPricePaise: 2000, quantity: 1 }, // A5 example
    { originalRatePaise: 9000, unitPricePaise: 1800, quantity: 1 } // A6 example
  ])
  assert.equal(totals.subtotalPaise, 19000) // ₹190
  assert.equal(totals.discountPaise, 15200) // ₹152
  assert.equal(totals.totalPaise, 3800) // ₹38
  assert.equal(totals.taxAmountPaise, 0) // GST disabled
  assert.equal(totals.subtotalPaise - totals.discountPaise, totals.totalPaise)
})

test('computeInvoiceTotals honours exceptional final != rate - nominal discount', () => {
  // rate 420000, stored final 249900 (I1 combo). Discount is derived from
  // the ACTUAL final, never the other way around.
  const totals = computeInvoiceTotals([{ originalRatePaise: 420000, unitPricePaise: 249900, quantity: 1 }])
  assert.equal(totals.subtotalPaise, 420000)
  assert.equal(totals.discountPaise, 170100)
  assert.equal(totals.totalPaise, 249900) // payable is authoritative
})

test('computeInvoiceTotals round-off rounds to nearest rupee only when enabled', () => {
  const off = computeInvoiceTotals([{ originalRatePaise: 10000, unitPricePaise: 3345, quantity: 1 }], false)
  assert.equal(off.roundOffPaise, 0)
  assert.equal(off.totalPaise, 3345)

  const down = computeInvoiceTotals([{ originalRatePaise: 10000, unitPricePaise: 3345, quantity: 1 }], true)
  assert.equal(down.roundOffPaise, -45) // 3345 -> 3300
  assert.equal(down.totalPaise, 3300)

  const up = computeInvoiceTotals([{ originalRatePaise: 10000, unitPricePaise: 3355, quantity: 1 }], true)
  assert.equal(up.roundOffPaise, 45) // 3355 -> 3400
  assert.equal(up.totalPaise, 3400)
})

// ─── Validation ────────────────────────────────────────────────────────

test('validation requires items and rejects non-integer / bad quantities', () => {
  assert.ok(validateInvoiceInput({ customerId: null, lines: [] }).errors.lines)
  assert.ok(validateInvoiceInput({ customerId: null, lines: [{ productId: 1, quantity: 0 }] }).errors['lines[0]'])
  assert.ok(validateInvoiceInput({ customerId: null, lines: [{ productId: 1, quantity: -2 }] }).errors['lines[0]'])
  assert.ok(validateInvoiceInput({ customerId: null, lines: [{ productId: 1, quantity: 2.5 }] }).errors['lines[0]'])
  assert.ok(validateInvoiceInput({ customerId: null, lines: [{ productId: 0, quantity: 1 }] }).errors['lines[0]'])
  const ok = validateInvoiceInput({ customerId: null, lines: [{ productId: 4, quantity: 3 }] })
  assert.deepEqual(ok.errors, {})
})

test('validation checks customer detail lengths and phone charset', () => {
  assert.ok(validateInvoiceInput({ customerId: null, lines: [{ productId: 1, quantity: 1 }], customerPhone: 'abc' }).errors.customerPhone)
  assert.ok(validateInvoiceInput({ customerId: null, lines: [{ productId: 1, quantity: 1 }], customerName: 'x'.repeat(201) }).errors.customerName)
  assert.ok(validateInvoiceInput({ customerId: null, lines: [{ productId: 1, quantity: 1 }], customerAddress: 'x'.repeat(501) }).errors.customerAddress)
})

// ─── Creation & persistence ────────────────────────────────────────────

test('create invoice: KPR-INV-XXXX number, main-recalculated totals, renderer values ignored', () => {
  const t = setup()
  try {
    const p1 = seedProduct(t, 'SKU-1', 6000) // rate 12000, final 6000
    const p2 = seedProduct(t, 'SKU-2', 450000) // rate 900000, final 450000
    const cust = seedCustomer(t, 'Asha')

    const res = createInvoice(t.db, {
      customerId: cust.id,
      // sneaky fields a compromised renderer might send — must be ignored
      lines: [
        { productId: p1.id, quantity: 2, lineTotalPaise: 1 },
        { productId: p2.id, quantity: 1, lineTotalPaise: 1 }
      ],
      notes: 'Regular order',
      totalPaise: 1,
      subtotalPaise: 1
    })
    if (!res.ok) assert.fail(`create failed: ${JSON.stringify(res.error)}`)
    const inv = res.data
    assert.match(inv.invoiceNumber, INV_NUM_RE)
    assert.equal(inv.customerName, 'Asha')
    assert.equal(inv.subtotalPaise, 12000 * 2 + 900000) // rate-based
    assert.equal(inv.discountPaise, 6000 * 2 + 450000) // (rate-final)*qty
    assert.equal(inv.roundOffPaise, 0)
    assert.equal(inv.totalPaise, inv.subtotalPaise - inv.discountPaise) // payable
    assert.equal(inv.taxAmountPaise, 0)
    assert.equal(inv.lines.length, 2)
    assert.equal(inv.lines[0].productCode, 'SKU-1')
    assert.equal(inv.lines[0].unitPricePaise, 6000) // stored final used
    assert.equal(inv.lines[0].originalRatePaise, 12000)
    assert.equal(inv.lines[0].lineTotalPaise, 12000) // 6000 * 2

    assert.ok(getInvoiceByNumber(t.db, inv.invoiceNumber))
  } finally {
    t.cleanup()
  }
})

test('walk-in invoice with optional details stores the entered snapshot', () => {
  const t = setup()
  try {
    const p = seedProduct(t, 'W1', 10000)
    const withDetails = createInvoice(t.db, {
      customerId: null,
      customerName: 'Sameer',
      customerPhone: '8888 1111',
      customerAddress: '11 Main Rd',
      lines: [{ productId: p.id, quantity: 2 }],
      notes: ''
    })
    assert.ok(withDetails.ok)
    assert.equal(withDetails.data.customerName, 'Sameer')
    assert.equal(withDetails.data.customerPhone, '8888 1111')
    assert.equal(withDetails.data.customerAddress, '11 Main Rd')
    assert.equal(withDetails.data.customerId, null)

    const bare = createInvoice(t.db, { customerId: null, lines: [{ productId: p.id, quantity: 1 }], notes: '' })
    assert.ok(bare.ok)
    assert.equal(bare.data.customerName, 'Walk-in Customer') // default when blank
  } finally {
    t.cleanup()
  }
})

test('existing-customer snapshot uses reviewed form values and never edits the master', () => {
  const t = setup()
  try {
    const p = seedProduct(t, 'E1', 5000)
    const cust = seedCustomer(t, 'Asha')
    const res = createInvoice(t.db, {
      customerId: cust.id,
      customerName: 'Asha Kumar', // reviewed/edited on the invoice only
      customerPhone: '999',
      customerAddress: 'Somewhere',
      lines: [{ productId: p.id, quantity: 1 }],
      notes: ''
    })
    assert.ok(res.ok)
    assert.equal(res.data.customerName, 'Asha Kumar')
    // master record untouched
    const master = t.db.prepare<[{ id: number }], { name: string }>('SELECT name FROM customers WHERE id=@id').get({ id: cust.id })
    assert.equal(master?.name, 'Asha')
  } finally {
    t.cleanup()
  }
})

test('invalid invoices are rejected with per-line errors and persist nothing', () => {
  const t = setup()
  try {
    const p = seedProduct(t, 'V1', 5000)
    const unknown = createInvoice(t.db, { customerId: null, lines: [{ productId: 9999, quantity: 1 }] })
    assert.ok(!unknown.ok)
    assert.equal(unknown.error.code, 'VALIDATION')
    assert.match(unknown.error.fields?.['lines[0]'] ?? '', /no longer exists/)

    const badCustomer = createInvoice(t.db, { customerId: 12345, lines: [{ productId: p.id, quantity: 1 }] })
    assert.ok(!badCustomer.ok)
    assert.match(badCustomer.error.fields?.customerId ?? '', /no longer exists/)

    assert.equal(t.db.prepare<[], { c: number }>('SELECT COUNT(*) c FROM invoices').get()?.c, 0)
  } finally {
    t.cleanup()
  }
})

// ─── Numbering safety ──────────────────────────────────────────────────

test('invoice numbers are unique across many creations', () => {
  const t = setup()
  try {
    const p = seedProduct(t, 'N1', 1000)
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const res = createInvoice(t.db, { customerId: null, lines: [{ productId: p.id, quantity: 1 }], notes: '' })
      assert.ok(res.ok)
      assert.match(res.data.invoiceNumber, INV_NUM_RE)
      assert.ok(!seen.has(res.data.invoiceNumber), 'duplicate number generated')
      seen.add(res.data.invoiceNumber)
    }
    assert.equal(seen.size, 40)
  } finally {
    t.cleanup()
  }
})

test('invoice_number column has a UNIQUE constraint', () => {
  const t = setup()
  try {
    t.db.exec("INSERT INTO invoices (invoice_number, customer_name) VALUES ('KPR-INV-4321', 'X')")
    assert.throws(() => {
      t.db.exec("INSERT INTO invoices (invoice_number, customer_name) VALUES ('KPR-INV-4321', 'Y')")
    }, /UNIQUE/)
  } finally {
    t.cleanup()
  }
})

test('generator skips used numbers and reports exhaustion when the space is full', () => {
  const t = setup()
  try {
    const p = seedProduct(t, 'X1', 1000)
    // Occupy EVERY possible KPR-INV-#### number inside one transaction.
    const ins = t.db.prepare("INSERT INTO invoices (invoice_number, customer_name, subtotal_paise, total_paise) VALUES (?, 'filler', 0, 0)")
    const fill = t.db.transaction(() => {
      for (let n = 1000; n <= 9999; n++) ins.run(`KPR-INV-${n}`)
    })
    fill()

    const res = createInvoice(t.db, { customerId: null, lines: [{ productId: p.id, quantity: 1 }], notes: '' })
    assert.ok(!res.ok, 'should fail when no number is available')
    assert.match(res.error.message, /exhausted/i)
    // no extra invoice was created beyond the 9000 fillers
    assert.equal(t.db.prepare<[], { c: number }>('SELECT COUNT(*) c FROM invoices').get()?.c, 9000)
  } finally {
    t.cleanup()
  }
})

test('legacy invoice numbers are preserved and still reopenable', () => {
  const t = setup()
  try {
    t.db.exec("INSERT INTO invoices (invoice_number, customer_name, subtotal_paise, total_paise) VALUES ('KPR-1', 'Walk-in Customer', 37600, 37600)")
    const legacy = getInvoiceByNumber(t.db, 'KPR-1')
    assert.ok(legacy)
    assert.equal(legacy.invoiceNumber, 'KPR-1')

    // a new invoice still gets a modern number and does not clash
    const p = seedProduct(t, 'L1', 1000)
    const res = createInvoice(t.db, { customerId: null, lines: [{ productId: p.id, quantity: 1 }], notes: '' })
    assert.ok(res.ok)
    assert.match(res.data.invoiceNumber, INV_NUM_RE)
  } finally {
    t.cleanup()
  }
})

// ─── Round-off persistence ─────────────────────────────────────────────

test('multi-line invoice persists fully reconciled totals with round-off + final-rate discrepancy', () => {
  const t = setup()
  try {
    t.db
      .prepare("INSERT INTO settings (key, value) VALUES ('round_off_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'")
      .run()
    const a = seedProduct(t, 'M1', 2000, 10000) // rate 100, final 20, qty 3
    const b = seedProduct(t, 'M2', 1800, 9000) // rate 90, final 18, qty 2
    const c = seedProduct(t, 'M3', 249945, 420000) // final != rate - 50% (discrepancy), qty 1

    const res = createInvoice(t.db, {
      customerId: null,
      lines: [
        { productId: a.id, quantity: 3 },
        { productId: b.id, quantity: 2 },
        { productId: c.id, quantity: 1 }
      ],
      notes: ''
    })
    assert.ok(res.ok)
    const inv = res.data

    // subtotal = SUM(rate x qty)
    assert.equal(inv.subtotalPaise, 10000 * 3 + 9000 * 2 + 420000) // 468000
    // payable (pre-round) = SUM(final x qty) = 6000 + 3600 + 249945 = 259545
    // discount = subtotal - payable = 208455
    assert.equal(inv.discountPaise, 468000 - 259545)
    // round-off: 259545 -> 259500 (nearest rupee) = -45
    assert.equal(inv.roundOffPaise, -45)
    assert.equal(inv.totalPaise, 259500)
    assert.equal(inv.taxAmountPaise, 0)
    // reconciliation identity
    assert.equal(inv.subtotalPaise - inv.discountPaise + inv.roundOffPaise, inv.totalPaise)

    // each line stores final x qty and the EXACT imported final rate (never recomputed)
    assert.equal(inv.lines[2].unitPricePaise, 249945)
    assert.equal(inv.lines[2].lineTotalPaise, 249945)
    assert.equal(inv.lines[0].lineTotalPaise, 6000)
    assert.equal(inv.lines[1].lineTotalPaise, 3600)
  } finally {
    t.cleanup()
  }
})

test('round-off is applied and stored when enabled in settings', () => {
  const t = setup()
  try {
    t.db.prepare("INSERT INTO settings (key, value) VALUES ('round_off_enabled', '1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
    // final 3345 -> payable 3345 -> rounds to 3300, round-off -45
    const p = seedProduct(t, 'RO1', 3345, 10000)
    const res = createInvoice(t.db, { customerId: null, lines: [{ productId: p.id, quantity: 1 }], notes: '' })
    assert.ok(res.ok)
    assert.equal(res.data.totalPaise, 3300)
    assert.equal(res.data.roundOffPaise, -45)
    assert.equal(res.data.subtotalPaise - res.data.discountPaise + res.data.roundOffPaise, res.data.totalPaise)
  } finally {
    t.cleanup()
  }
})

// ─── Rollback ──────────────────────────────────────────────────────────

test('mid-insert failure rolls back the entire invoice', () => {
  const t = setup()
  try {
    const p1 = seedProduct(t, 'B1', 1000)
    const p2 = seedProduct(t, 'B2', 2000)
    const db = t.db
    interface PatchedStmt {
      run: (...a: unknown[]) => unknown
    }
    type PatchedPrepare = (sql: string, ...rest: unknown[]) => PatchedStmt
    const dbObj = db as unknown as { prepare: PatchedPrepare }
    const original = dbObj.prepare
    let itemRuns = 0
    dbObj.prepare = ((sql: string, ...rest: unknown[]) => {
      const stmt = original.call(dbObj, sql, ...rest)
      if (sql.includes('INSERT INTO invoice_items')) {
        const origRun = stmt.run.bind(stmt)
        stmt.run = (...a: unknown[]) => {
          if (++itemRuns === 2) throw new Error('simulated disk failure')
          return origRun(...a)
        }
      }
      return stmt
    }) as PatchedPrepare

    assert.throws(() =>
      createInvoice(db, {
        customerId: null,
        lines: [
          { productId: p1.id, quantity: 1 },
          { productId: p2.id, quantity: 1 }
        ]
      })
    )
    dbObj.prepare = original

    assert.equal(db.prepare<[], { c: number }>('SELECT COUNT(*) c FROM invoices').get()?.c, 0)
    assert.equal(db.prepare<[], { c: number }>('SELECT COUNT(*) c FROM invoice_items').get()?.c, 0)
  } finally {
    t.cleanup()
  }
})

// ─── Historical integrity ──────────────────────────────────────────────

test('later product/customer edits or deletes never change a saved invoice', () => {
  const t = setup()
  try {
    const p = seedProduct(t, 'H1', 5000)
    const cust = seedCustomer(t, 'Original Name')
    const res = createInvoice(t.db, { customerId: cust.id, lines: [{ productId: p.id, quantity: 2 }], notes: 'keep' })
    assert.ok(res.ok)
    const before = JSON.stringify(res.data)

    t.db.prepare(`UPDATE products SET product_name = 'Renamed', final_rate_paise = 99999, rate_paise = 99999 WHERE id = ?`).run(p.id)
    updateCustomer(t.db, cust.id, { name: 'Renamed Customer', phone: '', address: '', notes: '' })
    const del = deleteCustomer(t.db, cust.id) // referenced -> archived
    assert.ok(del.ok)
    assert.equal(del.data.action, 'archived')

    const after = getInvoice(t.db, res.data.id)
    assert.equal(JSON.stringify(after), before, 'stored invoice snapshot must be byte-identical after master-data edits')
    assert.ok(before.includes('Original Name'))
    assert.ok(before.includes('H1'))
    assert.ok(!before.includes('99999'))
  } finally {
    t.cleanup()
  }
})

// ─── Migration chain ───────────────────────────────────────────────────

test('v3 -> v4 -> v5 migration converts money, backfills snapshots, adds round_off', () => {
  const t = setup()
  try {
    const cust = seedCustomer(t, 'Legacy Customer')
    const prod = seedProduct(t, 'L1', 250)

    t.db.exec('DROP TABLE invoice_items')
    t.db.exec('DROP TABLE invoices')
    t.db.exec(LEGACY_V3_INVOICES_SQL)
    t.db
      .prepare(`INSERT INTO invoices (id, invoice_number, customer_id, subtotal, discount, tax_amount, total) VALUES (1, 'OLD-1', @cust, 150.75, 0, 0, 150.75)`)
      .run({ cust: cust.id })
    t.db
      .prepare(`INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price, line_total) VALUES (1, @prod, 'Legacy Product Name', 3, 50.25, 150.75)`)
      .run({ prod: prod.id })
    t.db.pragma('user_version = 3')

    migrateDatabase(t.db)

    assert.equal(t.db.pragma('user_version', { simple: true }), 5)
    const inv = getInvoiceByNumber(t.db, 'OLD-1')
    assert.ok(inv)
    assert.equal(inv.subtotalPaise, 15075)
    assert.equal(inv.totalPaise, 15075)
    assert.equal(inv.roundOffPaise, 0)
    assert.equal(inv.customerName, 'Legacy Customer')
    assert.equal(inv.lines[0].unitPricePaise, 5025)
    assert.equal(inv.lines[0].productCode, 'L1')
    assert.equal(inv.lines[0].productName, 'Legacy Product Name')
  } finally {
    t.cleanup()
  }
})

test('fresh database is created at v5 with snapshot + round_off columns', () => {
  const t = openTempDb()
  try {
    migrateDatabase(t.db)
    const cols = (t.db.pragma('table_info(invoices)') as { name: string }[]).map((c) => c.name)
    for (const need of ['customer_name', 'customer_phone', 'customer_address', 'subtotal_paise', 'discount_paise', 'round_off_paise', 'total_paise', 'tax_amount_paise']) {
      assert.ok(cols.includes(need), `invoices must have ${need}`)
    }
    assert.equal(t.db.pragma('user_version', { simple: true }), 5)
  } finally {
    t.cleanup()
  }
})

test('migration is idempotent and reopening the file keeps data', () => {
  const t = setup()
  const file = join(t.dir, 'test.db')
  try {
    const p = seedProduct(t, 'S1', 1000)
    const first = createInvoice(t.db, { customerId: null, lines: [{ productId: p.id, quantity: 3 }], notes: '' })
    assert.ok(first.ok)
    assert.equal(first.data.totalPaise, 3000)
    migrateDatabase(t.db) // second run must be a no-op
    assert.equal(t.db.pragma('user_version', { simple: true }), 5)
  } finally {
    t.db.close()
  }
  const reopened = new Database(file)
  try {
    assert.equal(reopened.prepare<[], { c: number }>('SELECT COUNT(*) c FROM invoices').get()?.c, 1)
  } finally {
    reopened.close()
    t.cleanup()
  }
})
