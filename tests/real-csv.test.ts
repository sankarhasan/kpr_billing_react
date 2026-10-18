/**
 * Real-world CSV file test: imports the shop's actual backup file
 * (products_backup_2026-10-17.csv, kept at the repository root) into a
 * throwaway temp database — read-only against the source file.
 * Skips automatically when the file is not present.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { openTempDb } from './_util.ts'
import { migrateDatabase } from '../src/main/db/migrate.ts'
import { importProducts, listProducts } from '../src/main/db/products-repo.ts'
import { parseCsv } from '../src/shared/csv.ts'
import {
  autoDetectProductMapping,
  csvRowToProductInput,
  validateProductInput
} from '../src/shared/products.ts'

const CSV_CANDIDATES = [
  join(import.meta.dirname, '..', 'products_backup_2026-10-17.csv'),
  join(import.meta.dirname, '..', '..', 'products_backup_2026-10-17.csv')
]
const csvPath = CSV_CANDIDATES.find((p) => existsSync(p))

test('real backup CSV imports cleanly', { skip: csvPath ? false : 'CSV file not present' }, () => {
  const content = readFileSync(csvPath!, 'utf8')
  const { headers, rows } = parseCsv(content)
  assert.ok(rows.length > 30, `expected a decent number of rows, got ${rows.length}`)

  const mapping = autoDetectProductMapping(headers)
  assert.equal(mapping['productCode'], 'productCode')
  assert.equal(mapping['stock'], 'ignore')
  assert.equal(mapping['inStock'], 'ignore')

  const items = rows.map((row, i) => {
    const mapped = csvRowToProductInput(row, mapping)
    const shared = validateProductInput(mapped.input)
    // Keep the image data URL alongside the normalized values (main stores it later).
    const input: Record<string, unknown> = {
      ...shared.value,
      ...(typeof mapped.input.imageDataUrl === 'string' ? { imageDataUrl: mapped.input.imageDataUrl } : {})
    }
    return {
      sourceRow: i + 1,
      input,
      rowErrors: { ...mapped.errors, ...shared.errors },
      warnings: mapped.warnings
    }
  })

  const invalid = items.filter((it) => Object.keys(it.rowErrors).length > 0)
  assert.deepEqual(
    invalid.map((it) => ({ row: it.sourceRow, e: it.rowErrors })),
    [],
    'every real-world row should validate'
  )

  // Spot checks against the actual file contents.
  const byCode = new Map(items.map((it) => [it.input.productCode, it]))
  assert.equal(byCode.get('A1')?.input.finalRatePaise, 6000) // ₹300 with 80% OFF
  assert.equal(byCode.get('A1')?.input.greenCracker, true)
  assert.ok(typeof byCode.get('A1')?.input.imageDataUrl === 'string') // data URL passed through
  assert.equal(byCode.get('I1')?.input.finalRatePaise, 249900) // honoured, not recomputed
  assert.equal(byCode.get('I1')?.warnings.length, 1) // mismatch warning present

  // Import into a temp DB inside one transaction.
  const t = openTempDb()
  try {
    migrateDatabase(t.db)
    const res = importProducts(
      t.db,
      items.map((it) => ({ sourceRow: it.sourceRow, input: it.input })),
      'skip'
    )
    assert.ok(res.ok)
    assert.equal(res.data.invalid.length, 0)
    assert.equal(res.data.inserted, items.length)
    assert.equal(res.data.inserted, res.data.requested)

    // Re-import the same file: everything skipped as duplicates.
    const again = importProducts(
      t.db,
      items.map((it) => ({ sourceRow: it.sourceRow, input: it.input })),
      'skip'
    )
    assert.ok(again.ok)
    assert.equal(again.data.inserted, 0)
    assert.equal(again.data.skipped, items.length)

    // Stock data never made it in.
    const first = listProducts(t.db, { pageSize: 1 }).items[0]
    assert.ok(!('stock' in first) && !('quantity' in first))
  } finally {
    t.cleanup()
  }
})
