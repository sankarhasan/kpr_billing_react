/**
 * Versioned database migration (PRAGMA user_version based).
 * Pure module: takes a better-sqlite3 Database, no Electron imports,
 * so it can be unit-tested directly with Node.
 *
 * Version map:
 *   0 -> fresh DB or Phase 1 DB (v1 products table or no products table)
 *   2 -> Phase 2 schema (v2 products with paise money, no stock columns)
 *   3 -> Phase 3 schema (customers gain notes + archived_at)
 *   4 -> Phase 4 schema (invoices/invoice_items rebuilt: paise money + snapshots)
 *   5 -> Phase 4 improve (invoices gain round_off_paise)
 */
import type Database from 'better-sqlite3'
import {
  BASE_TABLES_SQL,
  PRODUCTS_V2_TABLE_SQL,
  PRODUCTS_V2_INDEXES_SQL,
  DEFAULT_SETTINGS_SQL,
  SCHEMA_VERSION
} from './schema.ts'

type DatabaseInstance = Database.Database

function tableExists(db: DatabaseInstance, name: string): boolean {
  const row = db
    .prepare<[{ name: string }], { c: number }>(
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = @name`
    )
    .get({ name })
  return (row?.c ?? 0) > 0
}

function columnNames(db: DatabaseInstance, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)
}

/**
 * v1 -> v2 products migration. Rebuilds the table while preserving rows:
 * name -> product_name, sale_price (REAL rupees) -> rate/final paise,
 * a stable unique code ('P'<id>) is generated for old rows, is_active and
 * timestamps are carried over. Runs with FK enforcement temporarily off so
 * the DROP/RENAME dance cannot touch invoice_items references.
 */
function migrateProductsV1ToV2(db: DatabaseInstance): void {
  db.pragma('foreign_keys = OFF')
  try {
    const run = db.transaction(() => {
      const createNew = PRODUCTS_V2_TABLE_SQL.replace(
        'CREATE TABLE IF NOT EXISTS products',
        'CREATE TABLE products_new'
      )
      db.exec(createNew)
      db.exec(`
        INSERT INTO products_new (
          id, product_code, product_name, category, brand,
          rate_paise, discount_type, discount_percent, discount_amount_paise,
          final_rate_paise, green_cracker, description, image_path,
          is_active, created_at, updated_at
        )
        SELECT
          id,
          'P' || id,
          name,
          category,
          '',
          CAST(ROUND(sale_price * 100) AS INTEGER),
          'none',
          0,
          0,
          CAST(ROUND(sale_price * 100) AS INTEGER),
          0,
          '',
          '',
          is_active,
          created_at,
          updated_at
        FROM products
      `)
      db.exec('DROP TABLE products')
      db.exec('ALTER TABLE products_new RENAME TO products')
      db.exec(PRODUCTS_V2_INDEXES_SQL)
    })
    run()
  } finally {
    db.pragma('foreign_keys = ON')
    const violations = db.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) {
      console.error('[migrate] foreign_key_check violations after products migration:', violations)
    }
  }
}

/**
 * v2 -> v3 customers migration: add notes + archived_at columns.
 * Purely additive (ALTER TABLE ADD COLUMN) — existing customer rows and
 * all other tables are untouched. Idempotent: skips columns that already
 * exist (fresh databases get them from BASE_TABLES_SQL).
 */
function migrateCustomersV2ToV3(db: DatabaseInstance): void {
  const cols = columnNames(db, 'customers')
  if (!cols.includes('notes')) {
    db.exec(`ALTER TABLE customers ADD COLUMN notes TEXT NOT NULL DEFAULT ''`)
  }
  if (!cols.includes('archived_at')) {
    db.exec('ALTER TABLE customers ADD COLUMN archived_at TEXT')
  }
}

/**
 * v3 -> v4 invoice migration. Rebuilds invoices + invoice_items when the
 * old REAL-rupee columns are detected:
 *  - REAL amounts -> INTEGER paise (x100, rounded)
 *  - customer name/phone/address snapshot backfilled from the customers table
 *  - product_code snapshot backfilled from the products table
 * Existing rows are preserved row-for-row (ids, dates, numbers).
 */
function migrateInvoicesV3ToV4(db: DatabaseInstance): void {
  const invCols = columnNames(db, 'invoices')
  const itemCols = columnNames(db, 'invoice_items')
  if (invCols.includes('subtotal_paise') && itemCols.includes('unit_price_paise')) return

  db.pragma('foreign_keys = OFF')
  try {
    const run = db.transaction(() => {
      if (!invCols.includes('subtotal_paise')) {
        db.exec(`
          CREATE TABLE invoices_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_number    TEXT    NOT NULL UNIQUE,
            customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
            customer_name     TEXT    NOT NULL DEFAULT 'Walk-in Customer',
            customer_phone    TEXT    NOT NULL DEFAULT '',
            customer_address  TEXT    NOT NULL DEFAULT '',
            invoice_date      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
            subtotal_paise    INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_paise >= 0),
            discount_paise    INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
            tax_amount_paise  INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount_paise >= 0),
            total_paise       INTEGER NOT NULL DEFAULT 0 CHECK (total_paise >= 0),
            payment_mode      TEXT    NOT NULL DEFAULT 'cash',
            status            TEXT    NOT NULL DEFAULT 'completed',
            notes             TEXT    NOT NULL DEFAULT '',
            created_at        TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
          );
          INSERT INTO invoices_new (
            id, invoice_number, customer_id, customer_name, customer_phone, customer_address,
            invoice_date, subtotal_paise, discount_paise, tax_amount_paise, total_paise,
            payment_mode, status, notes, created_at
          )
          SELECT
            i.id, i.invoice_number, i.customer_id,
            COALESCE((SELECT c.name FROM customers c WHERE c.id = i.customer_id), 'Walk-in Customer'),
            COALESCE((SELECT c.phone FROM customers c WHERE c.id = i.customer_id), ''),
            COALESCE((SELECT c.address FROM customers c WHERE c.id = i.customer_id), ''),
            i.invoice_date,
            CAST(ROUND(i.subtotal * 100) AS INTEGER),
            CAST(ROUND(i.discount * 100) AS INTEGER),
            CAST(ROUND(i.tax_amount * 100) AS INTEGER),
            CAST(ROUND(i.total * 100) AS INTEGER),
            i.payment_mode, i.status, i.notes, i.created_at
          FROM invoices i;
          DROP TABLE invoices;
          ALTER TABLE invoices_new RENAME TO invoices;
          CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices (invoice_date);
          CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id);
          CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices (invoice_number);
        `)
      }

      if (!itemCols.includes('unit_price_paise')) {
        db.exec(`
          CREATE TABLE invoice_items_new (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id            INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            product_id            INTEGER REFERENCES products(id) ON DELETE SET NULL,
            product_code          TEXT    NOT NULL DEFAULT '',
            product_name          TEXT    NOT NULL,
            quantity              REAL    NOT NULL DEFAULT 1 CHECK (quantity > 0),
            unit_price_paise      INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_paise >= 0),
            line_total_paise      INTEGER NOT NULL DEFAULT 0 CHECK (line_total_paise >= 0),
            original_rate_paise   INTEGER NOT NULL DEFAULT 0,
            discount_type         TEXT    NOT NULL DEFAULT 'none',
            discount_percent      REAL    NOT NULL DEFAULT 0,
            discount_amount_paise INTEGER NOT NULL DEFAULT 0
          );
          INSERT INTO invoice_items_new (
            id, invoice_id, product_id, product_code, product_name, quantity,
            unit_price_paise, line_total_paise
          )
          SELECT
            it.id, it.invoice_id, it.product_id,
            COALESCE((SELECT p.product_code FROM products p WHERE p.id = it.product_id), ''),
            it.product_name, it.quantity,
            CAST(ROUND(it.unit_price * 100) AS INTEGER),
            CAST(ROUND(it.line_total * 100) AS INTEGER)
          FROM invoice_items it;
          DROP TABLE invoice_items;
          ALTER TABLE invoice_items_new RENAME TO invoice_items;
          CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id);
        `)
      }
    })
    run()
  } finally {
    db.pragma('foreign_keys = ON')
    const violations = db.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) {
      console.error('[migrate] foreign_key_check violations after invoice migration:', violations)
    }
  }
}

export function migrateDatabase(db: DatabaseInstance): void {
  // Base (customers/invoices/invoice_items/settings) — idempotent.
  db.exec(BASE_TABLES_SQL)

  const version = db.pragma('user_version', { simple: true }) as number

  if (version < 2) {
    if (tableExists(db, 'products')) {
      const cols = columnNames(db, 'products')
      if (!cols.includes('product_code')) {
        migrateProductsV1ToV2(db)
      }
    } else {
      db.exec(PRODUCTS_V2_TABLE_SQL)
      db.exec(PRODUCTS_V2_INDEXES_SQL)
    }
  }

  if (version < 3) {
    migrateCustomersV2ToV3(db)
  }

  if (version < 4) {
    migrateInvoicesV3ToV4(db)
  }

  if (version < 5) {
    const invCols = columnNames(db, 'invoices')
    if (!invCols.includes('round_off_paise')) {
      db.exec('ALTER TABLE invoices ADD COLUMN round_off_paise INTEGER NOT NULL DEFAULT 0')
    }
  }

  if (version < SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  db.exec(DEFAULT_SETTINGS_SQL)
}
