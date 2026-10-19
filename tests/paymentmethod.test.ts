/**
 * Cash/UPI payment method tests — throwaway OS-temp databases only.
 * Covers: main-process validation (only CASH/UPI accepted, case-insensitive
 * input, CASH compatibility default, unknown values REJECTED), transactional
 * persistence, reopening saved invoices returns the chosen method, payment
 * choice NEVER affects money fields, print-document display (including
 * legacy 'cash' rows and unknown legacy values shown as 'Not recorded',
 * never falsely as UPI), and backup/restore compatibility of payment_mode.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { openTempDb } from './_util.ts'
import { migrateDatabase } from '../src/main/db/migrate.ts'
import { createInvoice, getInvoice, searchInvoice } from '../src/main/db/invoices-repo.ts'
import { createProduct } from '../src/main/db/products-repo.ts'
import { validateInvoiceInput, normalizePaymentMethod } from '../src/shared/invoices.ts'
import { buildPrintDocument, DEFAULT_PRINT_INFO } from '../src/shared/print.ts'
import { copyFileAtomic, removeSidecars } from '../src/main/db/backup.ts'

function setup() {
  const t = openTempDb()
  migrateDatabase(t.db)
  return t
}

type Temp = ReturnType<typeof setup>

let seq = 0
function seedProduct(t: Temp): number {
  seq += 1
  const res = createProduct(t.db, {
    productCode: `PM${seq}`,
    productName: `Payment Product ${seq}`,
    category: 'A',
    brand: '',
    ratePaise: 12000,
    discountType: 'none',
    discountPercent: 0,
    discountAmountPaise: 0,
    finalRatePaise: 12000,
    greenCracker: false,
    description: '',
    imagePath: ''
  })
  assert.ok(res.ok)
  return res.data.id
}

// ─── Shared validation ─────────────────────────────────────────────────

test('validateInvoiceInput: CASH/UPI accepted (case-insensitive), others rejected, CASH default', () => {
  const line = { productId: 1, quantity: 1 }
  assert.equal(validateInvoiceInput({ customerId: null, lines: [line] }).value.paymentMethod, 'CASH')
  assert.equal(validateInvoiceInput({ customerId: null, lines: [line], paymentMethod: 'UPI' }).value.paymentMethod, 'UPI')
  assert.equal(validateInvoiceInput({ customerId: null, lines: [line], paymentMethod: ' upi ' }).value.paymentMethod, 'UPI')
  assert.equal(validateInvoiceInput({ customerId: null, lines: [line], paymentMethod: 'cash' }).value.paymentMethod, 'CASH')

  const bad = validateInvoiceInput({ customerId: null, lines: [line], paymentMethod: 'BITCOIN' })
  assert.ok(bad.errors.paymentMethod)
  const nonString = validateInvoiceInput({ customerId: null, lines: [line], paymentMethod: 42 })
  assert.ok(nonString.errors.paymentMethod)
})

test('normalizePaymentMethod maps stored values truthfully; unknown never becomes UPI', () => {
  assert.equal(normalizePaymentMethod('cash'), 'CASH')
  assert.equal(normalizePaymentMethod('CASH'), 'CASH')
  assert.equal(normalizePaymentMethod('upi'), 'UPI')
  assert.equal(normalizePaymentMethod('credit'), null)
  assert.equal(normalizePaymentMethod(''), null)
  assert.equal(normalizePaymentMethod(undefined), null)
})

// ─── Persistence through the real save flow ────────────────────────────

test('CASH and UPI persist on the invoice row and survive reopen', () => {
  const t = setup()
  try {
    const p = seedProduct(t)
    const cash = createInvoice(t.db, { customerId: null, lines: [{ productId: p, quantity: 1 }], notes: '', paymentMethod: 'CASH' })
    const upi = createInvoice(t.db, { customerId: null, lines: [{ productId: p, quantity: 2 }], notes: '', paymentMethod: 'UPI' })
    assert.ok(cash.ok && upi.ok)
    assert.equal(cash.data.paymentMode, 'CASH')
    assert.equal(upi.data.paymentMode, 'UPI')

    // reopen from the DB (Sales History path)
    assert.equal(getInvoice(t.db, upi.data.id)!.paymentMode, 'UPI')
    const byNumber = searchInvoice(t.db, upi.data.invoiceNumber)
    assert.ok(byNumber.ok)
    assert.equal(byNumber.data.paymentMode, 'UPI')
  } finally {
    t.cleanup()
  }
})

test('unsupported payment methods are rejected at the main boundary and save nothing', () => {
  const t = setup()
  try {
    const p = seedProduct(t)
    const res = createInvoice(t.db, { customerId: null, lines: [{ productId: p, quantity: 1 }], notes: '', paymentMethod: 'WALLET' })
    assert.ok(!res.ok)
    assert.equal(res.error.code, 'VALIDATION')
    assert.ok(res.error.fields?.paymentMethod)
    assert.equal(t.db.prepare<[], { c: number }>('SELECT COUNT(*) c FROM invoices').get()?.c, 0)
  } finally {
    t.cleanup()
  }
})

test('payment method NEVER changes money: same lines yield identical totals for CASH and UPI', () => {
  const t = setup()
  try {
    const p = seedProduct(t)
    const a = createInvoice(t.db, { customerId: null, lines: [{ productId: p, quantity: 3 }], notes: '', paymentMethod: 'CASH' })
    const b = createInvoice(t.db, { customerId: null, lines: [{ productId: p, quantity: 3 }], notes: '', paymentMethod: 'UPI' })
    assert.ok(a.ok && b.ok)
    for (const key of ['subtotalPaise', 'discountPaise', 'roundOffPaise', 'taxAmountPaise', 'totalPaise'] as const) {
      assert.equal(a.data[key], b.data[key])
    }
    assert.equal(a.data.lines[0].lineTotalPaise, b.data.lines[0].lineTotalPaise)
  } finally {
    t.cleanup()
  }
})

// ─── Printing display ──────────────────────────────────────────────────

test('A4/receipt document model shows the SAVED method, and legacy unknown shows Not recorded', () => {
  const t = setup()
  try {
    const p = seedProduct(t)
    const upi = createInvoice(t.db, { customerId: null, lines: [{ productId: p, quantity: 1 }], notes: '', paymentMethod: 'UPI' })
    assert.ok(upi.ok)
    const docUpi = buildPrintDocument(getInvoice(t.db, upi.data.id)!, DEFAULT_PRINT_INFO)
    assert.equal(docUpi.paymentMethodDisplay, 'UPI')

    const cash = createInvoice(t.db, { customerId: null, lines: [{ productId: p, quantity: 1 }], notes: '', paymentMethod: 'CASH' })
    assert.ok(cash.ok)
    assert.equal(buildPrintDocument(cash.data, DEFAULT_PRINT_INFO).paymentMethodDisplay, 'CASH')

    // legacy row whose payment_mode is an unrecognized value (pre-feature junk data)
    t.db
      .prepare(`INSERT INTO invoices (invoice_number, customer_name, payment_mode) VALUES ('LGC-9', 'Old', 'credit')`)
      .run()
    const legacyRow = t.db.prepare<[], { id: number }>(`SELECT id FROM invoices WHERE invoice_number = 'LGC-9'`).get()!
    const docLegacy = buildPrintDocument(getInvoice(t.db, legacyRow.id)!, DEFAULT_PRINT_INFO)
    assert.equal(docLegacy.paymentMethodDisplay, 'Not recorded', 'unknown legacy method is never guessed as UPI')
  } finally {
    t.cleanup()
  }
})

// ─── Backup / restore compatibility ────────────────────────────────────

test('backup + restore round-trips invoices WITH their payment methods', () => {
  const t = setup()
  const liveFile = join(t.dir, 'test.db')
  try {
    const p = seedProduct(t)
    const upi = createInvoice(t.db, { customerId: null, lines: [{ productId: p, quantity: 1 }], notes: '', paymentMethod: 'UPI' })
    assert.ok(upi.ok)
    t.db.pragma('wal_checkpoint(TRUNCATE)')

    // simulate: make a backup copy, change the live db, restore the backup
    const backupFile = join(t.dir, 'backup.db')
    copyFileAtomic(liveFile, backupFile)
    const later = createInvoice(t.db, { customerId: null, lines: [{ productId: p, quantity: 1 }], notes: '', paymentMethod: 'CASH' })
    assert.ok(later.ok)
    t.db.close()

    copyFileAtomic(backupFile, liveFile)
    removeSidecars(liveFile)
    const reopened = new Database(liveFile)
    try {
      migrateDatabase(reopened) // same additive path the app uses after restore
      const inv = getInvoice(reopened, upi.data.id)
      assert.ok(inv, 'the backed-up invoice exists again after restore')
      assert.equal(inv.paymentMode, 'UPI', 'payment method restored from the backup')
      assert.equal(inv.totalPaise, 12000, 'snapshot money unchanged by restore')
      // the post-backup invoice is gone again — the restore replaced the file
      assert.equal(getInvoice(reopened, later.data.id), null)
    } finally {
      reopened.close()
    }
  } finally {
    try {
      t.db.close()
    } catch {
      /* already closed */
    }
    t.cleanup()
  }
})

// ─── Historical immutability ───────────────────────────────────────────

test('payment feature leaves historical rows and legacy defaults untouched', () => {
  const t = setup()
  try {
    // legacy-style direct insert without payment_mode → column default 'cash'
    t.db
      .prepare(`INSERT INTO invoices (invoice_number, customer_name, subtotal_paise, total_paise) VALUES ('KPR-77', 'Old Timers', 5000, 5000)`)
      .run()
    const row = t.db.prepare<[], { id: number; payment_mode: string }>(`SELECT id, payment_mode FROM invoices WHERE invoice_number = 'KPR-77'`).get()!
    assert.equal(row.payment_mode, 'cash', 'legacy default preserved in the DB')

    const legacy = getInvoice(t.db, row.id)!
    assert.equal(legacy.paymentMode, 'cash', 'read-back keeps the stored legacy value')

    // no migration rewrote or deleted anything
    assert.equal(t.db.pragma('user_version', { simple: true }), 5, 'no new schema version was needed')
  } finally {
    t.cleanup()
  }
})
