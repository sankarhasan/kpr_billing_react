/**
 * Shared test helpers: temp SQLite databases in the OS temp folder.
 * Never touches the real application database.
 */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TempDb {
  db: InstanceType<typeof Database>
  dir: string
  cleanup: () => void
}

export function openTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'kpr-billing-test-'))
  const db = new Database(join(dir, 'test.db'))
  db.pragma('foreign_keys = ON')
  return {
    db,
    dir,
    cleanup: () => {
      try {
        db.close()
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
