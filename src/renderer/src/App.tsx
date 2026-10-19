import type React from 'react'
import { useMemo } from 'react'

import { Sidebar } from '@/components/layout/sidebar'
import { useUiStore, type PageId } from '@/store/ui-store'
import { DashboardPage } from '@/pages/dashboard'
import { BillingPage } from '@/pages/billing'
import { ProductsPage } from '@/pages/products'
import { CustomersPage } from '@/pages/customers'
import { HistoryPage } from '@/pages/history'
import { SettingsPage } from '@/pages/settings'
import { PrintWindowPage } from '@/pages/print-window'
import { parsePrintQuery } from '@shared/print'

const PAGE_TITLES: Record<PageId, string> = {
  dashboard: 'Dashboard',
  billing: 'New Invoice',
  products: 'Product Management',
  customers: 'Customer Management',
  history: 'Sales History',
  settings: 'Settings'
}

const PAGES: Record<PageId, React.ComponentType> = {
  dashboard: DashboardPage,
  billing: BillingPage,
  products: ProductsPage,
  customers: CustomersPage,
  history: HistoryPage,
  settings: SettingsPage
}

export default function App() {
  // A print window is a separate top-level surface created ONLY by the main
  // process (controlled ?print=1 query) — it replaces the whole app shell.
  const printRequest = useMemo(() => parsePrintQuery(window.location.search), [])
  const currentPage = useUiStore((s) => s.currentPage)
  const ActivePage = PAGES[currentPage]

  if (printRequest) {
    return <PrintWindowPage request={printRequest} />
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Compact top bar */}
        <header className="flex h-11 shrink-0 items-center justify-between border-b bg-card px-5">
          <span className="text-sm font-semibold">{PAGE_TITLES[currentPage]}</span>
          <span className="text-xs text-muted-foreground">KPR Firecrackers &middot; Offline</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto bg-muted/30">
          <ActivePage />
        </main>
      </div>
    </div>
  )
}
