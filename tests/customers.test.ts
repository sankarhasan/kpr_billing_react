/**
 * Customer management tests: v2->v3 migration safety, repository CRUD,
 * required-name validation, search, pagination and archive-on-delete.
 * Every test uses a throwaway OS-temp database — NEVER the live database.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openTempDb } from './_util.ts'
import { migrateDatabase } from '../src/main/db/migrate.ts'
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer
} from '../src/main/db/customers-repo.ts'
import { validateCustomerInput } from '../src/shared/customers.ts'

function setup() {
  const t = openTempDb()
  migrateDatabase(t.db)
  return t
}

const input = (overrides: Record<string, unknown> = {}) => ({
  name: 'Ramesh Kumar',
  phone: '98765 43210',
  address: '12 Gandhi Street, Madurai',
  notes: 'Prefers big boxes',
  ...overrides
})

// ─── Migration ─────────────────────────────────────────────────────────

test('fresh database: customers has notes + archived_at, version = 3', () => {
  const t = setup()
  try {
    const cols = (t.db.pragma('table_info(customers)') as { name: string }[]).map((c) => c.name)
    assert.ok(cols.includes('notes'))
    assert.ok(cols.includes('archived_at'))
    assert.equal(t.db.pragma('user_version', { simple: true }), 5)
  } finally {
    t.cleanup()
  }
})

test('v2 -> v3 upgrade preserves existing customers and product data', () => {
  const t = openTempDb()
  try {
    migrateDatabase(t.db) // v3
    // Simulate a v2 database: drop the new columns and rewind the version.
    t.db.exec('ALTER TABLE customers DROP COLUMN notes')
    t.db.exec('ALTER TABLE customers DROP COLUMN archived_at')
    t.db.exec("INSERT INTO customers (name, phone) VALUES ('Old Customer', '111')")
    t.db.exec(
      "INSERT INTO products (product_code, product_name, rate_paise, final_rate_paise) VALUES ('Z1', 'Zap', 100, 100)"
    )
    t.db.pragma('user_version = 2')

    migrateDatabase(t.db) // upgrade path

    const cols = (t.db.pragma('table_info(customers)') as { name: string }[]).map((c) => c.name)
    assert.ok(cols.includes('notes'))
    assert.ok(cols.includes('archived_at'))
    const row = t.db.prepare<[], { name: string; notes: string; archived_at: unknown }>(
      'SELECT name, notes, archived_at FROM customers WHERE id = 1'
    ).get()
    assert.equal(row?.name, 'Old Customer')
    assert.equal(row?.notes, '')
    assert.equal(row?.archived_at, null)
    assert.equal(t.db.pragma('user_version', { simple: true }), 5)

    // Products untouched by the v3 migration.
    assert.equal(t.db.prepare<[], { c: number }>('SELECT COUNT(*) c FROM products').get()?.c, 1)
    assert.equal(
      t.db.prepare<[], { product_name: string }>("SELECT product_name FROM products WHERE product_code = 'Z1'").get()
        ?.product_name,
      'Zap'
    )
  } finally {
    t.cleanup()
  }
})

test('migration is idempotent and products survive repeated runs', () => {
  const t = setup()
  try {
    createCustomer(t.db, input({ name: 'Steady' }))
    t.db.exec(
      "INSERT INTO products (product_code, product_name, rate_paise, final_rate_paise) VALUES ('K1', 'Kit', 500, 450)"
    )
    migrateDatabase(t.db)
    migrateDatabase(t.db)
    assert.equal(listCustomers(t.db).total, 1)
    const p = t.db.prepare<[], { c: number }>('SELECT COUNT(*) c FROM products').get()?.c
    assert.equal(p, 1)
    assert.equal(t.db.pragma('user_version', { simple: true }), 5)
  } finally {
    t.cleanup()
  }
})

// ─── Validation ────────────────────────────────────────────────────────

test('required name (non-blank) and trimming', () => {
  const blank = validateCustomerInput({ name: '   ', phone: '', address: '', notes: '' })
  assert.ok(blank.errors.name)
  const ok = validateCustomerInput({ name: '  Asha  ', phone: '', address: '', notes: '' })
  assert.deepEqual(ok.errors, {})
  assert.equal(ok.value.name, 'Asha')
})

test('phone character rules; long text limits', () => {
  assert.ok(validateCustomerInput(input({ phone: 'abc-123' })).errors.phone)
  assert.ok(validateCustomerInput(input({ phone: '+91 98765-43210 (0452)' })).errors.phone === undefined)
  assert.ok(validateCustomerInput(input({ address: 'x'.repeat(501) })).errors.address)
  assert.ok(validateCustomerInput(input({ notes: 'x'.repeat(2001) })).errors.notes)
})

// ─── CRUD ──────────────────────────────────────────────────────────────

test('create + get + update round trip; updated_at maintained', () => {
  const t = setup()
  try {
    const res = createCustomer(t.db, input())
    assert.ok(res.ok)
    assert.equal(res.data.name, 'Ramesh Kumar')
    assert.equal(res.data.archivedAt, null)
    assert.ok(res.data.createdAt)

    const again = getCustomer(t.db, res.data.id)
    assert.equal(again?.phone, '98765 43210')

    const upd = updateCustomer(t.db, res.data.id, input({ name: 'Ramesh K', notes: '' }))
    assert.ok(upd.ok)
    assert.equal(upd.data.name, 'Ramesh K')
    assert.equal(upd.data.notes, '')
    assert.ok(upd.data.updatedAt)

    const missing = updateCustomer(t.db, 99999, input())
    assert.ok(!missing.ok)
    assert.equal(missing.error.code, 'NOT_FOUND')
  } finally {
    t.cleanup()
  }
})

test('create rejects blank name with structured VALIDATION error', () => {
  const t = setup()
  try {
    const res = createCustomer(t.db, input({ name: '  ' }))
    assert.ok(!res.ok)
    assert.equal(res.error.code, 'VALIDATION')
    assert.ok(res.error.fields?.name)
  } finally {
    t.cleanup()
  }
})

test('search by name and phone; LIKE wildcards escaped', () => {
  const t = setup()
  try {
    createCustomer(t.db, input({ name: 'Asha Fireworks', phone: '9000011111' }))
    createCustomer(t.db, input({ name: 'Bala', phone: '9000022222' }))
    assert.equal(listCustomers(t.db, { search: 'ash' }).total, 1)
    assert.equal(listCustomers(t.db, { search: '22222' }).total, 1)
    assert.equal(listCustomers(t.db, { search: '00%' }).total, 0) // wildcard escaped
    assert.equal(listCustomers(t.db, { search: 'zzz' }).total, 0)
  } finally {
    t.cleanup()
  }
})

test('pagination works', () => {
  const t = setup()
  try {
    for (let i = 1; i <= 5; i++) createCustomer(t.db, input({ name: `Cust ${i}` }))
    const p1 = listCustomers(t.db, { page: 1, pageSize: 2 })
    const p3 = listCustomers(t.db, { page: 3, pageSize: 2 })
    assert.equal(p1.total, 5)
    assert.equal(p1.items.length, 2)
    assert.equal(p3.items.length, 1)
    // ordered by name
    assert.equal(p1.items[0].name, 'Cust 1')
  } finally {
    t.cleanup()
  }
})

// ─── Archive / safe delete ─────────────────────────────────────────────

test('unreferenced customer is hard-deleted', () => {
  const t = setup()
  try {
    const res = createCustomer(t.db, input())
    assert.ok(res.ok)
    const del = deleteCustomer(t.db, res.data.id)
    assert.ok(del.ok)
    assert.equal(del.data.action, 'deleted')
    assert.equal(getCustomer(t.db, res.data.id), null)
  } finally {
    t.cleanup()
  }
})

test('invoice-referenced customer is archived; invoice history untouched; hidden from default list; restorable', () => {
  const t = setup()
  try {
    const res = createCustomer(t.db, input())
    assert.ok(res.ok)
    const id = res.data.id
    t.db.exec(`INSERT INTO invoices (id, invoice_number, customer_id) VALUES (1, 'INV-1', ${id})`)

    const del = deleteCustomer(t.db, id)
    assert.ok(del.ok)
    assert.equal(del.data.action, 'archived')
    assert.ok(del.data.customer.archivedAt)

    // default list hides archived
    assert.equal(listCustomers(t.db).total, 0)
    // includeArchived shows it
    const withArchived = listCustomers(t.db, { includeArchived: true })
    assert.equal(withArchived.total, 1)
    assert.ok(withArchived.items[0].archivedAt)

    // invoice row untouched
    const inv = t.db.prepare<[], { customer_id: number }>('SELECT customer_id FROM invoices WHERE id = 1').get()
    assert.equal(inv?.customer_id, id)

    // restore via update
    const restored = updateCustomer(t.db, id, input({ restoreActive: true }))
    assert.ok(restored.ok)
    assert.equal(restored.data.archivedAt, null)
    assert.equal(listCustomers(t.db).total, 1)
  } finally {
    t.cleanup()
  }
})
