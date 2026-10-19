/**
 * Customer management state (Zustand).
 * All persistence goes through the secure preload IPC bridge only.
 */
import { create } from 'zustand'
import type { IpcError } from '@shared/products'
import type { Customer, CustomerInput } from '@shared/customers'

export const CUSTOMER_PAGE_SIZE_OPTIONS = [25, 50, 100] as const

interface CustomersState {
  items: Customer[]
  total: number
  page: number
  pageSize: number
  search: string
  showArchived: boolean
  loading: boolean
  error: string | null
  statusMessage: string | null

  setFilters: (partial: Partial<Pick<CustomersState, 'search' | 'showArchived' | 'pageSize'>>) => void
  setPage: (page: number) => void
  load: () => Promise<void>
  createCustomer: (input: CustomerInput) => Promise<{ ok: true } | { ok: false; error: IpcError }>
  updateCustomer: (id: number, input: CustomerInput) => Promise<{ ok: true } | { ok: false; error: IpcError }>
  deleteCustomer: (id: number) => Promise<{ ok: true; action: 'deleted' | 'archived' } | { ok: false; error: IpcError }>
  setStatus: (message: string | null) => void
  clearError: () => void
}

export const useCustomersStore = create<CustomersState>((set, get) => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: 25,
  search: '',
  showArchived: false,
  loading: false,
  error: null,
  statusMessage: null,

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
      const { search, showArchived, page, pageSize } = get()
      const result = await window.kpr.customers.list({
        search: search.trim() || undefined,
        includeArchived: showArchived,
        page,
        pageSize
      })
      set({ items: result.items, total: result.total, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load customers.'
      })
    }
  },

  createCustomer: async (input) => {
    const res = await window.kpr.customers.create(input)
    if (res.ok) {
      await get().load()
      set({ statusMessage: `Customer "${res.data.name}" added.` })
      return { ok: true }
    }
    return { ok: false, error: res.error }
  },

  updateCustomer: async (id, input) => {
    const res = await window.kpr.customers.update(id, input)
    if (res.ok) {
      await get().load()
      set({ statusMessage: `Customer "${res.data.name}" updated.` })
      return { ok: true }
    }
    return { ok: false, error: res.error }
  },

  deleteCustomer: async (id) => {
    const res = await window.kpr.customers.remove(id)
    if (res.ok) {
      await get().load()
      set({
        statusMessage:
          res.data.action === 'archived'
            ? `"${res.data.customer.name}" is used by saved invoices, so the customer was archived (hidden) instead of deleted.`
            : `Customer "${res.data.customer.name}" deleted.`
      })
      return { ok: true, action: res.data.action }
    }
    return { ok: false, error: res.error }
  },

  setStatus: (message) => set({ statusMessage: message }),
  clearError: () => set({ error: null })
}))
