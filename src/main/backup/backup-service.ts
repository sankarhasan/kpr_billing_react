/**
 * Phase 7 — Backup & Restore (Electron main glue).
 *
 * Shop settings live in the SQLite database itself, so a database backup
 * ALWAYS contains the current shop details and a restore brings back the
 * settings stored in that backup — nothing is duplicated into a second
 * config file.
 *
 * Restore safety order (a failed restore can never lose current data):
 *   1. validate the chosen file FIRST (read-only) — reject bad files;
 *   2. take a timestamped PRE-RESTORE safety backup of the live database;
 *   3. close the live connection, copy over the db file atomically, remove
 *      stale WAL sidecars and reopen (+ additive migrations run);
 *   4. if the reopened file fails any check, roll back to the safety copy.
 */
import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { closeDatabase, getDatabase, getDbPath, initDatabase } from '../db'
import {
  backupFileName,
  copyFileAtomic,
  ensureDir,
  preRestoreFileName,
  removeSidecars,
  validateBackupFile
} from '../db/backup'
import { ipcErr, ipcOk, type IpcResult } from '@shared/products'

let jobRunning = false // never two backup/restore flows at once

function ownerWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
}

export async function createBackupFlow(): Promise<IpcResult<{ filePath: string }>> {
  if (jobRunning) return ipcErr('CANCELLED', 'Another backup/restore is already running.')
  jobRunning = true
  try {
    const defaultPath = join(app.getPath('downloads'), backupFileName())
    const options = {
      title: 'Back Up KPR Billing Database',
      defaultPath,
      filters: [{ name: 'KPR Billing database', extensions: ['db'] }]
    }
    const win = ownerWindow()
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (canceled || !filePath) {
      return ipcErr('CANCELLED', 'Backup was cancelled — nothing was changed.')
    }
    try {
      // better-sqlite3 online backup: consistent snapshot even with WAL on.
      await getDatabase().backup(filePath)
    } catch (err) {
      return ipcErr('IO_ERROR', err instanceof Error ? `Backup failed: ${err.message}` : 'Backup failed.')
    }
    return ipcOk({ filePath })
  } finally {
    jobRunning = false
  }
}

export interface RestoreResult {
  restored: boolean
  /** Path of the automatic pre-restore safety backup of the previous data. */
  safetyBackupPath: string
  shopNameInBackup?: string
}

export async function restoreBackupFlow(): Promise<IpcResult<RestoreResult>> {
  if (jobRunning) return ipcErr('CANCELLED', 'Another backup/restore is already running.')
  jobRunning = true
  try {
    const win = ownerWindow()
    const pick = win
      ? await dialog.showOpenDialog(win, {
          title: 'Restore from Backup',
          properties: ['openFile'],
          filters: [{ name: 'KPR Billing database', extensions: ['db'] }]
        })
      : await dialog.showOpenDialog({
          title: 'Restore from Backup',
          properties: ['openFile'],
          filters: [{ name: 'KPR Billing database', extensions: ['db'] }]
        })
    if (pick.canceled || pick.filePaths.length === 0) {
      return ipcErr('CANCELLED', 'Restore was cancelled — nothing was changed.')
    }
    const source = pick.filePaths[0]

    // 1. Validate the candidate BEFORE touching anything live.
    const check = validateBackupFile(source)
    if (!check.ok) {
      return ipcErr('VALIDATION', check.message ?? 'The selected file is not a usable backup.')
    }

    const dbFile = getDbPath()
    const safetyDir = join(app.getPath('userData'), 'backups')
    ensureDir(safetyDir)
    const safetyPath = join(safetyDir, preRestoreFileName())

    // 2. Pre-restore safety backup of the CURRENT live database.
    try {
      await getDatabase().backup(safetyPath)
    } catch (err) {
      return ipcErr('IO_ERROR', err instanceof Error ? `Could not create the safety backup: ${err.message}` : 'Could not create the safety backup.')
    }

    // 3. Swap the file while no connection holds it. If the copy fails the
    //    live file was never modified; just reopen it.
    closeDatabase()
    try {
      copyFileAtomic(source, dbFile)
      removeSidecars(dbFile)
    } catch (err) {
      try {
        initDatabase()
      } catch {
        /* reopen attempted anyway */
      }
      return ipcErr('IO_ERROR', err instanceof Error ? `Restore failed — current data kept intact (${err.message}).` : 'Restore failed — current data kept intact.')
    }

    // 4. Reopen; if the swapped-in file is unusable, roll back to safety copy.
    try {
      initDatabase()
    } catch (err) {
      const openMsg = err instanceof Error ? err.message : String(err)
      try {
        copyFileAtomic(safetyPath, dbFile)
        removeSidecars(dbFile)
        initDatabase()
        return ipcErr('DB_ERROR', `Restore was rolled back — the chosen backup could not be opened (${openMsg}). Your previous database was recovered from the safety copy.`)
      } catch {
        return ipcErr('DB_ERROR', `Restore failed to open and roll back (${openMsg}). A safety copy is at ${safetyPath}.`)
      }
    }

    return ipcOk({ restored: true, safetyBackupPath: safetyPath, shopNameInBackup: check.shopName })
  } finally {
    jobRunning = false
  }
}

export function relaunchApp(): void {
  app.relaunch()
  app.exit(0)
}
