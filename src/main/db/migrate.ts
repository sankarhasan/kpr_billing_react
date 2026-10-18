/**
 * Versioned database migration (PRAGMA user_version based).
 * Pure module: takes a better-sqlite3 Database, no Electron imports,
 * so it can be unit-tested directly with Node.
 *
 * Version map:
 *   0 -> fresh DB or Phase 1 DB (v1 products table or no products table)
 *   2 -> Phase 2 schema (v2 products with paise money, no stock columns)
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

export function migrateDatabase(db: DatabaseInstance): void {
  // Base (customers/invoices/invoice_items/settings) — idempotent.
  db.exec(BASE_TABLES_SQL)

  const version = db.pragma('user_version', { simple: true }) as number
  if (version < SCHEMA_VERSION) {
    if (tableExists(db, 'products')) {
      const cols = columnNames(db, 'products')
      if (!cols.includes('product_code')) {
        migrateProductsV1ToV2(db)
      }
    } else {
      db.exec(PRODUCTS_V2_TABLE_SQL)
      db.exec(PRODUCTS_V2_INDEXES_SQL)
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  db.exec(DEFAULT_SETTINGS_SQL)
}
