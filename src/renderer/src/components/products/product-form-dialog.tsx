import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Image as ImageIcon, Loader2 } from 'lucide-react'

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
import { useProductsStore } from '@/store/products-store'
import {
  computeFinalRatePaise,
  formatPaiseDisplay,
  paiseToRupeesString,
  parseRupeesToPaise,
  validateProductInput,
  type DiscountType,
  type Product,
  type ProductInput
} from '@shared/products'

const labelCls = 'text-xs font-medium text-muted-foreground'
const fieldCls = 'flex flex-col gap-1'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = add mode */
  editing: Product | null
}

interface FormState {
  code: string
  name: string
  category: string
  brand: string
  rateText: string
  discountType: DiscountType
  discountText: string
  finalMode: 'auto' | 'manual'
  finalText: string
  green: boolean
  description: string
  imageFileName: string
  imagePreviewUrl: string
  restoreActive: boolean
}

function emptyForm(): FormState {
  return {
    code: '',
    name: '',
    category: '',
    brand: '',
    rateText: '',
    discountType: 'none',
    discountText: '',
    finalMode: 'auto',
    finalText: '',
    green: false,
    description: '',
    imageFileName: '',
    imagePreviewUrl: '',
    restoreActive: false
  }
}

function formFromProduct(p: Product): FormState {
  return {
    code: p.productCode,
    name: p.productName,
    category: p.category,
    brand: p.brand,
    rateText: paiseToRupeesString(p.ratePaise),
    discountType: p.discountType,
    discountText:
      p.discountType === 'percent'
        ? String(p.discountPercent)
        : p.discountType === 'amount'
          ? paiseToRupeesString(p.discountAmountPaise)
          : '',
    finalMode: 'manual',
    finalText: paiseToRupeesString(p.finalRatePaise),
    green: p.greenCracker,
    description: p.description,
    imageFileName: p.imagePath,
    imagePreviewUrl: '',
    restoreActive: !p.isActive
  }
}

export function ProductFormDialog({ open, onOpenChange, editing }: Props) {
  const [form, setForm] = useState<FormState>(emptyForm())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const categories = useProductsStore((s) => s.categories)
  const createProduct = useProductsStore((s) => s.createProduct)
  const updateProduct = useProductsStore((s) => s.updateProduct)

  useEffect(() => {
    if (open) {
      setForm(editing ? formFromProduct(editing) : emptyForm())
      setErrors({})
      setSubmitting(false)
    }
  }, [open, editing])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  // ─── Live final-rate preview ────────────────────────────────────────
  const ratePaise = useMemo(() => parseRupeesToPaise(form.rateText), [form.rateText])
  const discountPercent = form.discountType === 'percent' ? Number(form.discountText || '0') : 0
  const discountAmountPaise =
    form.discountType === 'amount' ? (parseRupeesToPaise(form.discountText) ?? 0) : 0

  const computedFinal = useMemo(
    () =>
      ratePaise === null
        ? null
        : computeFinalRatePaise(ratePaise, form.discountType, discountPercent, discountAmountPaise),
    [ratePaise, form.discountType, discountPercent, discountAmountPaise]
  )

  const manualFinalPaise = useMemo(() => parseRupeesToPaise(form.finalText), [form.finalText])

  const previewFinal =
    form.finalMode === 'auto'
      ? computedFinal !== null
        ? formatPaiseDisplay(computedFinal)
        : '—'
      : manualFinalPaise !== null
        ? formatPaiseDisplay(manualFinalPaise)
        : '—'

  // Switch back to auto when the user changes rate/discount.
  const onAutoOrManual = (mode: 'auto' | 'manual') => {
    set('finalMode', mode)
    if (mode === 'manual' && form.finalText === '' && computedFinal !== null) {
      set('finalText', paiseToRupeesString(computedFinal))
    }
  }

  // ─── Submit ─────────────────────────────────────────────────────────
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const localErrors: Record<string, string> = {}

    if (ratePaise === null) localErrors.ratePaise = 'Enter a valid rate, e.g. 300 or 120.50.'

    let discountField: Record<string, string> = {}
    if (form.discountType === 'percent' && (form.discountText === '' || !Number.isFinite(Number(form.discountText)))) {
      discountField = { discountPercent: 'Enter a percentage, e.g. 20.' }
    }
    if (form.discountType === 'percent' && Number(form.discountText) > 100) {
      discountField = { discountPercent: 'Discount percentage cannot exceed 100%.' }
    }
    if (form.discountType === 'amount' && parseRupeesToPaise(form.discountText) === null) {
      discountField = { discountAmountPaise: 'Enter a valid discount amount, e.g. 50 or 25.50.' }
    }

    let finalPaise: number | null
    if (form.finalMode === 'auto') {
      finalPaise = computedFinal
      if (finalPaise === null) {
        // rate invalid; validator will report rate error, keep placeholder
        finalPaise = 0
      }
    } else {
      finalPaise = manualFinalPaise
      if (finalPaise === null) localErrors.finalRatePaise = 'Enter a valid final rate.'
    }

    const raw = {
      productCode: form.code,
      productName: form.name,
      category: form.category,
      brand: form.brand,
      ratePaise: ratePaise ?? 0,
      discountType: form.discountType,
      discountPercent: form.discountType === 'percent' ? Number(form.discountText || '0') : 0,
      discountAmountPaise:
        form.discountType === 'amount' ? (parseRupeesToPaise(form.discountText) ?? 0) : 0,
      finalRatePaise: finalPaise ?? 0,
      greenCracker: form.green,
      description: form.description,
      imagePath: form.imageFileName,
      restoreActive: form.restoreActive
    }

    const { errors: sharedErrors } = validateProductInput(raw)
    const allErrors = { ...localErrors, ...discountField, ...sharedErrors }
    if (Object.keys(allErrors).length > 0) {
      setErrors(allErrors)
      return
    }

    setSubmitting(true)
    setErrors({})
    const input = raw as unknown as ProductInput
    const res = editing
      ? await updateProduct(editing.id, input)
      : await createProduct(input)
    setSubmitting(false)

    if (res.ok) {
      onOpenChange(false)
    } else {
      setErrors(res.error.fields ?? { _: res.error.message })
    }
  }

  // ─── Image picker ───────────────────────────────────────────────────
  const pickImage = async () => {
    const res = await window.kpr.files.pickImage()
    if (res.canceled || !res.fileName) return
    set('imageFileName', res.fileName)
    set('imagePreviewUrl', res.previewDataUrl ?? '')
  }

  const err = (field: string): string | undefined => errors[field]
  const fieldErrText = (field: string) =>
    err(field) ? <p className="text-xs text-destructive">{err(field)}</p> : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit Product' : 'Add Product'}</DialogTitle>
          <DialogDescription>
            Rates are stored exactly as entered (in paise). The final rate is calculated from the
            discount unless you override it.
          </DialogDescription>
        </DialogHeader>

        {errors['_'] && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{errors['_']}</p>}

        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="pf-code">Product code *</label>
              <Input id="pf-code" value={form.code} onChange={(e) => set('code', e.target.value)} autoFocus placeholder="A1" />
              {fieldErrText('productCode')}
            </div>
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="pf-name">Product name *</label>
              <Input id="pf-name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="10 cm Green Sparkles" />
              {fieldErrText('productName')}
            </div>
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="pf-category">Category</label>
              <Input id="pf-category" list="pf-categories" value={form.category} onChange={(e) => set('category', e.target.value)} placeholder="A" />
              <datalist id="pf-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              {fieldErrText('category')}
            </div>
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="pf-brand">Brand</label>
              <Input id="pf-brand" value={form.brand} onChange={(e) => set('brand', e.target.value)} placeholder="SUPREME" />
              {fieldErrText('brand')}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="pf-rate">Rate (₹) *</label>
              <Input id="pf-rate" inputMode="decimal" value={form.rateText} onChange={(e) => set('rateText', e.target.value)} placeholder="300" />
              {fieldErrText('ratePaise')}
            </div>
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="pf-dtype">Discount</label>
              <select
                id="pf-dtype"
                value={form.discountType}
                onChange={(e) => set('discountType', e.target.value as DiscountType)}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="none">None</option>
                <option value="percent">Percent (%)</option>
                <option value="amount">Amount (₹)</option>
              </select>
            </div>
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="pf-dvalue">
                {form.discountType === 'percent' ? 'Percent (0–100)' : form.discountType === 'amount' ? 'Amount (₹)' : '—'}
              </label>
              <Input
                id="pf-dvalue"
                inputMode="decimal"
                disabled={form.discountType === 'none'}
                value={form.discountText}
                onChange={(e) => set('discountText', e.target.value)}
              />
              {fieldErrText('discountPercent') || fieldErrText('discountAmountPaise') || fieldErrText('discountValue')}
            </div>
          </div>

          <div className="flex items-end gap-3 rounded-md border bg-muted/40 px-3 py-2">
            <div className="flex flex-1 flex-col gap-1">
              <span className={labelCls}>Final rate</span>
              <span className="text-lg font-bold tabular-nums">₹{previewFinal}</span>
            </div>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="radio"
                name="pf-final"
                checked={form.finalMode === 'auto'}
                onChange={() => onAutoOrManual('auto')}
              />
              Auto
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="radio"
                name="pf-final"
                checked={form.finalMode === 'manual'}
                onChange={() => onAutoOrManual('manual')}
              />
              Manual
            </label>
            {form.finalMode === 'manual' && (
              <div className="w-32">
                <Input
                  inputMode="decimal"
                  aria-label="Manual final rate (₹)"
                  value={form.finalText}
                  onChange={(e) => set('finalText', e.target.value)}
                  placeholder={computedFinal !== null ? paiseToRupeesString(computedFinal) : '0'}
                />
              </div>
            )}
            {fieldErrText('finalRatePaise')}
          </div>

          <div className={fieldCls}>
            <label className={labelCls} htmlFor="pf-desc">Description</label>
            <textarea
              id="pf-desc"
              rows={3}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            {fieldErrText('description')}
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs text-muted-foreground">
                {form.imageFileName || 'No image'}
              </span>
              {form.imagePreviewUrl && (
                <img
                  src={form.imagePreviewUrl}
                  alt="Product preview"
                  className="h-10 w-10 rounded border object-contain"
                />
              )}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void pickImage()}>
              Choose image…
            </Button>
          </div>

          <div className="flex items-center gap-5">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={form.green} onChange={(e) => set('green', e.target.checked)} />
              Green cracker
            </label>
            {editing && !editing.isActive && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={form.restoreActive}
                  onChange={(e) => set('restoreActive', e.target.checked)}
                />
                Restore archived product
              </label>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {editing ? 'Save changes' : 'Add product'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
