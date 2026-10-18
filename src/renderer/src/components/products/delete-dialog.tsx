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
import type { Product } from '@shared/products'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  product: Product | null
  onConfirm: () => Promise<void>
}

export function DeleteProductDialog({ open, onOpenChange, product, onConfirm }: Props) {
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
          <DialogTitle>Delete product?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{product?.productCode}</span> —{' '}
            {product?.productName}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            If this product appears in any saved invoice it will be <b>archived</b> (hidden from
            new bills) instead of deleted, so invoice history stays intact. Invoice records are
            never removed.
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
