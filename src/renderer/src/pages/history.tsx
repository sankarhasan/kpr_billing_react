import { History } from 'lucide-react'
import { PagePlaceholder } from '@/components/page-placeholder'

export function HistoryPage() {
  return (
    <PagePlaceholder
      title="Sales History"
      description="Browse, search and filter past invoices with quick re-print access."
      icon={History}
      phase="Arrives in Phase 5"
    />
  )
}
