/**
 * Global UI state (Zustand): active page navigation.
 * Business-data stores arrive with their respective phases.
 */
import { create } from 'zustand'

export type PageId =
  | 'dashboard'
  | 'billing'
  | 'products'
  | 'customers'
  | 'history'
  | 'settings'

interface UiState {
  currentPage: PageId
  setPage: (page: PageId) => void
}

export const useUiStore = create<UiState>((set) => ({
  currentPage: 'dashboard',
  setPage: (page) => set({ currentPage: page })
}))
