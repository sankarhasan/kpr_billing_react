/**
 * Secure preload bridge. Exposes a minimal, typed API to the renderer via
 * contextBridge. No Node.js primitives are leaked; the renderer can only
 * invoke whitelisted, validated IPC channels.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc'
import type { AppInfo, DbStatus, CsvFilePicked, CsvSaveResult, ImagePickResult } from '@shared/ipc'
import type {
  IpcResult,
  Product,
  ProductInput,
  ProductListParams,
  ProductListResult,
  ProductImportItem,
  ProductImportSummary,
  DuplicateStrategy
} from '@shared/products'
import type {
  Customer,
  CustomerInput,
  CustomerListParams,
  CustomerListResult
} from '@shared/customers'
import type {
  Invoice,
  InvoiceCreateInput,
  InvoiceHistoryParams,
  InvoiceHistoryResult
} from '@shared/invoices'
import type {
  DocumentReadyResult,
  PrintFormat,
  PrintInfo,
  PrintOutcome,
  PrintPdfEvent,
  PrintWindowMode
} from '@shared/print'
import type { ShopSettings } from '@shared/settings'

// main → renderer push: PDF/print outcomes for requests started from a page.
const pdfResultListeners = new Set<(event: PrintPdfEvent) => void>()
ipcRenderer.on(IPC_EVENTS.PRINT_PDF_RESULT, (_e, payload: PrintPdfEvent) => {
  for (const cb of pdfResultListeners) {
    try {
      cb(payload)
    } catch {
      /* listener errors must not break delivery */
    }
  }
})

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_INFO),
  getDbStatus: (): Promise<DbStatus> => ipcRenderer.invoke(IPC_CHANNELS.DB_GET_STATUS),

  products: {
    list: (params?: ProductListParams): Promise<ProductListResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRODUCTS_LIST, params),
    getById: (id: number): Promise<IpcResult<Product>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRODUCTS_GET, { id }),
    create: (input: ProductInput): Promise<IpcResult<Product>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRODUCTS_CREATE, { input }),
    update: (id: number, input: ProductInput): Promise<IpcResult<Product>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRODUCTS_UPDATE, { id, input }),
    remove: (id: number): Promise<IpcResult<{ action: 'deleted' | 'archived'; product: Product }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRODUCTS_DELETE, { id }),
    categories: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.PRODUCTS_CATEGORIES),
    importRows: (payload: {
      strategy: DuplicateStrategy
      items: ProductImportItem[]
    }): Promise<IpcResult<ProductImportSummary>> => ipcRenderer.invoke(IPC_CHANNELS.PRODUCTS_IMPORT, payload)
  },

  customers: {
    list: (params?: CustomerListParams): Promise<CustomerListResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.CUSTOMERS_LIST, params),
    getById: (id: number): Promise<IpcResult<Customer>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CUSTOMERS_GET, { id }),
    create: (input: CustomerInput): Promise<IpcResult<Customer>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CUSTOMERS_CREATE, { input }),
    update: (id: number, input: CustomerInput): Promise<IpcResult<Customer>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CUSTOMERS_UPDATE, { id, input }),
    remove: (id: number): Promise<IpcResult<{ action: 'deleted' | 'archived'; customer: Customer }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CUSTOMERS_DELETE, { id })
  },

  invoices: {
    create: (input: InvoiceCreateInput): Promise<IpcResult<Invoice>> =>
      ipcRenderer.invoke(IPC_CHANNELS.INVOICES_CREATE, { input }),
    getById: (id: number): Promise<IpcResult<Invoice>> =>
      ipcRenderer.invoke(IPC_CHANNELS.INVOICES_GET, { id }),
    /** Full number OR last-4-digit suffix — resolved in the main process. */
    getByNumber: (number: string): Promise<IpcResult<Invoice>> =>
      ipcRenderer.invoke(IPC_CHANNELS.INVOICES_GET_BY_NUMBER, { number }),
    /** Sales History list: filter/sort/page/summary all run in main. */
    list: (params?: Partial<InvoiceHistoryParams>): Promise<IpcResult<InvoiceHistoryResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.INVOICES_LIST, { params }),
    /** Reserve the number shown on the current draft (main process decides). */
    reserveDraftNumber: (): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(IPC_CHANNELS.INVOICES_RESERVE_NUMBER),
    releaseDraftNumber: (number: string): Promise<IpcResult<{ released: boolean }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.INVOICES_RELEASE_NUMBER, { number })
  },

  settings: {
    /** Allowlisted printable business details (name/address/phones/GSTIN/footer). */
    getPrintInfo: (): Promise<IpcResult<PrintInfo>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_PRINT_INFO),
    getShop: (): Promise<IpcResult<ShopSettings>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_SHOP),
    updateShop: (input: ShopSettings): Promise<IpcResult<ShopSettings>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE_SHOP, input)
  },

  backup: {
    /** Native save dialog + online backup of the live database (settings included). */
    create: (): Promise<IpcResult<{ filePath: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.BACKUP_CREATE),
    /** Validated restore with automatic pre-restore safety backup. */
    restore: (): Promise<IpcResult<{ restored: boolean; safetyBackupPath: string; shopNameInBackup?: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.BACKUP_RESTORE)
  },

  appControl: {
    /** Restart the app (offered after a successful database restore). */
    relaunch: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke(IPC_CHANNELS.APP_RELAUNCH)
  },

  print: {
    /** Open/reuse a preview window, or trigger print / PDF for a saved invoice. */
    openInvoice: (req: {
      invoiceId: number
      format: PrintFormat
      mode: PrintWindowMode
    }): Promise<PrintOutcome> => ipcRenderer.invoke(IPC_CHANNELS.PRINT_OPEN_WINDOW, req),
    /** Print window only: show the system print dialog for this document. */
    printNow: (): Promise<PrintOutcome> => ipcRenderer.invoke(IPC_CHANNELS.PRINT_NOW),
    /** Print window only: printToPDF + native save dialog. */
    savePdfSelf: (): Promise<PrintOutcome> => ipcRenderer.invoke(IPC_CHANNELS.PRINT_SAVE_PDF),
    /** Print window only: document rendered — run whatever action was armed. */
    signalDocumentReady: (): Promise<DocumentReadyResult | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRINT_DOCUMENT_READY),
    /** Print window only: close this window. */
    closeSelf: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke(IPC_CHANNELS.PRINT_CLOSE_SELF),
    /** Subscribe to PDF/print results pushed by main. Returns unsubscribe. */
    onPdfResult: (cb: (event: PrintPdfEvent) => void): (() => void) => {
      pdfResultListeners.add(cb)
      return () => pdfResultListeners.delete(cb)
    }
  },

  files: {
    pickCsv: (): Promise<CsvFilePicked> => ipcRenderer.invoke(IPC_CHANNELS.CSV_PICK_FILE),
    saveCsv: (req: { defaultFileName: string; content: string }): Promise<CsvSaveResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.CSV_SAVE_FILE, req),
    pickImage: (): Promise<ImagePickResult> => ipcRenderer.invoke(IPC_CHANNELS.IMAGE_PICK)
  }
}

contextBridge.exposeInMainWorld('kpr', api)

export type KprApi = typeof api
