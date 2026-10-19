/**
 * Phase 6 print/PDF tests — pure helpers + saved-snapshot behaviour, all on
 * throwaway OS-temp databases. Physical printing and native dialogs cannot
 * run headless, so tests target every layer ABOVE them: request validation,
 * format selection, filename safety, the document model built from stored
 * snapshots, and the read-only guarantee for preview/print/export.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openTempDb } from './_util.ts'
import { migrateDatabase } from '../src/main/db/migrate.ts'
import { createInvoice, getInvoice, getInvoiceByNumber, reserveInvoiceNumber } from '../src/main/db/invoices-repo.ts'
import { createProduct } from '../src/main/db/products-repo.ts'
import { getPrintInfo } from '../src/main/db/settings-repo.ts'
import {
  buildPrintDocument,
  cssPageSize,
  describePrintOutcome,
  parsePrintQuery,
  pdfPageSizeInches,
  safePdfFileName,
  validatePrintWindowRequest,
  DEFAULT_PRINT_INFO,
  type PrintInfo
} from '../src/shared/print.ts'

function setup() {
  const t = openTempDb()
  migrateDatabase(t.db)
  return t
}

type Temp = ReturnType<typeof setup>

let pseq = 0

function seedProduct(t: Temp, code: string, finalPaise: number, ratePaise: number) {
  const res = createProduct(t.db, {
    productCode: code,
    productName: `Print Product ${code}`,
    category: 'A',
    brand: '',
    ratePaise,
    discountType: 'percent',
    discountPercent: Math.round(((ratePaise - finalPaise) / ratePaise) * 100),
    discountAmountPaise: 0,
    finalRatePaise: finalPaise,
    greenCracker: false,
    description: '',
    imagePath: ''
  })
  assert.ok(res.ok, 'seed product must succeed')
  return res.data
}

const INFO: PrintInfo = {
  ...DEFAULT_PRINT_INFO,
  shopName: 'KPR Firecrackers',
  shopAddress: '45 Crackers Road, Deepavali Nagar',
  shopPhone: '98765 43210',
  shopPhoneAlt: '044 123 4567',
  shopEmail: 'orders@kprfirecrackers.example',
  gstin: '33ABCDE1234F1Z5',
  receiptFooter: 'Thank you for shopping with us!'
}

// ─── Request validation (security boundary) ────────────────────────────

test('validatePrintWindowRequest accepts only whitelisted ids/formats/modes', () => {
  const ok = validatePrintWindowRequest({ invoiceId: 42, format: 'a4', mode: 'print' })
  assert.ok(ok.ok)
  assert.deepEqual(ok.value, { invoiceId: 42, format: 'a4', mode: 'print' })

  assert.ok(!validatePrintWindowRequest({ invoiceId: 0, format: 'a4' }).ok)
  assert.ok(!validatePrintWindowRequest({ invoiceId: -5, format: 'a4' }).ok)
  assert.ok(!validatePrintWindowRequest({ invoiceId: 1.5, format: 'a4' }).ok)
  assert.ok(!validatePrintWindowRequest({ invoiceId: '42', format: 'a4' }).ok)
  assert.ok(!validatePrintWindowRequest({ invoiceId: 42, format: 'legal' }).ok)
  assert.ok(!validatePrintWindowRequest({ invoiceId: 42, format: 'a4', mode: 'delete' }).ok)
  assert.ok(!validatePrintWindowRequest({ invoiceId: 42, format: 'file:///C:/evil.html' }).ok)
  assert.ok(!validatePrintWindowRequest(null).ok)
})

test('validatePrintWindowRequest defaults to the safe preview mode', () => {
  const res = validatePrintWindowRequest({ invoiceId: 7, format: 'receipt' })
  assert.ok(res.ok)
  assert.equal(res.value.mode, 'preview')
})

test('parsePrintQuery recognises only main-built print URLs', () => {
  assert.deepEqual(parsePrintQuery('?print=1&invoiceId=12&format=receipt&mode=pdf'), {
    invoiceId: 12,
    format: 'receipt',
    mode: 'pdf'
  })
  assert.equal(parsePrintQuery(''), null)
  assert.equal(parsePrintQuery('?invoiceId=12&format=a4'), null) // no print=1
  assert.equal(parsePrintQuery('?print=1&invoiceId=12&format=a4x'), null) // bad format
  assert.equal(parsePrintQuery('?print=1&invoiceId=0&format=a4'), null) // bad id
  assert.equal(parsePrintQuery('?print=1&invoiceId=3&format=a4&mode=DROP'), null) // bad mode
})

// ─── Format selection ──────────────────────────────────────────────────

test('A4 vs receipt geometry selection is explicit and sane', () => {
  const a4 = pdfPageSizeInches('a4')
  const receipt = pdfPageSizeInches('receipt')
  assert.ok(Math.abs(a4.width - 8.2677) < 0.01 && Math.abs(a4.height - 11.6929) < 0.01)
  assert.ok(Math.abs(receipt.width - 3.1496) < 0.01, 'receipt is 80mm wide')
  assert.ok(receipt.width < a4.width)
  assert.equal(cssPageSize('a4'), 'A4')
  assert.equal(cssPageSize('receipt'), '80mm auto')
})

// ─── Safe filenames ────────────────────────────────────────────────────

test('safePdfFileName sanitizes invalid characters but keeps real numbers', () => {
  assert.equal(safePdfFileName('KPR-INV-1234'), 'KPR-INV-1234.pdf')
  assert.equal(safePdfFileName('KPR-1'), 'KPR-1.pdf') // legacy
  assert.equal(safePdfFileName('KPR/12:05'), 'KPR-12-05.pdf') // illegal : and /
  assert.equal(safePdfFileName('a*b?c"d<e>f|g'), 'a-b-c-d-e-f-g.pdf')
  assert.equal(safePdfFileName('  spaced  name  '), 'spaced-name.pdf')
  assert.equal(safePdfFileName('../../etc/passwd'), 'etc-passwd.pdf') // traversal neutered
  assert.equal(safePdfFileName('...'), 'invoice.pdf')
  assert.equal(safePdfFileName(''), 'invoice.pdf')
  assert.equal(safePdfFileName(undefined), 'invoice.pdf')
  assert.equal(safePdfFileName('x'.repeat(200)).length, 84) // 80 + '.pdf'
  assert.ok(!safePdfFileName('bad\x00name').includes('\x00'))
  assert.equal(safePdfFileName('END.'), 'END.pdf') // no trailing dot before ext
})

// ─── Document model from STORED snapshots ──────────────────────────────

test('buildPrintDocument uses stored totals, snapshot prices and formatted date', () => {
  const t = setup()
  try {
    const p = seedProduct(t, 'PP1', 4000, 10000) // 60% off
    const draft = reserveInvoiceNumber(t.db)
    const res = createInvoice(t.db, {
      customerId: null,
      customerName: 'Ramesh',
      customerPhone: '9876543210',
      customerAddress: '12 Sparkle Street',
      lines: [{ productId: p.id, quantity: 3 }],
      notes: 'Deliver before 6pm',
      draftNumber: draft
    })
    assert.ok(res.ok)
    t.db.prepare('UPDATE invoices SET invoice_date = ? WHERE id = ?').run('2026-10-19 14:30:00', res.data.id)

    const invoice = getInvoiceByNumber(t.db, draft)!
    const doc = buildPrintDocument(invoice, INFO)

    assert.equal(doc.invoiceNumber, draft)
    assert.equal(doc.dateTimeDisplay, '19-10-2026 02:30 PM')
    assert.equal(doc.customerName, 'Ramesh')
    assert.equal(doc.customerPhone, '9876543210')
    assert.equal(doc.customerAddress, '12 Sparkle Street')
    assert.equal(doc.shopName, 'KPR Firecrackers')
    assert.equal(doc.footerMessage, 'Thank you for shopping with us!')

    const line = doc.lines[0]
    assert.equal(line.serial, 1)
    assert.equal(line.productCode, 'PP1')
    assert.equal(line.quantity, 3)
    assert.equal(line.rateDisplay, '₹100.00') // original snapshot rate
    assert.equal(line.discountDisplay, '₹60.00') // per-unit snapshot discount
    assert.equal(line.finalRateDisplay, '₹40.00')
    assert.equal(line.amountDisplay, '₹120.00') // stored line total

    // stored header totals, not recomputed
    assert.equal(doc.subtotalDisplay, '₹300.00')
    assert.equal(doc.discountDisplay, '₹180.00')
    assert.equal(doc.totalDisplay, '₹120.00')
    assert.equal(doc.hasRoundOff, false)
    assert.equal(doc.taxDisplay, null, 'GST disabled → never printed')
    assert.equal(doc.notes, 'Deliver before 6pm')
    assert.equal(doc.hasAnyDiscount, true)

    // Phase 7: CURRENT shop details ride along on every print document
    assert.equal(doc.shopAddress, '45 Crackers Road, Deepavali Nagar')
    assert.equal(doc.shopPhone, '98765 43210')
    assert.equal(doc.shopPhoneAlt, '044 123 4567')
    assert.equal(doc.shopEmail, 'orders@kprfirecrackers.example')
    assert.equal(doc.shopGstin, '33ABCDE1234F1Z5')

    // Phase 8: payment method from the SAVED invoice (default CASH)
    assert.equal(doc.paymentMethodDisplay, 'CASH')
  } finally {
    t.cleanup()
  }
})

test('legacy invoice renders with empty product code and optional fields omitted', () => {
  const t = setup()
  try {
    t.db
      .prepare(
        `INSERT INTO invoices (invoice_number, customer_name, invoice_date, subtotal_paise, discount_paise, total_paise)
         VALUES ('KPR-3', 'Walk-in Customer', '2026-10-01 09:05:00', 5000, 0, 5000)`
      )
      .run()
    t.db
      .prepare(
        `INSERT INTO invoice_items (invoice_id, product_name, quantity, unit_price_paise, line_total_paise, original_rate_paise)
         VALUES (1, 'Old Item With A Extremely Long Name That Must Wrap Instead Of Overflowing The A4 Page', 2, 2500, 5000, 2500)`
      )
      .run()

    const invoice = getInvoice(t.db, 1)!
    const doc = buildPrintDocument(invoice, { ...DEFAULT_PRINT_INFO, shopName: '', receiptFooter: '' })
    assert.equal(doc.invoiceNumber, 'KPR-3')
    assert.equal(doc.customerPhone, '')
    assert.equal(doc.customerAddress, '')
    assert.equal(doc.lines[0].productCode, '', 'legacy snapshot has no code')
    assert.equal(doc.lines[0].discountDisplay, null)
    assert.equal(doc.hasAnyDiscount, false)
    assert.equal(doc.lines[0].productName.length > 60, true, 'long name preserved verbatim')
    assert.equal(doc.shopName, 'KPR Firecrackers', 'blank setting falls back to the shop default')
    assert.equal(doc.shopEmail, '', 'unconfigured email is omitted — never a placeholder')
    assert.equal(doc.footerMessage, '')
    assert.equal(doc.paymentMethodDisplay, 'CASH', "legacy stored 'cash' truthfully displays CASH")
  } finally {
    t.cleanup()
  }
})

test('round-off is shown when present and signed amounts stay readable', () => {
  const t = setup()
  try {
    t.db
      .prepare("INSERT INTO settings (key, value) VALUES ('round_off_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'")
      .run()
    const p = seedProduct(t, 'PR2', 3345, 10000)
    const res = createInvoice(t.db, { customerId: null, lines: [{ productId: p.id, quantity: 1 }], notes: '' })
    assert.ok(res.ok)
    const doc = buildPrintDocument(res.data, INFO)
    assert.equal(doc.hasRoundOff, true)
    assert.equal(doc.roundOffDisplay, '-₹0.45') // 3345 -> 3300
    assert.equal(doc.totalDisplay, '₹33.00')
  } finally {
    t.cleanup()
  }
})

test('multi-line invoices get sequential serials', () => {
  const t = setup()
  try {
    const a = seedProduct(t, 'PA', 1000, 2000)
    const b = seedProduct(t, 'PB', 5000, 5000)
    const res = createInvoice(t.db, {
      customerId: null,
      lines: [
        { productId: a.id, quantity: 2 },
        { productId: b.id, quantity: 1 }
      ],
      notes: ''
    })
    assert.ok(res.ok)
    const doc = buildPrintDocument(res.data, INFO)
    assert.deepEqual(doc.lines.map((l) => l.serial), [1, 2])
    assert.deepEqual(doc.lines.map((l) => l.amountDisplay), ['₹20.00', '₹50.00'])
  } finally {
    t.cleanup()
  }
})

// ─── Historical safety: read-only guarantees ───────────────────────────

test('document building and print-info reads never mutate the database', () => {
  const t = setup()
  try {
    const p = seedProduct(t, 'PM1', 4000, 10000)
    const res = createInvoice(t.db, { customerId: null, lines: [{ productId: p.id, quantity: 3 }], notes: '' })
    assert.ok(res.ok)
    const before = JSON.stringify(getInvoice(t.db, res.data.id))
    const counts = () =>
      t.db
        .prepare<[], { i: number; n: number; s: number }>(
          `SELECT (SELECT COUNT(*) FROM invoices) i, (SELECT COUNT(*) FROM invoice_items) n, (SELECT COUNT(*) FROM settings) s`
        )
        .get()!

    const snapshotCounts = JSON.stringify(counts())
    const info = getPrintInfo(t.db)
    buildPrintDocument(getInvoice(t.db, res.data.id)!, info)
    buildPrintDocument(getInvoice(t.db, res.data.id)!, info)

    assert.equal(JSON.stringify(getInvoice(t.db, res.data.id)), before, 'invoice bytes unchanged')
    assert.equal(JSON.stringify(counts()), snapshotCounts, 'no rows added/removed')

    // later product price revision must not leak into the printable document
    t.db.prepare('UPDATE products SET final_rate_paise = 999999, rate_paise = 999999').run()
    const doc = buildPrintDocument(getInvoice(t.db, res.data.id)!, info)
    assert.equal(doc.lines[0].finalRateDisplay, '₹40.00', 'snapshot price printed, not current price')
    assert.equal(doc.totalDisplay, '₹120.00')
  } finally {
    t.cleanup()
  }
})

test('getPrintInfo reflects configured settings and defaults when unset', () => {
  const t = setup()
  try {
    const d = getPrintInfo(t.db)
    assert.equal(d.shopName, 'KPR Firecrackers')
    assert.equal(d.receiptFooter, 'Thank you for shopping with us!')

    t.db.prepare("UPDATE settings SET value = 'KPR Fireworks Mart' WHERE key = 'shop_name'").run()
    t.db.prepare("UPDATE settings SET value = '' WHERE key = 'receipt_footer'").run()
    const u = getPrintInfo(t.db)
    assert.equal(u.shopName, 'KPR Fireworks Mart')
    assert.equal(u.receiptFooter, '')
  } finally {
    t.cleanup()
  }
})

// ─── Outcome presentation ──────────────────────────────────────────────

test('describePrintOutcome maps every result shape to a clear message', () => {
  assert.equal(describePrintOutcome({ ok: true, data: { filePath: 'C:\\d\\KPR-INV-1.pdf' } }), 'PDF saved to C:\\d\\KPR-INV-1.pdf')
  assert.equal(describePrintOutcome({ ok: true, data: { printed: true } }), 'Print dialog completed — job sent to the printer.')
  assert.equal(describePrintOutcome({ ok: true, data: {} }), 'Invoice preview opened.')
  assert.equal(describePrintOutcome({ ok: false, error: { code: 'CANCELLED', message: 'PDF save was cancelled.' } }), 'PDF save was cancelled.')
})
