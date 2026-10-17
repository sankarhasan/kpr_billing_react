/**
 * IPC handlers — main process only.
 * Every handler validates its inputs before touching the database.
 * The renderer can only reach these channels through the preload bridge.
 */
import { ipcMain, app } from 'electron'
import { IPC_CHANNELS, type AppInfo } from '@shared/ipc'
import { getDbStatus } from './db'

/** Reject unexpected arguments: these Phase 1 channels take no parameters. */
function expectNoArgs(channel: string, args: unknown[]): void {
  if (args.length > 0) {
    throw new Error(`Invalid call to "${channel}": expected no arguments, got ${args.length}`)
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.APP_GET_INFO, (event, ...args) => {
    // Defense in depth: only accept calls from our own application window.
    if (!isTrustedSender(event)) {
      throw new Error(`Untrusted IPC sender on channel "${IPC_CHANNELS.APP_GET_INFO}"`)
    }
    expectNoArgs(IPC_CHANNELS.APP_GET_INFO, args)
    const info: AppInfo = {
      name: 'KPR Billing',
      version: app.getVersion(),
      platform: process.platform,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node
    }
    return info
  })

  ipcMain.handle(IPC_CHANNELS.DB_GET_STATUS, (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error(`Untrusted IPC sender on channel "${IPC_CHANNELS.DB_GET_STATUS}"`)
    }
    expectNoArgs(IPC_CHANNELS.DB_GET_STATUS, args)
    return getDbStatus()
  })
}

function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  try {
    // Our app only ever runs from file:// (prod) or the dev server URL.
    const frameUrl: string = event.senderFrame?.url ?? event.sender.getURL() ?? ''
    return frameUrl.startsWith('file://') || frameUrl.startsWith('http://localhost')
  } catch {
    // senderFrame can be null if the frame was destroyed - treat as untrusted.
    return false
  }
}
