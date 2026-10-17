import { Package } from 'lucide-react'
import { PagePlaceholder } from '@/components/page-placeholder'

export function ProductsPage() {
  return (
    <PagePlaceholder
      title="Products"
      description="Manage your firecracker product list: manual entry, edit, and CSV import/export."
      icon={Package}
      phase="Arrives in Phase 2"
    />
  )
}
