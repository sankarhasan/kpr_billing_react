/**
 * Backup/restore building blocks that do NOT depend on Electron — safe to
 * unit-test against disposable temp databases. The Electron glue (dialogs,
 * live-connection swap) lives in src/main/backup/backup-service.ts.
 *
 * Shop settings live inside this same SQLite database (settings table), so
 * every database backup inherently contains them and every restore brings
 * them back — no separate configuration file is involved anywhere.
 */
import Database from 'better-sqlite3'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REQUIRED_TABLES = ['settings', 'products', 'customers', 'invoices', 'invoice_items']
const SQLITE_HEADER = 'SQLite format 3\0'

/** Cheap header check so junk files get an accurate message (and are
 *  never even handed to the SQLite driver). */
function hasSqliteHeader(file: string): boolean {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(16)
    const n = readSync(fd, buf, 0, 16, 0)
    return n === 16 && buf.toString('utf8') === SQLITE_HEADER
  } finally {
    closeSync(fd)
  }
}

export interface BackupCheck {
  ok: boolean
  message?: string
  /** shop_name found inside the backup (shown to the user as confirmation). */
  shopName?: string
}

/** Read-only sanity gate BEFORE touching the live database. */
export function validateBackupFile(file: string): BackupCheck {
  if (!existsSync(file)) return { ok: false, message: 'The selected backup file does not exist.' }
  if (statSync(file).size === 0) return { ok: false, message: 'The selected backup file is empty.' }
  if (!hasSqliteHeader(file)) return { ok: false, message: 'The selected file is not a valid SQLite database.' }
  let db: Database.Database
  try {
    db = new Database(file, { readonly: true })
  } catch {
    return { ok: false, message: 'The selected file is not a valid SQLite database.' }
  }
  try {
    const rows = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('settings','products','customers','invoices','invoice_items')`
      )
      .all()
    const found = new Set(rows.map((r) => r.name))
    const missing = REQUIRED_TABLES.filter((t) => !found.has(t))
    if (missing.length > 0) {
      return { ok: false, message: `Not a KPR Billing database (missing tables: ${missing.join(', ')}).` }
    }
    const integrity = db.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') {
      return { ok: false, message: `The backup failed its integrity check (${String(integrity)}).` }
    }
    const shopRow = db
      .prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'shop_name'")
      .get()
    return { ok: true, shopName: shopRow?.value ?? '' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'The backup file could not be read.' }
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

/** Copy src → tmp next to dest, then atomically rename onto dest. */
export function copyFileAtomic(src: string, dest: string): void {
  const tmp = `${dest}.restoring`
  copyFileSync(src, tmp)
  renameSync(tmp, dest) // replaces dest; fails loudly if dest is locked
}

/** Stale WAL/shared-memory sidecars must not outlive a swapped-in db file. */
export function removeSidecars(dbFile: string): void {
  rmSync(`${dbFile}-wal`, { force: true })
  rmSync(`${dbFile}-shm`, { force: true })
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/** 'YYYYMMDD-HHmmss' from LOCAL time (file names only — no logic depends on it). */
export function timestampSlug(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}

export function backupFileName(ts = timestampSlug()): string {
  return `kpr-billing-backup-${ts}.db`
}

export function preRestoreFileName(ts = timestampSlug()): string {
  return `kpr-billing-pre-restore-${ts}.db`
}

export function joinPath(...parts: string[]): string {
  return join(...parts)
}
