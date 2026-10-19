import type React from 'react'
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCustomersStore } from '@/store/customers-store'
import { validateCustomerInput, type Customer, type CustomerInput } from '@shared/customers'

const labelCls = 'text-xs font-medium text-muted-foreground'
const fieldCls = 'flex flex-col gap-1'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = add mode */
  editing: Customer | null
}

interface FormState {
  name: string
  phone: string
  address: string
  notes: string
  restoreActive: boolean
}

function emptyForm(): FormState {
  return { name: '', phone: '', address: '', notes: '', restoreActive: false }
}

function formFromCustomer(c: Customer): FormState {
  return {
    name: c.name,
    phone: c.phone,
    address: c.address,
    notes: c.notes,
    restoreActive: !c.archivedAt ? false : true
  }
}

export function CustomerFormDialog({ open, onOpenChange, editing }: Props) {
  const [form, setForm] = useState<FormState>(emptyForm())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const createCustomer = useCustomersStore((s) => s.createCustomer)
  const updateCustomer = useCustomersStore((s) => s.updateCustomer)

  useEffect(() => {
    if (open) {
      setForm(editing ? formFromCustomer(editing) : emptyForm())
      setErrors({})
      setSubmitting(false)
    }
  }, [open, editing])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return // guard against accidental double submissions

    const raw = {
      name: form.name,
      phone: form.phone,
      address: form.address,
      notes: form.notes,
      restoreActive: form.restoreActive
    }
    const { errors: localErrors } = validateCustomerInput(raw)
    if (Object.keys(localErrors).length > 0) {
      setErrors(localErrors)
      return
    }

    setSubmitting(true)
    setErrors({})
    const input = raw as unknown as CustomerInput
    const res = editing ? await updateCustomer(editing.id, input) : await createCustomer(input)
    setSubmitting(false)

    if (res.ok) {
      onOpenChange(false)
    } else {
      setErrors(res.error.fields ?? { _: res.error.message })
    }
  }

  const fieldErrText = (field: string) =>
    errors[field] ? <p className="text-xs text-destructive">{errors[field]}</p> : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit Customer' : 'Add Customer'}</DialogTitle>
          <DialogDescription>
            Only the name is required. Phone, address and notes help identify the customer on
            invoices later.
          </DialogDescription>
        </DialogHeader>

        {errors['_'] && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{errors['_']}</p>
        )}

        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="cf-name">Customer name *</label>
              <Input
                id="cf-name"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                autoFocus
                placeholder="Ramesh Kumar"
              />
              {fieldErrText('name')}
            </div>
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="cf-phone">Phone</label>
              <Input
                id="cf-phone"
                inputMode="tel"
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
                placeholder="98765 43210"
              />
              {fieldErrText('phone')}
            </div>
          </div>

          <div className={fieldCls}>
            <label className={labelCls} htmlFor="cf-address">Address</label>
            <textarea
              id="cf-address"
              rows={2}
              value={form.address}
              onChange={(e) => set('address', e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              placeholder="Street, area, city"
            />
            {fieldErrText('address')}
          </div>

          <div className={fieldCls}>
            <label className={labelCls} htmlFor="cf-notes">Notes</label>
            <textarea
              id="cf-notes"
              rows={2}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              placeholder="e.g. Regular buyer — prefers large boxes"
            />
            {fieldErrText('notes')}
          </div>

          {editing && editing.archivedAt && (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={form.restoreActive}
                onChange={(e) => set('restoreActive', e.target.checked)}
              />
              Restore archived customer
            </label>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {editing ? 'Save changes' : 'Add customer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
