import { ReceiptText } from 'lucide-react'
import { PagePlaceholder } from '@/components/page-placeholder'

export function BillingPage() {
  return (
    <PagePlaceholder
      title="Billing"
      description="Create new invoices with a fast, keyboard-friendly billing screen tailored for counter sales."
      icon={ReceiptText}
      phase="Arrives in Phase 4"
    />
  )
}
