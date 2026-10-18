/**
 * Secure preload bridge. Exposes a minimal, typed API to the renderer via
 * contextBridge. No Node.js primitives are leaked; the renderer can only
 * invoke whitelisted, validated IPC channels.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc'
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

  files: {
    pickCsv: (): Promise<CsvFilePicked> => ipcRenderer.invoke(IPC_CHANNELS.CSV_PICK_FILE),
    saveCsv: (req: { defaultFileName: string; content: string }): Promise<CsvSaveResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.CSV_SAVE_FILE, req),
    pickImage: (): Promise<ImagePickResult> => ipcRenderer.invoke(IPC_CHANNELS.IMAGE_PICK)
  }
}

contextBridge.exposeInMainWorld('kpr', api)

export type KprApi = typeof api
