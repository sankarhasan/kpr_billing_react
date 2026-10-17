/**
 * SQLite access layer — runs ONLY in the Electron main process.
 * The renderer never touches this module directly; it goes through the
 * preload contextBridge API and validated IPC handlers.
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { INITIAL_SCHEMA_SQL, DEFAULT_SETTINGS_SQL, SCHEMA_VERSION } from './schema'
import type { DbStatus, TableCounts } from '@shared/ipc'

export const DATA_FOLDER_NAME = 'kpr-billing'

let db: Database.Database | null = null
let dbPath = ''

/** Deterministic data directory outside any build/temp folder.
 *  Same folder name in dev and packaged builds so data survives upgrades. */
function resolveDbPath(): string {
  const dataDir = join(app.getPath('appData'), DATA_FOLDER_NAME)
  return join(dataDir, 'kpr-billing.db')
}

export function initDatabase(): void {
  if (db) return

  dbPath = resolveDbPath()
  mkdirSync(join(dbPath, '..'), { recursive: true })

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const migrate = db.transaction(() => {
    db!.exec(INITIAL_SCHEMA_SQL)
    db!.exec(DEFAULT_SETTINGS_SQL)
    db!
      .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION))
  })
  migrate()
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database has not been initialised. Call initDatabase() first.')
  }
  return db
}

function countRows(table: 'products' | 'customers' | 'invoices' | 'invoice_items'): number {
  const row = getDatabase()
    .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)
    .get()
  return row?.c ?? 0
}

export function getSetting(key: string): string | undefined {
  const row = getDatabase()
    .prepare<[{ key: string }], { value: string }>(
      'SELECT value FROM settings WHERE key = @key'
    )
    .get({ key })
  return row?.value
}

export function getDbStatus(): DbStatus {
  try {
    const counts: TableCounts = {
      products: countRows('products'),
      customers: countRows('customers'),
      invoices: countRows('invoices'),
      invoiceItems: countRows('invoice_items')
    }
    return {
      ok: true,
      path: dbPath,
      schemaVersion: Number(getSetting('schema_version') ?? SCHEMA_VERSION),
      counts,
      taxEnabled: getSetting('tax_enabled') === '1'
    }
  } catch (err) {
    return {
      ok: false,
      path: dbPath,
      schemaVersion: 0,
      counts: { products: 0, customers: 0, invoices: 0, invoiceItems: 0 },
      taxEnabled: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
