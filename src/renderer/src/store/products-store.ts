/**
 * Product management state (Zustand).
 * All persistence goes through the secure preload IPC bridge only.
 */
import { create } from 'zustand'
import type {
  IpcError,
  Product,
  ProductInput,
  ProductImportItem,
  ProductImportSummary,
  DuplicateStrategy
} from '@shared/products'

export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const

interface ProductsState {
  items: Product[]
  total: number
  page: number
  pageSize: number
  search: string
  categoryFilter: string // 'all' or a category value
  showInactive: boolean
  loading: boolean
  error: string | null
  statusMessage: string | null
  categories: string[]

  setFilters: (partial: Partial<Pick<ProductsState, 'search' | 'categoryFilter' | 'showInactive' | 'pageSize'>>) => void
  setPage: (page: number) => void
  load: () => Promise<void>
  loadCategories: () => Promise<void>
  createProduct: (input: ProductInput) => Promise<{ ok: true } | { ok: false; error: IpcError }>
  updateProduct: (id: number, input: ProductInput) => Promise<{ ok: true } | { ok: false; error: IpcError }>
  deleteProduct: (id: number) => Promise<{ ok: true; action: 'deleted' | 'archived' } | { ok: false; error: IpcError }>
  importProducts: (
    items: ProductImportItem[],
    strategy: DuplicateStrategy
  ) => Promise<{ ok: true; summary: ProductImportSummary } | { ok: false; error: IpcError }>
  fetchAllForExport: () => Promise<Product[]>
  setStatus: (message: string | null) => void
  clearError: () => void
}

export const useProductsStore = create<ProductsState>((set, get) => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: 25,
  search: '',
  categoryFilter: 'all',
  showInactive: false,
  loading: false,
  error: null,
  statusMessage: null,
  categories: [],

  setFilters: (partial) => {
    set({ ...partial, page: 1 })
    void get().load()
  },

  setPage: (page) => {
    const { total, pageSize } = get()
    const maxPage = Math.max(1, Math.ceil(total / pageSize))
    set({ page: Math.min(Math.max(1, page), maxPage) })
    void get().load()
  },

  load: async () => {
    set({ loading: true, error: null })
    try {
      const { search, categoryFilter, showInactive, page, pageSize } = get()
      const result = await window.kpr.products.list({
        search: search.trim() || undefined,
        category: categoryFilter === 'all' ? undefined : categoryFilter,
        includeInactive: showInactive,
        page,
        pageSize
      })
      set({ items: result.items, total: result.total, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load products.'
      })
    }
  },

  loadCategories: async () => {
    try {
      set({ categories: await window.kpr.products.categories() })
    } catch {
      /* non-fatal */
    }
  },

  createProduct: async (input) => {
    const res = await window.kpr.products.create(input)
    if (res.ok) {
      await Promise.all([get().load(), get().loadCategories()])
      set({ statusMessage: `Product "${res.data.productName}" added.` })
      return { ok: true }
    }
    return { ok: false, error: res.error }
  },

  updateProduct: async (id, input) => {
    const res = await window.kpr.products.update(id, input)
    if (res.ok) {
      await Promise.all([get().load(), get().loadCategories()])
      set({ statusMessage: `Product "${res.data.productName}" updated.` })
      return { ok: true }
    }
    return { ok: false, error: res.error }
  },

  deleteProduct: async (id) => {
    const res = await window.kpr.products.remove(id)
    if (res.ok) {
      await Promise.all([get().load(), get().loadCategories()])
      set({
        statusMessage:
          res.data.action === 'archived'
            ? `"${res.data.product.productName}" is used by past invoices, so it was archived (hidden) instead of deleted.`
            : `Product "${res.data.product.productName}" deleted.`
      })
      return { ok: true, action: res.data.action }
    }
    return { ok: false, error: res.error }
  },

  importProducts: async (items, strategy) => {
    set({ loading: true, error: null })
    try {
      const res = await window.kpr.products.importRows({ strategy, items })
      if (!res.ok) {
        set({ loading: false })
        return { ok: false, error: res.error }
      }
      await Promise.all([get().load(), get().loadCategories()])
      set({ loading: false })
      return { ok: true, summary: res.data }
    } catch (err) {
      set({ loading: false })
      return {
        ok: false,
        error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : 'Import failed.' }
      }
    }
  },

  fetchAllForExport: async () => {
    const all: Product[] = []
    let page = 1
    const pageSize = 500
    for (;;) {
      const { search, categoryFilter, showInactive } = get()
      const result = await window.kpr.products.list({
        search: search.trim() || undefined,
        category: categoryFilter === 'all' ? undefined : categoryFilter,
        includeInactive: showInactive,
        page,
        pageSize
      })
      all.push(...result.items)
      if (all.length >= result.total || result.items.length === 0) break
      page++
      if (page > 1000) break // hard safety stop (500k rows)
    }
    return all
  },

  setStatus: (message) => set({ statusMessage: message }),
  clearError: () => set({ error: null })
}))
