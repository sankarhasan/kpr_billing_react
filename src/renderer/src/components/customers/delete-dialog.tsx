import { useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { Customer } from '@shared/customers'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  customer: Customer | null
  onConfirm: () => Promise<void>
}

export function DeleteCustomerDialog({ open, onOpenChange, customer, onConfirm }: Props) {
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    setBusy(true)
    try {
      await onConfirm()
      setBusy(false)
      onOpenChange(false)
    } catch {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete customer?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{customer?.name}</span>
            {customer?.phone ? ` — ${customer.phone}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            If this customer is used by any saved invoice they will be <b>archived</b> (hidden)
            instead of deleted, so invoice history stays intact. Invoice records are never
            removed.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
