/**
 * Product data-access layer. Pure module (no Electron imports): it takes a
 * better-sqlite3 Database instance so it can run in the main process AND in
 * plain Node automated tests. All SQL is parameterized.
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  validateProductInput,
  type IpcResult,
  type Product,
  type ProductInput,
  type ProductListParams,
  type ProductListResult,
  type DuplicateStrategy,
  type ProductImportItem,
  type ProductImportSummary,
  type ProductImportInvalidRow,
  ipcOk,
  ipcErr
} from '../../shared/products.ts'

type Db = Database.Database

// ─── Row mapping ───────────────────────────────────────────────────────

interface ProductRow {
  id: number
  product_code: string
  product_name: string
  category: string
  brand: string
  rate_paise: number
  discount_type: string
  discount_percent: number
  discount_amount_paise: number
  final_rate_paise: number
  green_cracker: number
  description: string
  image_path: string
  is_active: number
  created_at: string
  updated_at: string
}

function mapRow(r: ProductRow): Product {
  return {
    id: r.id,
    productCode: r.product_code,
    productName: r.product_name,
    category: r.category,
    brand: r.brand,
    ratePaise: r.rate_paise,
    discountType: (['none', 'percent', 'amount'].includes(r.discount_type)
      ? r.discount_type
      : 'none') as Product['discountType'],
    discountPercent: r.discount_percent,
    discountAmountPaise: r.discount_amount_paise,
    finalRatePaise: r.final_rate_paise,
    greenCracker: r.green_cracker === 1,
    description: r.description,
    imagePath: r.image_path,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

const SELECT_COLS = `
  id, product_code, product_name, category, brand, rate_paise, discount_type,
  discount_percent, discount_amount_paise, final_rate_paise, green_cracker,
  description, image_path, is_active, created_at, updated_at
`

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown }).code === 'string' &&
    String((err as unknown as { code: string }).code).startsWith('SQLITE_CONSTRAINT_UNIQUE')
  )
}

// ─── Queries ───────────────────────────────────────────────────────────

export function listProducts(db: Db, params: ProductListParams = {}): ProductListResult {
  const page = Math.max(1, Math.floor(params.page ?? 1))
  const pageSize = Math.min(500, Math.max(1, Math.floor(params.pageSize ?? 25)))
  const where: string[] = []
  const bind: Record<string, unknown> = {}

  if (!params.includeInactive) where.push('is_active = 1')

  if (params.category && params.category !== 'all') {
    where.push('category = @category')
    bind.category = params.category
  }

  if (params.search && params.search.trim() !== '') {
    // Escape LIKE wildcards in user input.
    const term = params.search.trim().replace(/[%_]/g, (m) => `\\${m}`)
    where.push(`(product_code LIKE @term ESCAPE '\\' OR product_name LIKE @term ESCAPE '\\')`)
    bind.term = `%${term}%`
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const total =
    db
      .prepare<Record<string, unknown>, { c: number }>(
        `SELECT COUNT(*) AS c FROM products ${whereSql}`
      )
      .get(bind)?.c ?? 0

  const items = (
    db
      .prepare<Record<string, unknown>, ProductRow>(
        `SELECT ${SELECT_COLS} FROM products ${whereSql} ORDER BY id LIMIT @limit OFFSET @offset`
      )
      .all({ ...bind, limit: pageSize, offset: (page - 1) * pageSize }) ?? []
  ).map(mapRow)

  return { items, total, page, pageSize }
}

export function getProduct(db: Db, id: number): Product | null {
  const row = db
    .prepare<[{ id: number }], ProductRow>(`SELECT ${SELECT_COLS} FROM products WHERE id = @id`)
    .get({ id })
  return row ? mapRow(row) : null
}

export function listCategories(db: Db): string[] {
  return (
    db
      .prepare<[], { category: string }>(
        `SELECT DISTINCT category FROM products WHERE category <> '' ORDER BY category COLLATE NOCASE`
      )
      .all() ?? []
  ).map((r) => r.category)
}

function codeExists(db: Db, code: string, excludeId?: number): boolean {
  const row = excludeId
    ? db
        .prepare<[{ code: string; id: number }], { c: number }>(
          `SELECT COUNT(*) AS c FROM products WHERE product_code = @code AND id <> @id`
        )
        .get({ code, id: excludeId })?.c
    : db
        .prepare<[{ code: string }], { c: number }>(
          `SELECT COUNT(*) AS c FROM products WHERE product_code = @code`
        )
        .get({ code })?.c
  return (row ?? 0) > 0
}

// ─── Mutations ─────────────────────────────────────────────────────────

export function createProduct(db: Db, rawInput: unknown): IpcResult<Product> {
  const { errors, value } = validateProductInput(rawInput)
  if (Object.keys(errors).length > 0) {
    return ipcErr<Product>('VALIDATION', 'Please correct the highlighted fields.', errors)
  }
  if (codeExists(db, value.productCode)) {
    return ipcErr<Product>(
      'DUPLICATE_CODE',
      `Product code "${value.productCode}" already exists.`,
      { productCode: 'Duplicate product code.' }
    )
  }
  const stmt = db.prepare(`
    INSERT INTO products (
      product_code, product_name, category, brand, rate_paise, discount_type,
      discount_percent, discount_amount_paise, final_rate_paise, green_cracker,
      description, image_path
    ) VALUES (
      @productCode, @productName, @category, @brand, @ratePaise, @discountType,
      @discountPercent, @discountAmountPaise, @finalRatePaise, @greenCrackerBit,
      @description, @imagePath
    )
  `)
  try {
    const info = stmt.run({ ...value, greenCrackerBit: value.greenCracker ? 1 : 0 })
    const created = getProduct(db, Number(info.lastInsertRowid))
    if (!created) return ipcErr<Product>('DB_ERROR', 'Product was created but could not be re-read.')
    return ipcOk(created)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return ipcErr<Product>('DUPLICATE_CODE', `Product code "${value.productCode}" already exists.`, {
        productCode: 'Duplicate product code.'
      })
    }
    throw err
  }
}

export function updateProduct(db: Db, id: number, rawInput: unknown): IpcResult<Product> {
  const existing = getProduct(db, id)
  if (!existing) return ipcErr<Product>('NOT_FOUND', `Product #${id} was not found.`)

  const { errors, value } = validateProductInput(rawInput)
  if (Object.keys(errors).length > 0) {
    return ipcErr<Product>('VALIDATION', 'Please correct the highlighted fields.', errors)
  }
  if (codeExists(db, value.productCode, id)) {
    return ipcErr<Product>(
      'DUPLICATE_CODE',
      `Another product already uses code "${value.productCode}".`,
      { productCode: 'Duplicate product code.' }
    )
  }

  db.prepare(`
    UPDATE products SET
      product_code = @productCode, product_name = @productName, category = @category,
      brand = @brand, rate_paise = @ratePaise, discount_type = @discountType,
      discount_percent = @discountPercent, discount_amount_paise = @discountAmountPaise,
      final_rate_paise = @finalRatePaise, green_cracker = @greenCrackerBit,
      description = @description, image_path = @imagePath,
      is_active = CASE WHEN @restoreActive = 1 THEN 1 ELSE is_active END,
      updated_at = datetime('now', 'localtime')
    WHERE id = @id
  `).run({ ...value, greenCrackerBit: value.greenCracker ? 1 : 0, restoreActive: value.restoreActive ? 1 : 0, id })

  const updated = getProduct(db, id)
  if (!updated) return ipcErr<Product>('DB_ERROR', 'Product was updated but could not be re-read.')
  return ipcOk(updated)
}

/**
 * Safe delete:
 *  - referenced by invoice items  -> archive (is_active = 0); history untouched
 *  - unreferenced                 -> hard delete; orphaned image file removed
 */
export function deleteProduct(
  db: Db,
  id: number,
  imagesDir: string
): IpcResult<{ action: 'deleted' | 'archived'; product: Product }> {
  const product = getProduct(db, id)
  if (!product) return ipcErr<{ action: 'deleted' | 'archived'; product: Product }>('NOT_FOUND', `Product #${id} was not found.`)

  const refs =
    db
      .prepare<[{ id: number }], { c: number }>(
        'SELECT COUNT(*) AS c FROM invoice_items WHERE product_id = @id'
      )
      .get({ id: product.id })?.c ?? 0

  if (refs > 0) {
    db.prepare(
      `UPDATE products SET is_active = 0, updated_at = datetime('now', 'localtime') WHERE id = ?`
    ).run(id)
    const archived = getProduct(db, id)
    if (!archived) return ipcErr<{ action: 'deleted' | 'archived'; product: Product }>('DB_ERROR', 'Archive failed.')
    return ipcOk({ action: 'archived', product: archived })
  }

  db.prepare('DELETE FROM products WHERE id = ?').run(id)

  // Remove the local image file when no other product references it.
  if (product.imagePath && !product.imagePath.startsWith('data:')) {
    const stillUsed =
      db
        .prepare<[{ p: string }], { c: number }>(
          'SELECT COUNT(*) AS c FROM products WHERE image_path = @p'
        )
        .get({ p: product.imagePath })?.c ?? 0
    if (stillUsed === 0) {
      const filePath = join(imagesDir, product.imagePath)
      if (existsSync(filePath)) {
        try {
          rmSync(filePath)
        } catch (err) {
          console.error('[products] failed to remove image file:', err)
        }
      }
    }
  }

  return ipcOk({ action: 'deleted', product })
}

// ─── Bulk CSV import ───────────────────────────────────────────────────

/**
 * Import already-parsed product items inside ONE transaction: either every
 * database write succeeds or nothing is committed (image files are handled
 * by the caller before this runs). Per-row validation problems never abort
 * the batch — they are reported in the summary and their rows skipped.
 */
export function importProducts(
  db: Db,
  items: ProductImportItem[],
  strategy: DuplicateStrategy
): IpcResult<ProductImportSummary> {
  const summary: ProductImportSummary = {
    requested: items.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    invalid: [] as ProductImportInvalidRow[]
  }
  const seenCodesInBatch = new Set<string>()

  const run = db.transaction(() => {
    for (const item of items) {
      const { errors, value } = validateProductInput(item.input)
      if (Object.keys(errors).length > 0) {
        summary.invalid.push({
          row: item.sourceRow,
          message: Object.values(errors)[0] ?? 'Invalid row.',
          errors
        })
        continue
      }

      const duplicateInBatch = seenCodesInBatch.has(value.productCode.toLowerCase())
      const existing = getProductByCode(db, value.productCode)

      if (duplicateInBatch) {
        summary.skipped++
        summary.invalid.push({
          row: item.sourceRow,
          message: `Duplicate code "${value.productCode}" appears more than once in the file.`,
          errors: { productCode: 'Duplicate within file.' }
        })
        continue
      }

      if (existing) {
        if (strategy === 'skip') {
          summary.skipped++
          seenCodesInBatch.add(value.productCode.toLowerCase())
          continue
        }
        const res = updateProduct(db, existing.id, value)
        if (!res.ok) {
          summary.invalid.push({ row: item.sourceRow, message: res.error.message, errors: res.error.fields ?? {} })
          continue
        }
        summary.updated++
      } else {
        const res = createProduct(db, value)
        if (!res.ok) {
          summary.invalid.push({ row: item.sourceRow, message: res.error.message, errors: res.error.fields ?? {} })
          continue
        }
        summary.inserted++
      }
      seenCodesInBatch.add(value.productCode.toLowerCase())
    }
  })

  run()
  return ipcOk(summary)
}

function getProductByCode(db: Db, code: string): Product | null {
  const row = db
    .prepare<[{ code: string }], ProductRow>(
      `SELECT ${SELECT_COLS} FROM products WHERE product_code = @code`
    )
    .get({ code })
  return row ? mapRow(row) : null
}
