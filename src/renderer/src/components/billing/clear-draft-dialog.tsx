import { useRef } from 'react'
import { AlertTriangle } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called ONLY on explicit confirmation — clears the draft (synchronous). */
  onConfirm: () => void
}

/**
 * Accessible confirmation for "Clear draft". Opening the dialog never
 * touches the draft; only the explicit "Clear Draft" button confirms.
 * Escape / outside-click / Cancel dismiss WITHOUT clearing, and Radix
 * returns focus to the trigger (the Clear draft button). After an explicit
 * confirm the parent takes over focus (product search) via onCloseAutoFocus.
 */
export function ClearDraftDialog({ open, onOpenChange, onConfirm }: Props) {
  const confirmedRef = useRef(false)

  const confirm = () => {
    if (confirmedRef.current) return // guard against double-activation
    confirmedRef.current = true
    onConfirm()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
      <DialogContent
        className="max-w-md"
        onCloseAutoFocus={(e) => {
          // Confirm path: the page moves focus to the product search itself.
          // Cancel path: fall through so Radix restores focus to the trigger.
          if (confirmedRef.current) {
            confirmedRef.current = false
            e.preventDefault()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />
            Clear current invoice?
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to clear this invoice draft? All products, quantities,
            customer details, and notes entered in the current draft will be removed.
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Saved invoices, products, customers and settings are NOT affected — only the
          unsaved draft on this page is cleared.
        </p>

        <DialogFooter>
          {/* Cancel is first so it receives the initial focus (safe default). */}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm}>
            Clear Draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
