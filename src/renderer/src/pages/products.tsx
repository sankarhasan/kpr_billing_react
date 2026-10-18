import { useEffect, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { ProductFormDialog } from '@/components/products/product-form-dialog'
import { DeleteProductDialog } from '@/components/products/delete-dialog'
import { ImportCsvDialog } from '@/components/products/import-dialog'
import { PAGE_SIZE_OPTIONS, useProductsStore } from '@/store/products-store'
import { toCsv } from '@shared/csv'
import {
  PRODUCT_EXPORT_HEADERS,
  formatPaiseDisplay,
  defaultExportFileName,
  productToExportRow,
  type Product
} from '@shared/products'

/** Search debounce (ms). */
const SEARCH_DEBOUNCE = 350

export function ProductsPage() {
  const {
    items,
    total,
    page,
    pageSize,
    loading,
    error,
    statusMessage,
    categories,
    categoryFilter,
    showInactive,
    setFilters,
    setPage,
    load,
    loadCategories,
    deleteProduct,
    setStatus
  } = useProductsStore()

  const [searchInput, setSearchInput] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Initial load
  useEffect(() => {
    void load()
    void loadCategories()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters({ search: searchInput })
    }, SEARCH_DEBOUNCE)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  // Auto-clear status messages
  useEffect(() => {
    if (statusMessage) {
      const t = setTimeout(() => setStatus(null), 5000)
      return () => clearTimeout(t)
    }
  }, [statusMessage, setStatus])

  const openAdd = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = (p: Product) => {
    setEditing(p)
    setFormOpen(true)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    await deleteProduct(deleteTarget.id)
    setDeleteTarget(null)
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const all = await useProductsStore.getState().fetchAllForExport()
      const rows = all.map(productToExportRow)
      const csv = toCsv(PRODUCT_EXPORT_HEADERS, rows)
      const res = await window.kpr.files.saveCsv({
        defaultFileName: defaultExportFileName(),
        content: csv
      })
      if (!res.canceled && res.filePath) {
        setStatus(`Exported ${all.length} products to ${res.filePath}`)
      }
    } catch (err) {
      setStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExporting(false)
    }
  }

  const discountLabel = (p: Product): string => {
    if (p.discountType === 'percent') {
      return `${p.discountPercent}%`
    }
    if (p.discountType === 'amount') {
      return `₹${formatPaiseDisplay(p.discountAmountPaise)}`
    }
    return '—'
  }

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  const lastPage = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="flex h-full flex-col gap-3 p-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search code or name…"
            className="w-60 pl-8"
            aria-label="Search products"
          />
        </div>

        <select
          value={categoryFilter}
          onChange={(e) => setFilters({ categoryFilter: e.target.value })}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          aria-label="Filter by category"
        >
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setFilters({ showInactive: e.target.checked })}
          />
          Show archived
        </label>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload /> Import CSV
          </Button>
          <Button variant="outline" onClick={() => void handleExport()} disabled={exporting}>
            {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download />} Export CSV
          </Button>
          <Button onClick={openAdd}>
            <Plus /> Add Product
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <button type="button" onClick={() => useProductsStore.getState().clearError()}>
            <X className="size-4" />
          </button>
        </div>
      )}

      {statusMessage && (
        <div className="flex items-center justify-between rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <span>{statusMessage}</span>
          <button type="button" onClick={() => setStatus(null)}>
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* Table */}
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10">
                <TableRow>
                  <TableHead className="w-28">Code</TableHead>
                  <TableHead>Product name</TableHead>
                  <TableHead className="w-24">Category</TableHead>
                  <TableHead className="w-32">Brand</TableHead>
                  <TableHead className="w-28 text-right">Rate</TableHead>
                  <TableHead className="w-24 text-right">Discount</TableHead>
                  <TableHead className="w-28 text-right">Final rate</TableHead>
                  <TableHead className="w-20 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                      <Loader2 className="mr-2 inline size-4 animate-spin" />
                      Loading products…
                    </TableCell>
                  </TableRow>
                )}

                {!loading && items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                      {total === 0
                        ? 'No products yet. Use “Add Product” to create one or “Import CSV” to load your list.'
                        : 'No products match the current search / filters.'}
                    </TableCell>
                  </TableRow>
                )}

                {items.map((p) => (
                  <TableRow key={p.id} className={p.isActive ? '' : 'opacity-50'}>
                    <TableCell className="font-mono text-xs">{p.productCode}</TableCell>
                    <TableCell className="max-w-96 truncate whitespace-normal">
                      <span className="flex items-center gap-1.5">
                        {p.productName}
                        {p.greenCracker && (
                          <Badge variant="success" className="px-1.5 py-0 text-[10px]">
                            Green
                          </Badge>
                        )}
                        {!p.isActive && (
                          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                            Archived
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>{p.category || '—'}</TableCell>
                    <TableCell className="truncate">{p.brand || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">₹{formatPaiseDisplay(p.ratePaise)}</TableCell>
                    <TableCell className="text-right tabular-nums">{discountLabel(p)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      ₹{formatPaiseDisplay(p.finalRatePaise)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="size-7" onClick={() => openEdit(p)} aria-label={`Edit ${p.productCode}`}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-destructive"
                          onClick={() => setDeleteTarget(p)}
                          aria-label={`Delete ${p.productCode}`}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t bg-card px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>
                {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
              </span>
              <select
                value={pageSize}
                onChange={(e) => setFilters({ pageSize: Number(e.target.value) })}
                className="h-7 rounded-md border border-input bg-background px-1.5"
                aria-label="Rows per page"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
                <ChevronLeft className="size-3.5" /> Prev
              </Button>
              <span className="px-2 tabular-nums">
                {page} / {lastPage}
              </span>
              <Button variant="outline" size="sm" disabled={page >= lastPage || loading} onClick={() => setPage(page + 1)}>
                Next <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Dialogs */}
      <ProductFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editing} />
      <DeleteProductDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        product={deleteTarget}
        onConfirm={handleDelete}
      />
      <ImportCsvDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  )
}
