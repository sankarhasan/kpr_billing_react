/**
 * Shared customer domain logic — pure, dependency-free TypeScript.
 * Used by the main process (repo/IPC validation), the renderer (live
 * validation) and the automated tests.
 */
import type { IpcResult } from './products.ts'

export interface Customer {
  id: number
  name: string
  phone: string
  address: string
  notes: string
  createdAt: string
  updatedAt: string
  /** ISO-ish SQLite datetime string when archived, null when active. */
  archivedAt: string | null
}

/** Payload accepted by create/update (no server-managed fields). */
export interface CustomerInput {
  name: string
  phone: string
  address: string
  notes: string
  /** When true an archived customer is re-activated on update. */
  restoreActive?: boolean
}

export interface CustomerListParams {
  search?: string
  includeArchived?: boolean
  page?: number
  pageSize?: number
}

export interface CustomerListResult {
  items: Customer[]
  total: number
  page: number
  pageSize: number
}

export type { IpcResult }

// ─── Validation ────────────────────────────────────────────────────────

const PHONE_RE = /^[0-9+\-()\s]{0,25}$/

export function validateCustomerInput(raw: unknown): {
  errors: Record<string, string>
  value: CustomerInput
} {
  const errors: Record<string, string> = {}
  const o = (raw ?? {}) as Record<string, unknown>

  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const phone = typeof o.phone === 'string' ? o.phone.trim() : ''
  const address = typeof o.address === 'string' ? o.address.trim() : ''
  const notes = typeof o.notes === 'string' ? o.notes.trim() : ''

  if (name === '') {
    errors.name = 'Customer name is required.'
  } else if (name.length > 200) {
    errors.name = 'Customer name must be at most 200 characters.'
  }

  if (phone !== '' && !PHONE_RE.test(phone)) {
    errors.phone = 'Phone may contain digits and + - ( ) spaces only (max 25 characters).'
  }
  if (address.length > 500) {
    errors.address = 'Address must be at most 500 characters.'
  }
  if (notes.length > 2000) {
    errors.notes = 'Notes must be at most 2000 characters.'
  }

  return {
    errors,
    value: {
      name,
      phone,
      address,
      notes,
      restoreActive: o.restoreActive === true
    }
  }
}
