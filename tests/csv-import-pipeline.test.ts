/**
 * Headless CSV import-pipeline test — NO native GUI involved.
 * Mirrors exactly what the import wizard does after a file has been chosen
 * (parseCsv -> autoDetectProductMapping -> csvRowToProductInput ->
 * validateProductInput -> importProducts) against a CONTROLLED synthetic CSV
 * in a temporary OS-temp database. The live application database is never
 * opened by this test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openTempDb } from './_util.ts'
import { migrateDatabase } from '../src/main/db/migrate.ts'
import { importProducts, listProducts, getProduct } from '../src/main/db/products-repo.ts'
import { parseCsv, toCsv } from '../src/shared/csv.ts'
import {
  autoDetectProductMapping,
  csvRowToProductInput,
  validateProductInput,
  productToExportRow,
  PRODUCT_EXPORT_HEADERS,
  type ProductCsvField
} from '../src/shared/products.ts'

/**
 * Controlled fixture:
 *  r1  valid, 20% OFF, explicit finalRate matches
 *  r2  valid, quoted comma + escaped quote in name, stock/inStock must be ignored
 *  r3  INVALID: missing name, missing rate
 *  r4  INVALID: discount 150% (> 100)
 *  r5  valid: explicit finalRate 110 differs from computed 111.60 -> preserved + warning
 *  r6  duplicate of r1 code inside the same file
 *  r7  valid: plain-number discount > 100 treated as amount (₹150)
 */
const FIXTURE_HEADERS = [
  'productCode',
  'productName',
  'category',
  'rate',
  'discount',
  'finalRate',
  'stock',
  'inStock',
  'brand',
  'greenCracker',
  'description',
  'image'
]

// Built with the tested serializer so every row has exactly 12 fields.
const CSV_TEXT =
  '\ufeff' +
  toCsv(FIXTURE_HEADERS, [
    ['P1', 'Anchor A', 'A', '100', '20% OFF', '80', '1 Box / 10 Pcs', 'Yes', 'SUPREME', 'Yes', 'first', ''],
    ['P2', 'Combo, "best"', 'B', '200', '10% OFF', '180', '1 Box / 5 Pcs', 'Yes', '', '', '', ''],
    ['P3', '', 'C', '', '10% OFF', '', '1 Box', 'Yes', '', '', '', ''],
    ['P4', 'Bad Discount', 'D', '50', '150% OFF', '', '1 Box', 'Yes', '', '', '', ''],
    ['P5', 'Rounded Final', 'E', '180', '38% OFF', '110', '1 Box', 'Yes', '', '', 'note', ''],
    ['P1', 'Duplicate Of P1', 'A', '100', '20% OFF', '80', '1 Box', 'Yes', '', '', '', ''],
    ['P7', 'Amount Discount', 'F', '300', '150', '150', '1 Box', 'Yes', '', 'Yes', '', '']
  ])

/** The same evaluation the wizard's "Preview rows" step performs. */
function evaluateWizardStyle(csvText: string) {
  const { headers, rows } = parseCsv(csvText)
  const mapping = autoDetectProductMapping(headers)
  const evaluated = rows.map((row, i) => {
    const mapped = csvRowToProductInput(row, mapping)
    const shared = validateProductInput(mapped.input)
    const errors = { ...mapped.errors, ...shared.errors }
    return { sourceRow: i + 1, input: { ...shared.value }, errors, warnings: mapped.warnings }
  })
  const valid = evaluated.filter((e) => Object.keys(e.errors).length === 0)
  const invalid = evaluated.filter((e) => Object.keys(e.errors).length > 0)
  return { headers, mapping, evaluated, valid, invalid }
}

test('wizard-style evaluation classifies the controlled CSV correctly', () => {
  const { mapping, valid, invalid, evaluated } = evaluateWizardStyle(CSV_TEXT)

  assert.equal(mapping['stock'], 'ignore')
  assert.equal(mapping['inStock'], 'ignore')
  assert.equal(evaluated.length, 7)
  // r1, r2, r5, r7 valid; r3, r4, r6 invalid at row level? r6 is a duplicate of r1
  // (duplicate-within-file is detected by the IMPORTER, not the row evaluator,
  //  so r6 passes row validation and is reported during import).
  assert.equal(invalid.length, 2, `unexpected invalid rows: ${JSON.stringify(invalid)}`)
  assert.deepEqual(
    invalid.map((r) => r.sourceRow),
    [3, 4]
  )
  assert.ok(invalid[0].errors.productName)
  assert.ok(invalid[0].errors.ratePaise)
  assert.ok(invalid[1].errors.discountPercent)

  const r5 = evaluated.find((e) => e.sourceRow === 5)!
  assert.equal(r5.input.finalRatePaise, 11000, 'explicit finalRate must be preserved')
  assert.equal(r5.warnings.length, 1, 'mismatch warning expected')
})

test('import into temp DB: counts, duplicate-within-file, strategies', () => {
  const t = openTempDb()
  try {
    migrateDatabase(t.db)
    const { valid } = evaluateWizardStyle(CSV_TEXT)

    // Skip strategy: r6 (duplicate of P1 inside file) is reported, others insert.
    const res = importProducts(
      t.db,
      valid.map((v) => ({ sourceRow: v.sourceRow, input: v.input })),
      'skip'
    )
    assert.ok(res.ok)
    assert.equal(res.data.requested, 5)
    assert.equal(res.data.inserted, 4)
    assert.equal(res.data.invalid.length, 1)
    assert.match(res.data.invalid[0].message, /more than once in the file/)

    const p7 = listProducts(t.db, { search: 'P7' }).items[0]
    assert.equal(p7.discountType, 'amount')
    assert.equal(p7.discountAmountPaise, 15000)
    assert.equal(p7.finalRatePaise, 15000)
    assert.equal(p7.greenCracker, true)

    // Re-import with update strategy: P1 updates, others insert/skip cleanly.
    const upd = importProducts(
      t.db,
      valid.map((v) => ({ sourceRow: v.sourceRow, input: { ...v.input, productName: v.input.productName + '!' } })),
      'update'
    )
    assert.ok(upd.ok)
    assert.equal(upd.data.updated, 4) // P1, P2, P5, P7 all exist now
    assert.equal(upd.data.invalid.length, 1) // r6 duplicate-in-file again
    assert.equal(getProduct(t.db, 1)?.productName, 'Anchor A!')
  } finally {
    t.cleanup()
  }
})

test('export -> re-import round trip preserves every supported field', () => {
  const t1 = openTempDb()
  const t2 = openTempDb()
  try {
    migrateDatabase(t1.db)
    migrateDatabase(t2.db)
    const { valid } = evaluateWizardStyle(CSV_TEXT)
    const imp = importProducts(
      t1.db,
      valid.map((v) => ({ sourceRow: v.sourceRow, input: v.input })),
      'skip'
    )
    assert.ok(imp.ok)

    const items = listProducts(t1.db, { pageSize: 100 }).items
    const csv = toCsv(
      PRODUCT_EXPORT_HEADERS,
      items.map(productToExportRow)
    )
    // Export must never contain stock columns.
    assert.ok(!/stock/i.test(csv.split('\r\n')[0]))

    const mapping = autoDetectProductMapping(parseCsv(csv).headers)
    const reEval = parseCsv(csv).rows.map((row, i) => {
      const m = csvRowToProductInput(row, mapping)
      return { sourceRow: i + 1, input: { ...validateProductInput(m.input).value } }
    })
    const re = importProducts(t2.db, reEval, 'skip')
    assert.ok(re.ok)
    assert.equal(re.data.inserted, items.length)
    assert.equal(re.data.invalid.length, 0)

    const orig = listProducts(t1.db, { pageSize: 100 }).items
    const rt = listProducts(t2.db, { pageSize: 100 }).items
    for (let i = 0; i < orig.length; i++) {
      assert.equal(rt[i].productCode, orig[i].productCode)
      assert.equal(rt[i].productName, orig[i].productName)
      assert.equal(rt[i].ratePaise, orig[i].ratePaise)
      assert.equal(rt[i].discountType, orig[i].discountType)
      assert.equal(rt[i].discountPercent, orig[i].discountPercent)
      assert.equal(rt[i].discountAmountPaise, orig[i].discountAmountPaise)
      assert.equal(rt[i].finalRatePaise, orig[i].finalRatePaise)
      assert.equal(rt[i].greenCracker, orig[i].greenCracker)
      assert.equal(rt[i].description, orig[i].description)
    }
  } finally {
    t1.cleanup()
    t2.cleanup()
  }
})

test('no stock/quantity data survives the pipeline', () => {
  const t = openTempDb()
  try {
    migrateDatabase(t.db)
    const { valid } = evaluateWizardStyle(CSV_TEXT)
    const res = importProducts(
      t.db,
      valid.map((v) => ({ sourceRow: v.sourceRow, input: v.input })),
      'skip'
    )
    assert.ok(res.ok)
    const cols = (t.db.pragma('table_info(products)') as { name: string }[]).map((c) => c.name)
    assert.ok(!cols.some((c) => /stock|quant|qty/i.test(c)), `forbidden columns: ${cols}`)
  } finally {
    t.cleanup()
  }
})
