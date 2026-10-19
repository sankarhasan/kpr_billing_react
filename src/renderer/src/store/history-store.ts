/**
 * Sales History (Phase 5) state — Zustand.
 * Filters, pagination and the summary are resolved by the main process via
 * the secure preload IPC bridge; the renderer never sees raw DB access and
 * never computes monetary aggregates itself.
 */
import { create } from 'zustand'
import type {
  InvoiceHistoryRow,
  InvoiceHistorySummary
} from '@shared/invoices'

export const HISTORY_PAGE_SIZE_OPTIONS = [25, 50, 100] as const

const EMPTY_SUMMARY: InvoiceHistorySummary = {
  invoiceCount: 0,
  totalSalesPaise: 0,
  totalDiscountPaise: 0,
  totalItemsSold: 0
}

interface HistoryState {
  items: InvoiceHistoryRow[]
  totalMatches: number
  page: number
  pageSize: number
  summary: InvoiceHistorySummary
  /** Committed filter values (what the last query used). */
  invoiceNumber: string
  customer: string
  startDate: string
  endDate: string
  loading: boolean
  error: string | null

  setFilters: (
    partial: Partial<Pick<HistoryState, 'invoiceNumber' | 'customer' | 'startDate' | 'endDate' | 'pageSize'>>
  ) => void
  clearDateFilters: () => void
  clearAllFilters: () => void
  setPage: (page: number) => void
  load: () => Promise<void>
  clearError: () => void
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  items: [],
  totalMatches: 0,
  page: 1,
  pageSize: 25,
  summary: EMPTY_SUMMARY,
  invoiceNumber: '',
  customer: '',
  startDate: '',
  endDate: '',
  loading: false,
  error: null,

  // Changing any filter resets pagination (filters are preserved together;
  // one filter never silently resets another).
  setFilters: (partial) => {
    set({ ...partial, page: 1 })
    void get().load()
  },

  clearDateFilters: () => {
    set({ startDate: '', endDate: '', page: 1 })
    void get().load()
  },

  clearAllFilters: () => {
    set({ invoiceNumber: '', customer: '', startDate: '', endDate: '', page: 1 })
    void get().load()
  },

  setPage: (page) => {
    const { totalMatches, pageSize } = get()
    const maxPage = Math.max(1, Math.ceil(totalMatches / pageSize))
    set({ page: Math.min(Math.max(1, page), maxPage) })
    void get().load()
  },

  load: async () => {
    set({ loading: true, error: null })
    try {
      const { invoiceNumber, customer, startDate, endDate, page, pageSize } = get()
      const res = await window.kpr.invoices.list({
        invoiceNumber: invoiceNumber.trim() || undefined,
        customer: customer.trim() || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        page,
        pageSize
      })
      if (!res.ok) {
        set({ loading: false, error: res.error.message })
        return
      }
      set({
        items: res.data.items,
        totalMatches: res.data.totalMatches,
        summary: res.data.summary,
        page: res.data.page,
        loading: false
      })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load sales history.'
      })
    }
  },

  clearError: () => set({ error: null })
}))
