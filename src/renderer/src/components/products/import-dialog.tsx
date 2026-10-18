import { useEffect, useState } from 'react'
import { FileWarning, Loader2, TableProperties } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useProductsStore } from '@/store/products-store'
import { parseCsvRawAsync } from '@shared/csv'
import {
  IGNORED_CSV_HEADERS,
  PRODUCT_CSV_FIELDS,
  autoDetectProductMapping,
  csvRowToProductInput,
  normalizeForMapping,
  validateProductInput,
  type DuplicateStrategy,
  type ProductCsvField,
  type ProductImportSummary
} from '@shared/products'

type Stage = 'pick' | 'mapping' | 'preview' | 'importing' | 'done' | 'failed'

interface EvaluatedRow {
  sourceRow: number
  input: Record<string, unknown>
  errors: Record<string, string>
  warnings: string[]
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const FIELD_LABELS: Record<ProductCsvField, string> = {
  productCode: 'Product code',
  productName: 'Product name',
  category: 'Category',
  brand: 'Brand',
  rate: 'Rate (₹)',
  discount: 'Discount (combined)',
  discountType: 'Discount type',
  discountValue: 'Discount value',
  finalRate: 'Final rate (₹)',
  greenCracker: 'Green cracker',
  description: 'Description',
  image: 'Image',
  ignore: '— ignore —'
}

export function ImportCsvDialog({ open, onOpenChange }: Props) {
  const importProducts = useProductsStore((s) => s.importProducts)

  const [stage, setStage] = useState<Stage>('pick')
  const [busy, setBusy] = useState(false)
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [dataRows, setDataRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Record<string, ProductCsvField>>({})
  const [evaluated, setEvaluated] = useState<EvaluatedRow[]>([])
  const [strategy, setStrategy] = useState<DuplicateStrategy>('skip')
  const [summary, setSummary] = useState<ProductImportSummary | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setStage('pick')
      setBusy(false)
      setFileName('')
      setHeaders([])
      setDataRows([])
      setMapping({})
      setEvaluated([])
      setStrategy('skip')
      setSummary(null)
      setFailure(null)
    }
  }, [open])

  // ─── Step 1: pick + parse ────────────────────────────────────────────
  const pickFile = async () => {
    setBusy(true)
    setFailure(null)
    try {
      const picked = await window.kpr.files.pickCsv()
      if (picked.canceled || !picked.content) {
        setBusy(false)
        return
      }
      setFileName(picked.fileName ?? 'selected file')
      const raw = await parseCsvRawAsync(picked.content)
      const nonEmpty = raw.filter((r) => !(r.length === 1 && r[0].trim() === ''))
      if (nonEmpty.length < 2) {
        setFailure('The file has no data rows (header + at least one row required).')
        setBusy(false)
        return
      }
      const hs = nonEmpty[0].map((h) => h.trim())
      setHeaders(hs)
      setDataRows(nonEmpty.slice(1))
      setMapping(autoDetectProductMapping(hs))
      setStage('mapping')
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Could not read the file.')
    } finally {
      setBusy(false)
    }
  }

  // ─── Step 2 → 3: evaluate rows against the mapping ───────────────────
  const evaluate = () => {
    const rows: EvaluatedRow[] = []
    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i]
      const sourceRow = i + 1
      if (cells.length !== headers.length) {
        rows.push({
          sourceRow,
          input: {},
          errors: { _: `Expected ${headers.length} columns but found ${cells.length}.` },
          warnings: []
        })
        continue
      }
      const rowObj: Record<string, string> = {}
      headers.forEach((h, c) => {
        rowObj[h] = (cells[c] ?? '').trim()
      })
      const mapped = csvRowToProductInput(rowObj, mapping)
      const shared = validateProductInput(mapped.input)
      const errors = { ...mapped.errors, ...shared.errors }
      rows.push({ sourceRow, input: mapped.input, errors, warnings: mapped.warnings })
    }
    setEvaluated(rows)
    setStage('preview')
  }

  // ─── Step 4: commit ──────────────────────────────────────────────────
  const commit = async () => {
    setStage('importing')
    const items = evaluated
      .filter((r) => Object.keys(r.errors).length === 0)
      .map((r) => ({ sourceRow: r.sourceRow, input: r.input }))
    const res = await importProducts(items, strategy)
    if (res.ok) {
      setSummary(res.summary)
      setStage('done')
    } else {
      setFailure(res.error.message)
      setStage('failed')
    }
  }

  const validCount = evaluated.filter((r) => Object.keys(r.errors).length === 0).length
  const invalidRows = evaluated.filter((r) => Object.keys(r.errors).length > 0)
  const warningRows = evaluated.filter((r) => r.warnings.length > 0)

  const firstErrorMessage = (r: EvaluatedRow): string =>
    r.errors['_'] ?? Object.values(r.errors)[0] ?? 'Invalid row.'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import products from CSV</DialogTitle>
          <DialogDescription>
            The original CSV file is never modified. Nothing is written to the database until you
            confirm the import.
          </DialogDescription>
        </DialogHeader>

        {failure && (
          <p className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <FileWarning className="size-4" /> {failure}
          </p>
        )}

        {stage === 'pick' && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <TableProperties className="size-10 text-muted-foreground" />
            <p className="max-w-md text-sm text-muted-foreground">
              Select a CSV file. Known columns (productCode, productName, category, brand, rate,
              discount, finalRate, greenCracker, description, image) are mapped automatically.
              Stock columns are always ignored — this app does not track inventory.
            </p>
            <Button onClick={() => void pickFile()} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Select CSV file…
            </Button>
          </div>
        )}

        {stage === 'mapping' && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              File <span className="font-medium">{fileName}</span> — {dataRows.length} data rows.
              Detected columns:
            </p>
            <div className="max-h-64 overflow-y-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 text-left">CSV column</th>
                    <th className="px-3 py-1.5 text-left">Maps to</th>
                  </tr>
                </thead>
                <tbody>
                  {headers.map((h) => (
                    <tr key={h} className="border-b last:border-b-0">
                      <td className="px-3 py-1.5 font-mono text-xs">{h}</td>
                      <td className="px-3 py-1.5">
                        {IGNORED_CSV_HEADERS.includes(normalizeForMapping(h)) ? (
                          <span className="text-xs italic text-muted-foreground">
                            ignored — no stock tracking
                          </span>
                        ) : (
                          <select
                            value={mapping[h]}
                            onChange={(e) =>
                              setMapping((m) => ({ ...m, [h]: e.target.value as ProductCsvField }))
                            }
                            className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                          >
                            {PRODUCT_CSV_FIELDS.map((f) => (
                              <option key={f} value={f}>
                                {FIELD_LABELS[f]}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStage('pick')}>
                Back
              </Button>
              <Button onClick={evaluate}>Preview rows</Button>
            </DialogFooter>
          </div>
        )}

        {(stage === 'preview' || stage === 'importing') && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-md bg-muted px-2 py-1">{evaluated.length} rows</span>
              <span className="rounded-md bg-emerald-100 px-2 py-1 text-emerald-800">{validCount} valid</span>
              <span className="rounded-md bg-red-100 px-2 py-1 text-red-800">{invalidRows.length} invalid (will be skipped)</span>
              <span className="rounded-md bg-amber-100 px-2 py-1 text-amber-800">{warningRows.length} with warnings</span>
            </div>

            <div className="max-h-44 overflow-y-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted text-left">
                  <tr>
                    <th className="px-2 py-1">#</th>
                    <th className="px-2 py-1">Code</th>
                    <th className="px-2 py-1">Name</th>
                    <th className="px-2 py-1">Category</th>
                    <th className="px-2 py-1">Brand</th>
                    <th className="px-2 py-1 text-right">Rate ₹</th>
                    <th className="px-2 py-1 text-right">Final ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {evaluated.slice(0, 100).map((r) => (
                    <tr key={r.sourceRow} className={Object.keys(r.errors).length > 0 ? 'bg-red-50 text-red-900' : ''}>
                      <td className="px-2 py-1 tabular-nums">{r.sourceRow}</td>
                      <td className="px-2 py-1">{String(r.input.productCode ?? '')}</td>
                      <td className="max-w-52 truncate px-2 py-1">{String(r.input.productName ?? '')}</td>
                      <td className="px-2 py-1">{String(r.input.category ?? '')}</td>
                      <td className="px-2 py-1">{String(r.input.brand ?? '')}</td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {typeof r.input.ratePaise === 'number' ? (r.input.ratePaise / 100).toFixed(2) : ''}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {typeof r.input.finalRatePaise === 'number' ? (r.input.finalRatePaise / 100).toFixed(2) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {evaluated.length > 100 && (
              <p className="text-xs text-muted-foreground">Preview shows the first 100 rows.</p>
            )}

            {invalidRows.length > 0 && (
              <details className="rounded-md border bg-muted/30 text-xs">
                <summary className="cursor-pointer px-3 py-2 font-medium">
                  Show invalid rows ({invalidRows.length})
                </summary>
                <ul className="max-h-40 space-y-1 overflow-y-auto px-3 pb-2">
                  {invalidRows.slice(0, 200).map((r) => (
                    <li key={r.sourceRow}>
                      <span className="font-mono">Row {r.sourceRow}:</span> {firstErrorMessage(r)}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex items-center gap-4 text-sm">
              <span className="font-medium">Duplicate codes:</span>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={strategy === 'skip'} onChange={() => setStrategy('skip')} />
                Skip existing
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={strategy === 'update'} onChange={() => setStrategy('update')} />
                Update existing products
              </label>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setStage('mapping')} disabled={busy}>
                Back
              </Button>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void commit()} disabled={validCount === 0 || stage === 'importing'}>
                {stage === 'importing' && <Loader2 className="size-4 animate-spin" />}
                Import {validCount} product{validCount === 1 ? '' : 's'}
              </Button>
            </DialogFooter>
          </div>
        )}

        {stage === 'done' && summary && (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">Import finished. Database transaction committed.</p>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md border p-3">
                <span className="text-muted-foreground">Inserted</span>
                <div className="text-xl font-bold tabular-nums">{summary.inserted}</div>
              </div>
              <div className="rounded-md border p-3">
                <span className="text-muted-foreground">Updated</span>
                <div className="text-xl font-bold tabular-nums">{summary.updated}</div>
              </div>
              <div className="rounded-md border p-3">
                <span className="text-muted-foreground">Skipped (duplicates)</span>
                <div className="text-xl font-bold tabular-nums">{summary.skipped}</div>
              </div>
              <div className="rounded-md border p-3">
                <span className="text-muted-foreground">Invalid rows</span>
                <div className="text-xl font-bold tabular-nums">{summary.invalid.length}</div>
              </div>
            </div>
            {summary.invalid.length > 0 && (
              <details className="rounded-md border bg-muted/30 text-xs">
                <summary className="cursor-pointer px-3 py-2 font-medium">
                  Skipped invalid rows ({summary.invalid.length})
                </summary>
                <ul className="max-h-40 space-y-1 overflow-y-auto px-3 pb-2">
                  {summary.invalid.map((r) => (
                    <li key={`${r.row}-${r.message}`}>
                      <span className="font-mono">Row {r.row}:</span> {r.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}

        {stage === 'failed' && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => setStage('preview')}>
              Back to preview
            </Button>
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
