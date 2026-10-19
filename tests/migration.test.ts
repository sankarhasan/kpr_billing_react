/**
 * Migration tests: Phase 1 (v1) databases upgrade to v2 with data preserved;
 * fresh databases receive the v2 schema directly; the runner is idempotent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openTempDb } from './_util.ts'
import { migrateDatabase } from '../src/main/db/migrate.ts'
import { LEGACY_SCHEMA_V1_SQL } from '../src/main/db/schema.ts'

function columns(db: { pragma: (s: string) => unknown }): string[] {
  return (db.pragma('table_info(products)') as { name: string }[]).map((c) => c.name)
}

test('fresh database gets the v2 products schema', () => {
  const t = openTempDb()
  try {
    migrateDatabase(t.db)
    assert.deepEqual(
      columns(t.db).slice().sort(),
      [
        'brand',
        'category',
        'created_at',
        'description',
        'discount_amount_paise',
        'discount_percent',
        'discount_type',
        'final_rate_paise',
        'green_cracker',
        'id',
        'image_path',
        'is_active',
        'product_code',
        'product_name',
        'rate_paise',
        'updated_at'
      ].sort()
    )
    assert.equal(t.db.pragma('user_version', { simple: true }), 5)
  } finally {
    t.cleanup()
  }
})

test('v1 databases migrate with data preserved', () => {
  const t = openTempDb()
  try {
    // Build a Phase 1 database, then add real-world style rows.
    t.db.exec(LEGACY_SCHEMA_V1_SQL)
    t.db
      .prepare('INSERT INTO products (name, category, sale_price, is_active) VALUES (?, ?, ?, ?)')
      .run('Old Chakkar', 'X', 450.5, 1)
    t.db
      .prepare('INSERT INTO products (name, category, sale_price, is_active) VALUES (?, ?, ?, ?)')
      .run('Retired Item', 'Y', 99, 0)

    // Invoice history referencing product 2.
    t.db.exec(`
      INSERT INTO invoices (id, invoice_number) VALUES (1, 'INV-1');
      INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price, line_total)
      VALUES (1, 2, 'Retired Item', 1, 99, 99);
    `)

    migrateDatabase(t.db)

    assert.ok(columns(t.db).includes('product_code'))
    const rows = t.db.prepare('SELECT * FROM products ORDER BY id').all() as Record<
      string,
      unknown
    >[]
    assert.equal(rows.length, 2)
    assert.equal(rows[0].product_code, 'P1')
    assert.equal(rows[0].product_name, 'Old Chakkar')
    assert.equal(rows[0].category, 'X')
    assert.equal(rows[0].rate_paise, 45050) // REAL rupees -> integer paise
    assert.equal(rows[0].final_rate_paise, 45050)
    assert.equal(rows[1].is_active, 0)

    // Invoice references survived the rebuild.
    const refs = t.db
      .prepare('SELECT product_id FROM invoice_items WHERE invoice_id = 1')
      .all() as { product_id: number }[]
    assert.equal(refs[0].product_id, 2)

    // Settings defaults present, GST disabled.
    const tax = t.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('tax_enabled') as { value: string }
    assert.equal(tax.value, '0')
  } finally {
    t.cleanup()
  }
})

test('migration is idempotent', () => {
  const t = openTempDb()
  try {
    migrateDatabase(t.db)
    migrateDatabase(t.db)
    assert.equal(
      t.db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM products').get()?.c,
      0
    )
  } finally {
    t.cleanup()
  }
})
