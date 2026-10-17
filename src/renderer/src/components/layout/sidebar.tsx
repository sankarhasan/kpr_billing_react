import {
  LayoutDashboard,
  ReceiptText,
  Package,
  Users,
  History,
  Settings,
  Flame,
  WifiOff
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useUiStore, type PageId } from '@/store/ui-store'

interface NavItem {
  id: PageId
  label: string
  icon: LucideIcon
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'billing', label: 'Billing', icon: ReceiptText },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'customers', label: 'Customers', icon: Users },
  { id: 'history', label: 'Sales History', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings }
]

export function Sidebar() {
  const currentPage = useUiStore((s) => s.currentPage)
  const setPage = useUiStore((s) => s.setPage)

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900 text-slate-100">
      {/* Brand */}
      <div className="flex items-center gap-2.5 border-b border-slate-800 px-4 py-3.5">
        <div className="flex size-8 items-center justify-center rounded-md bg-primary">
          <Flame className="size-4.5 text-primary-foreground" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-bold tracking-wide">KPR Billing</div>
          <div className="text-[11px] text-slate-400">Firecrackers Shop</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2.5">
        {NAV_ITEMS.map((item) => {
          const active = currentPage === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setPage(item.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              )}
            >
              <item.icon className="size-4 shrink-0" />
              {item.label}
            </button>
          )
        })}
      </nav>

      {/* Footer status */}
      <div className="border-t border-slate-800 px-4 py-2.5">
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
          <WifiOff className="size-3.5" />
          Works fully offline
        </div>
      </div>
    </aside>
  )
}
