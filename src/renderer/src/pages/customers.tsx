import { useEffect, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { CustomerFormDialog } from '@/components/customers/customer-form-dialog'
import { DeleteCustomerDialog } from '@/components/customers/delete-dialog'
import { CUSTOMER_PAGE_SIZE_OPTIONS, useCustomersStore } from '@/store/customers-store'
import type { Customer } from '@shared/customers'

const SEARCH_DEBOUNCE = 350

function formatDate(iso: string): string {
  // SQLite localtime string "YYYY-MM-DD HH:MM:SS" -> "DD/MM/YYYY"
  const datePart = iso.split(' ')[0]
  const [y, m, d] = datePart.split('-')
  return y && m && d ? `${d}/${m}/${y}` : iso
}

export function CustomersPage() {
  const {
    items,
    total,
    page,
    pageSize,
    loading,
    error,
    statusMessage,
    showArchived,
    setFilters,
    setPage,
    load,
    deleteCustomer,
    setStatus
  } = useCustomersStore()

  const [searchInput, setSearchInput] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null)

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      setFilters({ search: searchInput })
    }, SEARCH_DEBOUNCE)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

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

  const openEdit = (c: Customer) => {
    setEditing(c)
    setFormOpen(true)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    await deleteCustomer(deleteTarget.id)
    setDeleteTarget(null)
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
            placeholder="Search name or phone…"
            className="w-60 pl-8"
            aria-label="Search customers"
          />
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setFilters({ showArchived: e.target.checked })}
          />
          Show archived
        </label>

        <div className="ml-auto">
          <Button onClick={openAdd}>
            <Plus /> Add Customer
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <button type="button" onClick={() => useCustomersStore.getState().clearError()}>
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
                  <TableHead>Name</TableHead>
                  <TableHead className="w-40">Phone</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead className="w-28">Created</TableHead>
                  <TableHead className="w-20 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                      <Loader2 className="mr-2 inline size-4 animate-spin" />
                      Loading customers…
                    </TableCell>
                  </TableRow>
                )}

                {!loading && items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                      {total === 0
                        ? 'No customers yet. Use “Add Customer” to create one — customers can be attached to invoices in the billing phase.'
                        : 'No customers match the current search / filters.'}
                    </TableCell>
                  </TableRow>
                )}

                {items.map((c) => (
                  <TableRow key={c.id} className={c.archivedAt ? 'opacity-50' : ''}>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        <span className="max-w-72 truncate whitespace-normal font-medium">{c.name}</span>
                        {c.archivedAt && (
                          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                            Archived
                          </Badge>
                        )}
                      </span>
                      {c.notes && (
                        <span className="block max-w-96 truncate text-xs text-muted-foreground">{c.notes}</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.phone || '—'}</TableCell>
                    <TableCell className="max-w-96 truncate whitespace-normal text-xs">
                      {c.address || '—'}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-muted-foreground">
                      {formatDate(c.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          onClick={() => openEdit(c)}
                          aria-label={`Edit ${c.name}`}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-destructive"
                          onClick={() => setDeleteTarget(c)}
                          aria-label={`Delete ${c.name}`}
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
                {CUSTOMER_PAGE_SIZE_OPTIONS.map((n) => (
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
              <Button
                variant="outline"
                size="sm"
                disabled={page >= lastPage || loading}
                onClick={() => setPage(page + 1)}
              >
                Next <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Dialogs */}
      <CustomerFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editing} />
      <DeleteCustomerDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        customer={deleteTarget}
        onConfirm={handleDelete}
      />
    </div>
  )
}
