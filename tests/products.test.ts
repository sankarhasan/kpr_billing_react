/**
 * Unit tests for shared product logic: money parsing, discount math,
 * validation rules and the "no stock tracking" guarantees.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseRupeesToPaise,
  paiseToRupeesString,
  formatPaiseDisplay,
  computeFinalRatePaise,
  validateProductInput,
  autoDetectProductMapping,
  csvRowToProductInput
} from '../src/shared/products.ts'
import { PRODUCTS_V2_TABLE_SQL, PRODUCTS_V2_INDEXES_SQL } from '../src/main/db/schema.ts'

const baseInput = {
  productCode: 'A1',
  productName: 'Test Cracker',
  category: 'A',
  brand: '',
  ratePaise: 30000,
  discountType: 'percent',
  discountPercent: 80,
  discountAmountPaise: 0,
  finalRatePaise: 6000,
  greenCracker: false,
  description: '',
  imagePath: ''
}

// ─── Money ─────────────────────────────────────────────────────────────

test('parseRupeesToPaise accepts plain and decimal rupee strings', () => {
  assert.equal(parseRupeesToPaise('300'), 30000)
  assert.equal(parseRupeesToPaise('120.50'), 12050)
  assert.equal(parseRupeesToPaise(' 0 '), 0)
})

test('parseRupeesToPaise rejects ambiguous or invalid input (never alters silently)', () => {
  assert.equal(parseRupeesToPaise('1,234.50'), null) // thousands separators
  assert.equal(parseRupeesToPaise('-5'), null) // negatives
  assert.equal(parseRupeesToPaise('1.999'), null) // > 2 decimals
  assert.equal(parseRupeesToPaise('abc'), null)
  assert.equal(parseRupeesToPaise(''), null)
  assert.equal(parseRupeesToPaise('₹300'), null)
})

test('paise formatting', () => {
  assert.equal(paiseToRupeesString(30000), '300.00')
  assert.equal(formatPaiseDisplay(6000), '60.00')
  assert.equal(formatPaiseDisplay(123456789), '12,34,567.89')
})

// ─── Discount / final-rate math ────────────────────────────────────────

test('computeFinalRatePaise: percent discounts', () => {
  assert.equal(computeFinalRatePaise(30000, 'percent', 80, 0), 6000) // 300 -> 60
  assert.equal(computeFinalRatePaise(45000, 'percent', 35, 0), 29250) // 450 -> 292.50
  assert.equal(computeFinalRatePaise(10000, 'percent', 100, 0), 0)
})

test('computeFinalRatePaise: amount and none', () => {
  assert.equal(computeFinalRatePaise(10000, 'amount', 0, 500), 9500)
  assert.equal(computeFinalRatePaise(10000, 'none', 0, 0), 10000)
  assert.equal(computeFinalRatePaise(10000, 'amount', 0, 15000), 0) // floored at zero
})

// ─── Validation ────────────────────────────────────────────────────────

test('required fields', () => {
  const { errors } = validateProductInput({ ...baseInput, productCode: '', productName: '  ' })
  assert.ok(errors.productCode)
  assert.ok(errors.productName)
})

test('rejects negative prices and over-100 percentages', () => {
  const neg = validateProductInput({ ...baseInput, ratePaise: -100 })
  assert.ok(neg.errors.ratePaise)
  const pct = validateProductInput({ ...baseInput, discountPercent: 120 })
  assert.ok(pct.errors.discountPercent)
  const nonInt = validateProductInput({ ...baseInput, ratePaise: 10.5 })
  assert.ok(nonInt.errors.ratePaise)
})

test('amount discount cannot exceed rate; final cannot exceed rate', () => {
  const over = validateProductInput({
    ...baseInput,
    discountType: 'amount',
    discountPercent: 0,
    discountAmountPaise: 50000
  })
  assert.ok(over.errors.discountAmountPaise)
  const final = validateProductInput({ ...baseInput, finalRatePaise: 40000 })
  assert.ok(final.errors.finalRatePaise)
})

test('duplicate/invalid codes rejected; valid values normalized with trims', () => {
  const bad = validateProductInput({ ...baseInput, productCode: 'A 1#%' })
  assert.ok(bad.errors.productCode)
  const ok = validateProductInput({ ...baseInput, productCode: ' A1 ', productName: ' Name ' })
  assert.deepEqual(ok.errors, {})
  assert.equal(ok.value.productCode, 'A1')
  assert.equal(ok.value.productName, 'Name')
})

// ─── CSV mapping ───────────────────────────────────────────────────────

test('stock columns are auto-ignored and unknown columns default to ignore', () => {
  const map = autoDetectProductMapping(['stock', 'inStock', 'weirdColumn', 'rate'])
  assert.equal(map.stock, 'ignore')
  assert.equal(map.inStock, 'ignore')
  assert.equal(map.weirdColumn, 'ignore')
  assert.equal(map.rate, 'rate')
})

test('"80% OFF" discount strings map to percent rows', () => {
  const row = csvRowToProductInput(
    {
      code: 'X1',
      name: 'Item',
      rate: '300',
      disc: '80% OFF',
      fin: '60'
    },
    { code: 'productCode', name: 'productName', rate: 'rate', disc: 'discount', fin: 'finalRate' }
  )
  assert.deepEqual(row.errors, {})
  assert.equal(row.input.discountType, 'percent')
  assert.equal(row.input.discountPercent, 80)
  assert.equal(row.input.ratePaise, 30000)
  assert.equal(row.input.finalRatePaise, 6000)
})

test('provided finalRate differing from computed is kept with a warning', () => {
  const row = csvRowToProductInput(
    { code: 'C1', name: 'Combo', rate: '4200', disc: '40% OFF', fin: '2499' },
    { code: 'productCode', name: 'productName', rate: 'rate', disc: 'discount', fin: 'finalRate' }
  )
  assert.deepEqual(row.errors, {})
  assert.equal(row.input.finalRatePaise, 249900) // honoured, not altered
  assert.equal(row.warnings.length, 1)
})

test('percent over 100 in a CSV row is a row error', () => {
  const row = csvRowToProductInput(
    { code: 'B1', name: 'Bad', rate: '100', disc: '150% OFF' },
    { code: 'productCode', name: 'productName', rate: 'rate', disc: 'discount' }
  )
  assert.ok(row.errors.discountPercent)
})

// ─── No-stock guarantee ────────────────────────────────────────────────

test('products schema contains no stock/quantity columns', () => {
  const sql = (PRODUCTS_V2_TABLE_SQL + PRODUCTS_V2_INDEXES_SQL).toLowerCase()
  for (const forbidden of ['stock', 'in_stock', 'instock', 'quantity', 'qty', 'inventory']) {
    assert.ok(!sql.includes(forbidden), `schema must not contain "${forbidden}"`)
  }
})
