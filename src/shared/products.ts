/**
 * Shared product domain logic — pure, dependency-free TypeScript.
 * Used by the main process (repo/IPC validation), the renderer (live
 * validation & previews) and the automated tests.
 *
 * Money rule: all monetary values are stored and computed as INTEGER PAISE.
 * Conversion to/from rupee strings happens only at the UI/CSV edges.
 *
 * Discount model:
 *  - discountType 'none'    -> no discount
 *  - discountType 'percent' -> discountPercent (0..100)
 *  - discountType 'amount'  -> discountAmountPaise (0..rate)
 * finalRatePaise is STORED (not generated) because shops legitimately round
 * final prices (e.g. 4200 - 40% => 2499 instead of 2520). It defaults to the
 * computed value but an explicit override is preserved, never silently altered.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export type DiscountType = 'none' | 'percent' | 'amount'

export interface Product {
  id: number
  productCode: string
  productName: string
  category: string
  brand: string
  ratePaise: number
  discountType: DiscountType
  discountPercent: number
  discountAmountPaise: number
  finalRatePaise: number
  greenCracker: boolean
  description: string
  imagePath: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** Payload accepted by create/update (no server-managed fields). */
export interface ProductInput {
  productCode: string
  productName: string
  category: string
  brand: string
  ratePaise: number
  discountType: DiscountType
  discountPercent: number
  discountAmountPaise: number
  finalRatePaise: number
  greenCracker: boolean
  description: string
  imagePath: string
  /** When true an archived product is re-activated on update. */
  restoreActive?: boolean
}

export interface ProductListParams {
  search?: string
  category?: string
  includeInactive?: boolean
  page?: number
  pageSize?: number
}

export interface ProductListResult {
  items: Product[]
  total: number
  page: number
  pageSize: number
}

// ─── CSV bulk import types ───────────────────────────────────────

export type DuplicateStrategy = 'skip' | 'update'

/** One parsed CSV row awaiting validation/import (sourceRow is 1-based data row). */
export interface ProductImportItem {
  sourceRow: number
  input: Record<string, unknown>
}

export interface ProductImportInvalidRow {
  row: number
  message: string
  errors: Record<string, string>
}

export interface ProductImportSummary {
  requested: number
  inserted: number
  updated: number
  skipped: number
  invalid: ProductImportInvalidRow[]
}

// ─── Structured IPC result types ───────────────────────────────────────

export type IpcErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'DUPLICATE_CODE'
  | 'INVALID_PARAMS'
  | 'DB_ERROR'
  | 'IO_ERROR'
  | 'FILE_TOO_LARGE'
  | 'CANCELLED'

export interface IpcError {
  code: IpcErrorCode
  message: string
  /** Field-level messages keyed by field name (VALIDATION only). */
  fields?: Record<string, string>
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

export function ipcOk<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function ipcErr<T>(code: IpcErrorCode, message: string, fields?: Record<string, string>): IpcResult<T> {
  return { ok: false, error: { code, message, fields } }
}

// ─── Money helpers ─────────────────────────────────────────────────────

/** Absolute upper bound for any money value in paise (₹1 crore). */
export const MAX_Paise = 1_000_000_000

const RUPEES_RE = /^\d{1,9}(\.\d{1,2})?$/

/**
 * Strictly parse a rupee string ("300", "120.50") into paise.
 * Rejects commas, currency symbols, negatives and >2 decimals —
 * user data is never silently modified, invalid input is reported.
 */
export function parseRupeesToPaise(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  if (!RUPEES_RE.test(trimmed)) return null
  const paise = Math.round(Number(trimmed) * 100)
  if (!Number.isFinite(paise) || paise < 0 || paise > MAX_Paise) return null
  return paise
}

/** Format paise as a plain rupee string with exactly 2 decimals ("1234.50"). */
export function paiseToRupeesString(paise: number): string {
  if (!Number.isInteger(paise) || paise < 0) paise = Math.max(0, Math.round(paise || 0))
  return (paise / 100).toFixed(2)
}

/** Format paise for display with Indian-style grouping ("1,23,456.78"). */
export function formatPaiseDisplay(paise: number): string {
  const rupees = Math.floor(paise / 100)
  const frac = String(paise % 100).padStart(2, '0')
  const s = String(rupees)
  if (s.length <= 3) return `${s}.${frac}`
  const head = s.slice(0, s.length - 3)
  const tail = s.slice(s.length - 3)
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}.${frac}`
}

// ─── Discount / final-rate calculation ─────────────────────────────────

/**
 * Default final rate from rate + discount definition.
 * percent uses banker-free simple rounding to whole paise.
 */
export function computeFinalRatePaise(
  ratePaise: number,
  discountType: DiscountType,
  discountPercent: number,
  discountAmountPaise: number
): number {
  if (discountType === 'percent') {
    const cut = Math.round((ratePaise * discountPercent) / 100)
    return Math.max(0, ratePaise - cut)
  }
  if (discountType === 'amount') {
    return Math.max(0, ratePaise - discountAmountPaise)
  }
  return ratePaise
}

export const DISCOUNT_TYPES: DiscountType[] = ['none', 'percent', 'amount']

// ─── Validation ────────────────────────────────────────────────────────

const CODE_RE = /^[A-Za-z0-9._\/-]+$/
const MAX_LEN = { code: 50, name: 200, category: 100, brand: 100, description: 4000, imagePath: 500 }

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

/**
 * Validate an untrusted product input object (from renderer or CSV import).
 * Returns per-field error messages; on success returns a normalized value.
 */
export function validateProductInput(raw: unknown): { errors: Record<string, string>; value: ProductInput } {
  const errors: Record<string, string> = {}
  const o = (raw ?? {}) as Record<string, unknown>

  const code = typeof o.productCode === 'string' ? o.productCode.trim() : ''
  const name = typeof o.productName === 'string' ? o.productName.trim() : ''
  const category = typeof o.category === 'string' ? o.category.trim() : ''
  const brand = typeof o.brand === 'string' ? o.brand.trim() : ''
  const description = typeof o.description === 'string' ? o.description.trim() : ''
  const imagePath = typeof o.imagePath === 'string' ? o.imagePath.trim() : ''

  if (code === '') errors.productCode = 'Product code is required.'
  else if (code.length > MAX_LEN.code) errors.productCode = `Product code must be at most ${MAX_LEN.code} characters.`
  else if (!CODE_RE.test(code)) errors.productCode = 'Product code may contain letters, digits, dot, slash, hyphen and underscore only.'

  if (name === '') errors.productName = 'Product name is required.'
  else if (name.length > MAX_LEN.name) errors.productName = `Product name must be at most ${MAX_LEN.name} characters.`

  if (category.length > MAX_LEN.category) errors.category = 'Category is too long.'
  if (brand.length > MAX_LEN.brand) errors.brand = 'Brand is too long.'
  if (description.length > MAX_LEN.description) errors.description = 'Description is too long.'
  if (imagePath.length > MAX_LEN.imagePath) errors.imagePath = 'Image path is too long.'

  if (!isInt(o.ratePaise)) {
    errors.ratePaise = 'Rate must be a whole number of paise.'
  } else if (o.ratePaise < 0) {
    errors.ratePaise = 'Rate cannot be negative.'
  } else if (o.ratePaise > MAX_Paise) {
    errors.ratePaise = 'Rate is unrealistically large.'
  }

  const discountType: DiscountType = DISCOUNT_TYPES.includes(o.discountType as DiscountType)
    ? (o.discountType as DiscountType)
    : (errors.discountType = 'Discount type must be none, percent or amount.', 'none')

  let discountPercent = 0
  if (discountType === 'percent') {
    if (typeof o.discountPercent !== 'number' || !Number.isFinite(o.discountPercent)) {
      errors.discountPercent = 'Discount percentage must be a number.'
    } else if (o.discountPercent < 0) {
      errors.discountPercent = 'Discount percentage cannot be negative.'
    } else if (o.discountPercent > 100) {
      errors.discountPercent = 'Discount percentage cannot exceed 100%.'
    } else {
      discountPercent = Math.round(o.discountPercent * 100) / 100
    }
  }

  let discountAmountPaise = 0
  if (discountType === 'amount') {
    if (!isInt(o.discountAmountPaise)) {
      errors.discountAmountPaise = 'Discount amount must be a whole number of paise.'
    } else if (o.discountAmountPaise < 0) {
      errors.discountAmountPaise = 'Discount amount cannot be negative.'
    } else if (isInt(o.ratePaise) && o.discountAmountPaise > o.ratePaise) {
      errors.discountAmountPaise = 'Discount amount cannot exceed the rate.'
    } else {
      discountAmountPaise = o.discountAmountPaise
    }
  }

  const hasRateError = errors.ratePaise !== undefined
  let finalRatePaise = 0
  if (!isInt(o.finalRatePaise)) {
    errors.finalRatePaise = 'Final rate must be a whole number of paise.'
  } else if (o.finalRatePaise < 0) {
    errors.finalRatePaise = 'Final rate cannot be negative.'
  } else if (o.finalRatePaise > MAX_Paise) {
    errors.finalRatePaise = 'Final rate is unrealistically large.'
  } else if (!hasRateError && isInt(o.ratePaise) && o.finalRatePaise > o.ratePaise) {
    errors.finalRatePaise = 'Final rate cannot be greater than the rate.'
  } else {
    finalRatePaise = o.finalRatePaise
  }

  return {
    errors,
    value: {
      productCode: code,
      productName: name,
      category,
      brand,
      ratePaise: isInt(o.ratePaise) ? o.ratePaise : 0,
      discountType,
      discountPercent,
      discountAmountPaise,
      finalRatePaise,
      greenCracker: o.greenCracker === true || o.greenCracker === 1,
      description,
      imagePath,
      restoreActive: o.restoreActive === true
    }
  }
}

// ─── CSV field mapping ─────────────────────────────────────────────────

/** Target fields a CSV column can be mapped to. */
export const PRODUCT_CSV_FIELDS = [
  'productCode',
  'productName',
  'category',
  'brand',
  'rate',
  'discount',
  'discountType',
  'discountValue',
  'finalRate',
  'greenCracker',
  'description',
  'image',
  'ignore'
] as const

export type ProductCsvField = (typeof PRODUCT_CSV_FIELDS)[number]

/** Headers we deliberately NEVER import (no stock tracking). */
export const IGNORED_CSV_HEADERS = ['stock', 'instock', 'in_stock', 'quantity', 'qty', 'stockqty']

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Public alias used by the UI to flag ignored (stock) columns. */
export function normalizeForMapping(h: string): string {
  return normalizeHeader(h)
}

const HEADER_ALIASES: Record<string, ProductCsvField> = {
  productcode: 'productCode',
  code: 'productCode',
  sku: 'productCode',
  itemcode: 'productCode',
  productname: 'productName',
  name: 'productName',
  item: 'productName',
  description1: 'productName',
  category: 'category',
  type: 'category',
  brand: 'brand',
  maker: 'brand',
  rate: 'rate',
  price: 'rate',
  salerate: 'rate',
  baseprice: 'rate',
  discount: 'discount',
  discounttype: 'discountType',
  discountvalue: 'discountValue',
  finalrate: 'finalRate',
  finalprice: 'finalRate',
  sellingprice: 'finalRate',
  greencracker: 'greenCracker',
  green: 'greenCracker',
  description: 'description',
  desc: 'description',
  details: 'description',
  image: 'image',
  imagepath: 'image',
  photo: 'image'
}

/** Auto-detect mapping: CSV header -> product field ('ignore' when unmatched or forbidden). */
export function autoDetectProductMapping(headers: string[]): Record<string, ProductCsvField> {
  const map: Record<string, ProductCsvField> = {}
  for (const h of headers) {
    const n = normalizeHeader(h)
    if (IGNORED_CSV_HEADERS.includes(n)) {
      map[h] = 'ignore'
      continue
    }
    map[h] = HEADER_ALIASES[n] ?? 'ignore'
  }
  return map
}

const YES_RE = /^(yes|y|true|1|green)$/i

/**
 * Convert one parsed CSV row (keyed by original header) into a ProductInput.
 * Never throws; collects per-field errors and soft warnings instead.
 * `provided` finalRate is honoured (stores may round); a mismatch with the
 * computed discount produces a warning only.
 */
export function csvRowToProductInput(
  row: Record<string, string>,
  mapping: Record<string, ProductCsvField>
): { input: Record<string, unknown>; errors: Record<string, string>; warnings: string[] } {
  const get = (field: ProductCsvField): string | undefined => {
    for (const [header, mapped] of Object.entries(mapping)) {
      if (mapped === field) {
        const v = row[header]
        if (v !== undefined && v.trim() !== '') return v.trim()
      }
    }
    return undefined
  }

  const errors: Record<string, string> = {}
  const warnings: string[] = []
  const input: Record<string, unknown> = {
    productCode: get('productCode') ?? '',
    productName: get('productName') ?? '',
    category: get('category') ?? '',
    brand: get('brand') ?? '',
    description: get('description') ?? '',
    imagePath: '',
    greenCracker: false,
    discountType: 'none',
    discountPercent: 0,
    discountAmountPaise: 0,
    restoreActive: false
  }

  // rate
  const rateRaw = get('rate')
  let ratePaise = 0
  if (rateRaw === undefined) {
    errors.ratePaise = 'Missing rate column/value.'
  } else {
    const p = parseRupeesToPaise(rateRaw)
    if (p === null) errors.ratePaise = `Invalid rate "${rateRaw}".`
    else ratePaise = p
  }
  input.ratePaise = ratePaise

  // discount: explicit type/value pair wins; otherwise parse combined string.
  const typeRaw = (get('discountType') ?? '').toLowerCase()
  const valueRaw = get('discountValue')
  const comboRaw = get('discount')
  let discountType: DiscountType = 'none'
  let discountPercent = 0
  let discountAmountPaise = 0

  const percentFromText = (s: string): number | null => {
    const m = /^(\d+(?:\.\d+)?)\s*%(?:\s*off)?$/i.exec(s)
    return m ? Number(m[1]) : null
  }

  if (typeRaw === 'percent' || typeRaw === 'amount' || typeRaw === 'none') {
    discountType = typeRaw
    if (typeRaw !== 'none' && valueRaw !== undefined) {
      const v = Number(valueRaw)
      if (!Number.isFinite(v) || v < 0) {
        errors.discountValue = `Invalid discount value "${valueRaw}".`
      } else if (typeRaw === 'percent') {
        discountPercent = v
      } else {
        const p = parseRupeesToPaise(valueRaw)
        if (p === null) errors.discountValue = `Invalid discount amount "${valueRaw}".`
        else discountAmountPaise = p
      }
    } else if (typeRaw !== 'none') {
      errors.discountValue = 'Discount value is required when a discount type is set.'
    }
  } else if (comboRaw !== undefined) {
    const pct = percentFromText(comboRaw)
    if (pct !== null) {
      discountType = 'percent'
      discountPercent = pct
    } else if (/^\d+(\.\d+)?$/.test(comboRaw)) {
      // Plain number in a "discount" column: treat as percent (legacy files
      // commonly write "80" meaning 80%) ONLY when <= 100; otherwise amount.
      const n = Number(comboRaw)
      if (n <= 100) {
        discountType = 'percent'
        discountPercent = n
      } else {
        const p = parseRupeesToPaise(comboRaw)
        if (p === null) errors.discount = `Invalid discount "${comboRaw}".`
        else {
          discountType = 'amount'
          discountAmountPaise = p
        }
      }
    } else {
      errors.discount = `Unrecognised discount format "${comboRaw}".`
    }
  }
  if (discountType === 'percent' && discountPercent > 100) {
    errors.discountPercent = `Discount percentage cannot exceed 100% (got ${discountPercent}%).`
  }
  if (discountType === 'amount' && ratePaise > 0 && discountAmountPaise > ratePaise) {
    errors.discountAmountPaise = 'Discount amount cannot exceed the rate.'
  }
  input.discountType = discountType
  input.discountPercent = discountPercent
  input.discountAmountPaise = discountAmountPaise

  // final rate: honour provided value, otherwise compute; warn on mismatch.
  const computed = computeFinalRatePaise(ratePaise, discountType, discountPercent, discountAmountPaise)
  const finalRaw = get('finalRate')
  let finalPaise = computed
  if (finalRaw !== undefined && errors.ratePaise === undefined && errors.discount === undefined) {
    const p = parseRupeesToPaise(finalRaw)
    if (p === null) {
      errors.finalRate = `Invalid final rate "${finalRaw}".`
    } else if (p > ratePaise) {
      errors.finalRate = `Final rate ${finalRaw} is greater than rate.`
    } else {
      finalPaise = p
      if (Math.abs(p - computed) > 100) {
        warnings.push(
          `finalRate ₹${finalRaw} differs from computed ₹${paiseToRupeesString(computed)} (₹${paiseToRupeesString(Math.abs(p - computed))} apart) — keeping the file value.`
        )
      }
    }
  }
  input.finalRatePaise = finalPaise

  // green cracker flag
  const greenRaw = get('greenCracker')
  if (greenRaw !== undefined) {
    input.greenCracker = YES_RE.test(greenRaw)
  }

  // image: data URLs are handed to main to store locally; remote URLs rejected.
  const imageRaw = get('image')
  if (imageRaw !== undefined) {
    if (/^data:image\/(png|jpe?g|webp);base64,/i.test(imageRaw)) {
      if (imageRaw.length > 10_000_000) {
        warnings.push('Image data URL is too large (>~7MB) — skipped.')
      } else {
        input.imageDataUrl = imageRaw
      }
    } else if (/^https?:\/\//i.test(imageRaw)) {
      warnings.push('Remote image URLs are never downloaded — image skipped.')
    } else {
      input.imagePath = imageRaw
    }
  }

  return { input, errors, warnings }
}

// ─── Product CSV export ────────────────────────────────────────────────

/**
 * Headers used for product CSV export. Round-trip compatible with the
 * importer (explicit discountType/discountValue columns). Stock fields are
 * deliberately NEVER exported.
 */
export const PRODUCT_EXPORT_HEADERS = [
  'productCode',
  'productName',
  'category',
  'brand',
  'rate',
  'discountType',
  'discountValue',
  'finalRate',
  'greenCracker',
  'description',
  'image'
] as const

/** Build export data rows (rupee strings, Yes flags) for the CSV serializer. */
export function productToExportRow(p: Product): string[] {
  const discountValue =
    p.discountType === 'percent'
      ? String(p.discountPercent)
      : p.discountType === 'amount'
        ? paiseToRupeesString(p.discountAmountPaise)
        : ''
  return [
    p.productCode,
    p.productName,
    p.category,
    p.brand,
    paiseToRupeesString(p.ratePaise),
    p.discountType,
    discountValue,
    paiseToRupeesString(p.finalRatePaise),
    p.greenCracker ? 'Yes' : '',
    p.description,
    p.imagePath
  ]
}

export function defaultExportFileName(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `products_export_${y}-${m}-${d}.csv`
}
