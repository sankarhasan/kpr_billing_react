/**
 * Repository tests: CRUD, duplicate handling, search/pagination,
 * safe delete/archive, bulk import, transaction rollback, no stock columns.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { openTempDb } from './_util.ts'
import { migrateDatabase } from '../src/main/db/migrate.ts'
import {
  createProduct,
  updateProduct,
  deleteProduct,
  getProduct,
  listProducts,
  listCategories,
  importProducts
} from '../src/main/db/products-repo.ts'

function setup() {
  const t = openTempDb()
  migrateDatabase(t.db)
  return t
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productCode: 'A1',
    productName: 'Sparkler 10cm',
    category: 'A',
    brand: 'SUPREME',
    ratePaise: 10000,
    discountType: 'percent',
    discountPercent: 80,
    discountAmountPaise: 0,
    finalRatePaise: 2000,
    greenCracker: true,
    description: 'Hand-held sparkler',
    imagePath: '',
    ...overrides
  }
}

// ─── Creation & validation ─────────────────────────────────────────────

test('create + getById round trip', () => {
  const t = setup()
  try {
    const res = createProduct(t.db, input())
    assert.ok(res.ok)
    assert.equal(res.data.productCode, 'A1')
    assert.equal(res.data.finalRatePaise, 2000)
    assert.equal(res.data.greenCracker, true)
    const again = getProduct(t.db, res.data.id)
    assert.equal(again?.productName, 'Sparkler 10cm')
  } finally {
    t.cleanup()
  }
})

test('required-field validation is enforced in main process too', () => {
  const t = setup()
  try {
    const res = createProduct(t.db, input({ productName: '' }))
    assert.ok(!res.ok)
    assert.equal(res.error.code, 'VALIDATION')
    assert.ok(res.error.fields?.productName)
  } finally {
    t.cleanup()
  }
})

test('duplicate product codes are rejected gracefully (case-insensitive)', () => {
  const t = setup()
  try {
    assert.ok(createProduct(t.db, input()).ok)
    const dup = createProduct(t.db, input({ productCode: 'a1' }))
    assert.ok(!dup.ok)
    assert.equal(dup.error.code, 'DUPLICATE_CODE')
  } finally {
    t.cleanup()
  }
})

test('editing a product updates values and timestamps', () => {
  const t = setup()
  try {
    const created = createProduct(t.db, input())
    assert.ok(created.ok)
    const res = updateProduct(t.db, created.data.id, input({ ratePaise: 12000, finalRatePaise: 2400 }))
    assert.ok(res.ok)
    assert.equal(res.data.ratePaise, 12000)
    assert.equal(res.data.finalRatePaise, 2400)
  } finally {
    t.cleanup()
  }
})

test('editing invalid prices is refused', () => {
  const t = setup()
  try {
    const created = createProduct(t.db, input())
    assert.ok(created.ok)
    const bad = updateProduct(t.db, created.data.id, {
      ...input(),
      ratePaise: -1
    })
    assert.ok(!bad.ok)
    assert.equal(bad.error.code, 'VALIDATION')
  } finally {
    t.cleanup()
  }
})

// ─── Listing / search / pagination ─────────────────────────────────────

test('search, category filter and pagination', () => {
  const t = setup()
  try {
    for (let i = 1; i <= 5; i++) {
      createProduct(t.db, input({ productCode: `C${i}`, productName: `Item ${i}`, category: i % 2 ? 'odd' : 'even' }))
    }
    const page1 = listProducts(t.db, { page: 1, pageSize: 2 })
    assert.equal(page1.total, 5)
    assert.equal(page1.items.length, 2)
    const page3 = listProducts(t.db, { page: 3, pageSize: 2 })
    assert.equal(page3.items.length, 1)

    const search = listProducts(t.db, { search: 'Item 4' })
    assert.equal(search.total, 1)

    // LIKE wildcards in user input must not crash or act as wildcards.
    const wildcard = listProducts(t.db, { search: 'Item %' })
    assert.equal(wildcard.total, 0)

    const cats = listProducts(t.db, { category: 'even' })
    assert.equal(cats.total, 2)

    assert.deepEqual(listCategories(t.db).sort(), ['even', 'odd'])
  } finally {
    t.cleanup()
  }
})

// ─── Safe delete ───────────────────────────────────────────────────────

test('unreferenced product is hard-deleted and its image file removed', () => {
  const t = setup()
  try {
    writeFileSync(join(t.dir, 'img.png'), 'x')
    const created = createProduct(t.db, input({ imagePath: 'img.png' }))
    assert.ok(created.ok)
    const res = deleteProduct(t.db, created.data.id, t.dir)
    assert.ok(res.ok)
    assert.equal(res.data.action, 'deleted')
    assert.equal(getProduct(t.db, created.data.id), null)
    assert.equal(existsSync(join(t.dir, 'img.png')), false)
  } finally {
    t.cleanup()
  }
})

test('referenced product is archived, invoice history untouched', () => {
  const t = setup()
  try {
    const created = createProduct(t.db, input())
    assert.ok(created.ok)
    t.db.exec(`INSERT INTO invoices (id, invoice_number) VALUES (1, 'INV-1')`)
    t.db
      .prepare(
        `INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price, line_total)
         VALUES (1, ?, 'Sparkler 10cm', 2, 20, 40)`
      )
      .run(created.data.id)

    const res = deleteProduct(t.db, created.data.id, t.dir)
    assert.ok(res.ok)
    assert.equal(res.data.action, 'archived')
    assert.equal(getProduct(t.db, created.data.id)?.isActive, false)

    const item = t.db.prepare<[], { product_id: number; product_name: string }>(
      'SELECT product_id, product_name FROM invoice_items'
    ).get()
    assert.equal(item?.product_id, created.data.id)
    assert.equal(item?.product_name, 'Sparkler 10cm') // historical text preserved

    // restore via update
    const restored = updateProduct(t.db, created.data.id, input({ restoreActive: true }))
    assert.ok(restored.ok)
    assert.equal(restored.data.isActive, true)
  } finally {
    t.cleanup()
  }
})

// ─── Bulk import ───────────────────────────────────────────────────────

test('import skips invalid rows and reports them', () => {
  const t = setup()
  try {
    const res = importProducts(
      t.db,
      [
        { sourceRow: 1, input: input({ productCode: 'I1' }) },
        { sourceRow: 2, input: { ...input(), productName: '' } },
        { sourceRow: 3, input: input({ productCode: 'I3' }) }
      ],
      'skip'
    )
    assert.ok(res.ok)
    assert.equal(res.data.inserted, 2)
    assert.equal(res.data.invalid.length, 1)
    assert.equal(res.data.invalid[0].row, 2)
  } finally {
    t.cleanup()
  }
})

test('import duplicate strategies: skip vs update', () => {
  const t = setup()
  try {
    createProduct(t.db, input({ productCode: 'D1', productName: 'Original' }))

    const skip = importProducts(t.db, [{ sourceRow: 1, input: input({ productCode: 'D1', productName: 'Changed' }) }], 'skip')
    assert.ok(skip.ok)
    assert.equal(skip.data.skipped, 1)
    assert.equal(listProducts(t.db, { search: 'D1' }).items[0].productName, 'Original')

    const upd = importProducts(t.db, [{ sourceRow: 1, input: input({ productCode: 'D1', productName: 'Changed' }) }], 'update')
    assert.ok(upd.ok)
    assert.equal(upd.data.updated, 1)
    assert.equal(listProducts(t.db, { search: 'D1' }).items[0].productName, 'Changed')
  } finally {
    t.cleanup()
  }
})

test('duplicate codes inside the same file are detected', () => {
  const t = setup()
  try {
    const res = importProducts(
      t.db,
      [
        { sourceRow: 1, input: input({ productCode: 'X1' }) },
        { sourceRow: 2, input: input({ productCode: 'X1' }) }
      ],
      'update'
    )
    assert.ok(res.ok)
    assert.equal(res.data.inserted, 1)
    assert.equal(res.data.invalid.length, 1)
    assert.match(res.data.invalid[0].message, /more than once/)
  } finally {
    t.cleanup()
  }
})

test('catastrophic failure rolls the whole transaction back (no partial import)', () => {
  const t = setup()
  try {
    const db = t.db
    interface PatchedStmt {
      run: (...a: unknown[]) => unknown
    }
    type PatchedPrepare = (sql: string, ...rest: unknown[]) => PatchedStmt
    const dbObj = db as unknown as { prepare: PatchedPrepare }
    const originalPrepare = dbObj.prepare
    let insertRuns = 0
    // Simulate a storage failure on the SECOND executed product INSERT.
    dbObj.prepare = ((sql: string, ...rest: unknown[]) => {
      const stmt = originalPrepare.call(dbObj, sql, ...rest)
      if (sql.includes('INSERT INTO products')) {
        const originalRun = stmt.run.bind(stmt)
        stmt.run = (...a: unknown[]) => {
          if (++insertRuns === 2) throw new Error('simulated disk failure')
          return originalRun(...a)
        }
      }
      return stmt
    }) as PatchedPrepare

    assert.throws(() =>
      importProducts(
        db,
        [
          { sourceRow: 1, input: input({ productCode: 'R1' }) },
          { sourceRow: 2, input: input({ productCode: 'R2' }) }
        ],
        'skip'
      )
    )
    dbObj.prepare = originalPrepare

    const remaining = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM products').get()?.c ?? -1
    assert.equal(remaining, 0, 'first row must be rolled back with the second')
  } finally {
    t.cleanup()
  }
})

// ─── No stock tracking ─────────────────────────────────────────────────

test('products table has no stock columns after migration', () => {
  const t = setup()
  try {
    const cols = (t.db.pragma('table_info(products)') as { name: string }[]).map((c) => c.name)
    for (const forbidden of ['stock', 'in_stock', 'instock', 'quantity', 'qty']) {
      assert.ok(!cols.includes(forbidden))
    }
  } finally {
    t.cleanup()
  }
})
