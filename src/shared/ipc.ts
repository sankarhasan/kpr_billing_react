/**
 * Shared IPC channel names and payload types.
 * Used by main (handlers), preload (bridge) and renderer (typed window API).
 */

export const IPC_CHANNELS = {
  APP_GET_INFO: 'app:get-info',
  DB_GET_STATUS: 'db:get-status'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export interface AppInfo {
  name: string
  version: string
  platform: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
}

export interface TableCounts {
  products: number
  customers: number
  invoices: number
  invoiceItems: number
}

export interface DbStatus {
  ok: boolean
  path: string
  schemaVersion: number
  counts: TableCounts
  taxEnabled: boolean
  error?: string
}
