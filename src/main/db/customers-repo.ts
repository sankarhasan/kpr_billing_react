/**
 * Customer data-access layer. Pure module (no Electron imports): it takes a
 * better-sqlite3 Database instance so it can run in the main process AND in
 * plain Node automated tests. All SQL is parameterized.
 */
import type Database from 'better-sqlite3'
import { validateCustomerInput } from '../../shared/customers.ts'
import type { Customer, CustomerListParams, CustomerListResult } from '../../shared/customers.ts'
import { ipcErr, ipcOk, type IpcResult } from '../../shared/products.ts'

type Db = Database.Database

interface CustomerRow {
  id: number
  name: string
  phone: string
  address: string
  notes: string
  archived_at: string | null
  created_at: string
  updated_at: string
}

function mapRow(r: CustomerRow): Customer {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    address: r.address,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at
  }
}

const SELECT_COLS = `id, name, phone, address, notes, archived_at, created_at, updated_at`

// ─── Queries ──────────────────────────────────────────────────────────

export function listCustomers(db: Db, params: CustomerListParams = {}): CustomerListResult {
  const page = Math.max(1, Math.floor(params.page ?? 1))
  const pageSize = Math.min(500, Math.max(1, Math.floor(params.pageSize ?? 25)))
  const where: string[] = []
  const bind: Record<string, unknown> = {}

  if (!params.includeArchived) where.push('archived_at IS NULL')

  if (params.search && params.search.trim() !== '') {
    const term = params.search.trim().replace(/[%_]/g, (m) => `\\${m}`)
    where.push(`(name LIKE @term ESCAPE '\\' OR phone LIKE @term ESCAPE '\\')`)
    bind.term = `%${term}%`
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const total =
    db.prepare<Record<string, unknown>, { c: number }>(`SELECT COUNT(*) AS c FROM customers ${whereSql}`).get(bind)
      ?.c ?? 0

  const items = (
    db
      .prepare<Record<string, unknown>, CustomerRow>(
        `SELECT ${SELECT_COLS} FROM customers ${whereSql} ORDER BY name COLLATE NOCASE, id LIMIT @limit OFFSET @offset`
      )
      .all({ ...bind, limit: pageSize, offset: (page - 1) * pageSize }) ?? []
  ).map(mapRow)

  return { items, total, page, pageSize }
}

export function getCustomer(db: Db, id: number): Customer | null {
  const row = db
    .prepare<[{ id: number }], CustomerRow>(`SELECT ${SELECT_COLS} FROM customers WHERE id = @id`)
    .get({ id })
  return row ? mapRow(row) : null
}

// ─── Mutations ─────────────────────────────────────────────────────────

export function createCustomer(db: Db, rawInput: unknown): IpcResult<Customer> {
  const { errors, value } = validateCustomerInput(rawInput)
  if (Object.keys(errors).length > 0) {
    return ipcErr<Customer>('VALIDATION', 'Please correct the highlighted fields.', errors)
  }
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, address, notes) VALUES (@name, @phone, @address, @notes)`
    )
    .run(value)
  const created = getCustomer(db, Number(info.lastInsertRowid))
  if (!created) return ipcErr<Customer>('DB_ERROR', 'Customer was created but could not be re-read.')
  return ipcOk(created)
}

export function updateCustomer(db: Db, id: number, rawInput: unknown): IpcResult<Customer> {
  const existing = getCustomer(db, id)
  if (!existing) return ipcErr<Customer>('NOT_FOUND', `Customer #${id} was not found.`)

  const { errors, value } = validateCustomerInput(rawInput)
  if (Object.keys(errors).length > 0) {
    return ipcErr<Customer>('VALIDATION', 'Please correct the highlighted fields.', errors)
  }

  db.prepare(
    `UPDATE customers SET
       name = @name, phone = @phone, address = @address, notes = @notes,
       archived_at = CASE WHEN @restoreActive = 1 THEN NULL ELSE archived_at END,
       updated_at = datetime('now', 'localtime')
     WHERE id = @id`
  ).run({ ...value, restoreActive: value.restoreActive ? 1 : 0, id })

  const updated = getCustomer(db, id)
  if (!updated) return ipcErr<Customer>('DB_ERROR', 'Customer was updated but could not be re-read.')
  return ipcOk(updated)
}

export interface CustomerDeleteResult {
  action: 'deleted' | 'archived'
  customer: Customer
}

/**
 * Safe delete:
 *  - referenced by invoices -> archive (archived_at timestamp); invoice
 *    history (including the denormalised customer details on each invoice)
 *    is NEVER touched
 *  - unreferenced           -> hard delete
 */
export function deleteCustomer(db: Db, id: number): IpcResult<CustomerDeleteResult> {
  const customer = getCustomer(db, id)
  if (!customer) return ipcErr<CustomerDeleteResult>('NOT_FOUND', `Customer #${id} was not found.`)

  const refs =
    db
      .prepare<[{ id: number }], { c: number }>('SELECT COUNT(*) AS c FROM invoices WHERE customer_id = @id')
      .get({ id: customer.id })?.c ?? 0

  if (refs > 0) {
    db.prepare(
      `UPDATE customers SET archived_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime') WHERE id = ?`
    ).run(id)
    const archived = getCustomer(db, id)
    if (!archived) return ipcErr<CustomerDeleteResult>('DB_ERROR', 'Archive failed.')
    return ipcOk({ action: 'archived', customer: archived })
  }

  db.prepare('DELETE FROM customers WHERE id = ?').run(id)
  return ipcOk({ action: 'deleted', customer })
}
