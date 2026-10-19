/**
 * Shared IPC channel names and payload types.
 * Used by main (handlers), preload (bridge) and renderer (typed window API).
 */

export const IPC_CHANNELS = {
  APP_GET_INFO: 'app:get-info',
  DB_GET_STATUS: 'db:get-status',
  PRODUCTS_LIST: 'products:list',
  PRODUCTS_GET: 'products:getById',
  PRODUCTS_CREATE: 'products:create',
  PRODUCTS_UPDATE: 'products:update',
  PRODUCTS_DELETE: 'products:delete',
  PRODUCTS_CATEGORIES: 'products:categories',
  PRODUCTS_IMPORT: 'products:import',
  CSV_PICK_FILE: 'csv:pickFile',
  CSV_SAVE_FILE: 'csv:saveFile',
  IMAGE_PICK: 'image:pick',
  CUSTOMERS_LIST: 'customers:list',
  CUSTOMERS_GET: 'customers:getById',
  CUSTOMERS_CREATE: 'customers:create',
  CUSTOMERS_UPDATE: 'customers:update',
  CUSTOMERS_DELETE: 'customers:delete',
  INVOICES_CREATE: 'invoices:create',
  INVOICES_GET: 'invoices:getById',
  INVOICES_GET_BY_NUMBER: 'invoices:getByNumber',
  INVOICES_LIST: 'invoices:list',
  INVOICES_RESERVE_NUMBER: 'invoices:reserveNumber',
  INVOICES_RELEASE_NUMBER: 'invoices:releaseNumber',
  SETTINGS_GET_PRINT_INFO: 'settings:getPrintInfo',
  SETTINGS_GET_SHOP: 'settings:getShop',
  SETTINGS_UPDATE_SHOP: 'settings:updateShop',
  BACKUP_CREATE: 'backup:create',
  BACKUP_RESTORE: 'backup:restore',
  APP_RELAUNCH: 'app:relaunch',
  PRINT_OPEN_WINDOW: 'print:openInvoiceWindow',
  PRINT_NOW: 'print:printNow',
  PRINT_SAVE_PDF: 'print:savePdfSelf',
  PRINT_DOCUMENT_READY: 'print:documentReady',
  PRINT_CLOSE_SELF: 'print:closeSelf'
} as const

/** main → renderer push events (webContents.send). */
export const IPC_EVENTS = {
  PRINT_PDF_RESULT: 'print:pdfResult'
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

// ─── Phase 2: product / file-dialog payload types ─────────────────────

export interface CsvFilePicked {
  canceled: boolean
  fileName?: string
  /** Raw UTF-8 text; the renderer parses it. The file itself is never modified. */
  content?: string
}

export interface CsvSaveRequest {
  defaultFileName: string
  content: string
}

export interface CsvSaveResult {
  canceled: boolean
  filePath?: string
}

export interface ImagePickResult {
  canceled: boolean
  /** File name inside the app-local images folder (what gets stored in SQLite). */
  fileName?: string
  /** Base64 data URL for the form preview only (never stored in the DB). */
  previewDataUrl?: string
}
