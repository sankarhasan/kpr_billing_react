/**
 * Secure preload bridge. Exposes a minimal, typed API to the renderer via
 * contextBridge. No Node.js primitives are leaked; the renderer can only
 * invoke whitelisted, validated IPC channels.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc'
import type { AppInfo, DbStatus } from '@shared/ipc'

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_INFO),
  getDbStatus: (): Promise<DbStatus> => ipcRenderer.invoke(IPC_CHANNELS.DB_GET_STATUS)
}

contextBridge.exposeInMainWorld('kpr', api)

export type KprApi = typeof api
