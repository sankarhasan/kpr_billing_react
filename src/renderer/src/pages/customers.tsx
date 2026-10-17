import { Users } from 'lucide-react'
import { PagePlaceholder } from '@/components/page-placeholder'

export function CustomersPage() {
  return (
    <PagePlaceholder
      title="Customers"
      description="Save customer details (name, phone, address) and attach them to invoices."
      icon={Users}
      phase="Arrives in Phase 3"
    />
  )
}
