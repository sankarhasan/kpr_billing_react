/**
 * Phase 6 — shared print / PDF helpers. Pure, dependency-free TypeScript so
 * the exact same rules run (and are tested) in main, preload and renderer:
 *
 *  - every print request (invoiceId / format / mode) is validated before the
 *    main process creates ANY privileged window — the renderer can never
 *    supply paths, URLs or HTML, only an invoice id + a whitelisted format;
 *  - PDF filenames are derived from the STORED invoice number inside the
 *    main process and sanitized for Windows;
 *  - the printable document model is built ONLY from the saved invoice
 *    snapshots (never from current product prices or renderer data).
 */
import { computeLineAmounts, formatInvoiceDate, type Invoice } from './invoices.ts'
import { formatPaiseDisplay } from './products.ts'

// ─── Formats & request validation ──────────────────────────────────────

export type PrintFormat = 'a4' | 'receipt'
export const PRINT_FORMATS: readonly PrintFormat[] = ['a4', 'receipt']

export type PrintWindowMode = 'preview' | 'print' | 'pdf'
export const PRINT_WINDOW_MODES: readonly PrintWindowMode[] = ['preview', 'print', 'pdf']

export interface PrintWindowRequest {
  invoiceId: number
  format: PrintFormat
  mode: PrintWindowMode
}

export type PrintRequestCheck = { ok: true; value: PrintWindowRequest } | { ok: false; message: string }

/** Validate an untrusted print request. Mode defaults to a safe preview. */
export function validatePrintWindowRequest(raw: unknown): PrintRequestCheck {
  const o = (raw ?? {}) as Record<string, unknown>

  const id = o.invoiceId
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || id > 1e12) {
    return { ok: false, message: 'Invalid invoice id.' }
  }
  if (typeof o.format !== 'string' || !PRINT_FORMATS.includes(o.format as PrintFormat)) {
    return { ok: false, message: 'Invalid print format — choose A4 or 80 mm receipt.' }
  }
  const mode = o.mode === undefined || o.mode === null ? 'preview' : o.mode
  if (typeof mode !== 'string' || !PRINT_WINDOW_MODES.includes(mode as PrintWindowMode)) {
    return { ok: false, message: 'Invalid print action.' }
  }
  return { ok: true, value: { invoiceId: id, format: o.format as PrintFormat, mode: mode as PrintWindowMode } }
}

/**
 * Parse the print-window URL query (?print=1&invoiceId=..&format=..&mode=..).
 * Only ever invoked on a URL the MAIN process built for its own window.
 * Returns null for the normal application window.
 */
export function parsePrintQuery(search: string): PrintWindowRequest | null {
  try {
    const p = new URLSearchParams(search)
    if (p.get('print') !== '1') return null
    const check = validatePrintWindowRequest({
      invoiceId: Number(p.get('invoiceId')),
      format: p.get('format'),
      mode: p.get('mode') ?? 'preview'
    })
    return check.ok ? check.value : null
  } catch {
    return null
  }
}

// ─── Output geometry ───────────────────────────────────────────────────

/**
 * printToPDF paper size in INCHES (Electron's unit).
 * A4 = 210×297mm; receipt = 80mm wide with 210mm pages (content flows).
 */
export function pdfPageSizeInches(format: PrintFormat): { width: number; height: number } {
  return format === 'receipt'
    ? { width: +(80 / 25.4).toFixed(4), height: +(210 / 25.4).toFixed(4) }
    : { width: +(210 / 25.4).toFixed(4), height: +(297 / 25.4).toFixed(4) }
}

/** @page size used in the on-screen/print CSS for each layout. */
export function cssPageSize(format: PrintFormat): string {
  return format === 'receipt' ? '80mm auto' : 'A4'
}

/** ~72 mm content width on 80 mm paper (typical 4 mm side margins). */
export const RECEIPT_CONTENT_WIDTH_MM = 72

// ─── File names ────────────────────────────────────────────────────────

/**
 * Windows-safe PDF name from the STORED invoice number (which the renderer
 * never supplies). Invalid/awkward characters become '-', length is capped,
 * and trailing dots/dashes (illegal on Windows) are removed.
 */
export function safePdfFileName(invoiceNumber: unknown): string {
  const raw = typeof invoiceNumber === 'string' ? invoiceNumber.trim() : ''
  const cleaned = raw
    .replace(/[\\/:*?"'<>|\s\x00-\x1F]+/g, '-') // eslint-disable-line no-control-regex
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 80)
    .replace(/[.-]+$/, '')
  return `${cleaned || 'invoice'}.pdf`
}

// ─── Business details (existing settings only — nothing invented) ──────

export interface PrintInfo {
  shopName: string
  /** Optional fields are '' when not configured and then simply omitted. */
  shopAddress: string
  shopPhone: string
  shopPhoneAlt: string
  /** Only printed when the shop has configured one; never affects totals. */
  gstin: string
  receiptFooter: string
}

/** Values already seeded in the settings table defaults. */
export const DEFAULT_PRINT_INFO: PrintInfo = {
  shopName: 'KPR Firecrackers',
  shopAddress: '',
  shopPhone: '',
  shopPhoneAlt: '',
  gstin: '',
  receiptFooter: ''
}

// ─── Document model (built ONLY from saved snapshots) ──────────────────

export interface PrintDocumentLine {
  serial: number
  /** '' when the snapshot has no product code (legacy rows). */
  productCode: string
  productName: string
  quantity: number
  /** Original/base unit rate. */
  rateDisplay: string
  /** Per-unit discount, or null when the line carries no discount. */
  discountDisplay: string | null
  /** Final selling unit price actually charged. */
  finalRateDisplay: string
  /** Stored line total. */
  amountDisplay: string
}

export interface PrintDocument {
  invoiceNumber: string
  dateTimeDisplay: string
  customerName: string
  customerPhone: string
  customerAddress: string
  lines: PrintDocumentLine[]
  /** Stored header totals — never recomputed from current data. */
  subtotalDisplay: string
  discountDisplay: string
  roundOffDisplay: string
  hasRoundOff: boolean
  /** Null while GST is disabled (tax_amount_paise === 0). */
  taxDisplay: string | null
  totalDisplay: string
  hasAnyDiscount: boolean
  notes: string
  paymentMode: string
  shopName: string
  shopAddress: string
  shopPhone: string
  shopPhoneAlt: string
  /** '' when no GSTIN configured — layouts omit the line entirely. */
  shopGstin: string
  footerMessage: string
}

/** ₹ display that stays readable for negative paise (round-off). */
export function inr(paise: number): string {
  return paise < 0 ? `-₹${formatPaiseDisplay(Math.abs(paise))}` : `₹${formatPaiseDisplay(paise)}`
}

/**
 * Build the printable view-model from a saved Invoice. Uses ONLY stored
 * values (totals, line snapshots). Does not mutate the invoice.
 */
export function buildPrintDocument(invoice: Invoice, info: PrintInfo): PrintDocument {
  let hasAnyDiscount = invoice.discountPaise > 0

  const lines: PrintDocumentLine[] = invoice.lines.map((l, i) => {
    const amounts = computeLineAmounts({
      originalRatePaise: l.originalRatePaise,
      unitPricePaise: l.unitPricePaise,
      quantity: l.quantity
    })
    if (amounts.discountAmountPaise > 0) hasAnyDiscount = true
    return {
      serial: i + 1,
      productCode: l.productCode ?? '',
      productName: l.productName,
      quantity: l.quantity,
      rateDisplay: inr(l.originalRatePaise),
      discountDisplay: amounts.discountAmountPaise > 0 ? inr(l.originalRatePaise - l.unitPricePaise) : null,
      finalRateDisplay: inr(l.unitPricePaise),
      amountDisplay: inr(l.lineTotalPaise)
    }
  })

  return {
    invoiceNumber: invoice.invoiceNumber,
    dateTimeDisplay: formatInvoiceDate(invoice.invoiceDate),
    customerName: invoice.customerName,
    customerPhone: invoice.customerPhone,
    customerAddress: invoice.customerAddress,
    lines,
    subtotalDisplay: inr(invoice.subtotalPaise),
    discountDisplay: inr(invoice.discountPaise),
    roundOffDisplay: inr(invoice.roundOffPaise ?? 0),
    hasRoundOff: (invoice.roundOffPaise ?? 0) !== 0,
    taxDisplay: invoice.taxAmountPaise > 0 ? inr(invoice.taxAmountPaise) : null,
    totalDisplay: inr(invoice.totalPaise),
    hasAnyDiscount,
    notes: invoice.notes,
    paymentMode: invoice.paymentMode,
    shopName: info.shopName.trim() || DEFAULT_PRINT_INFO.shopName,
    shopAddress: info.shopAddress.trim(),
    shopPhone: info.shopPhone.trim(),
    shopPhoneAlt: info.shopPhoneAlt.trim(),
    shopGstin: info.gstin.trim(),
    footerMessage: info.receiptFooter.trim()
  }
}

// ─── IPC result payloads for the print flow ────────────────────────────

export interface PrintRunResult {
  /** Set when printing succeeded. */
  printed?: boolean
  /** Absolute path of the written PDF when it was saved. */
  filePath?: string
}

export type PrintOutcome = { ok: true; data: PrintRunResult } | { ok: false; error: { code: string; message: string } }

/** Answer of print:documentReady — tells the window what (if anything) ran. */
export interface DocumentReadyResult {
  pending: 'none' | 'print' | 'pdf'
  result?: PrintOutcome
}

/** Pushed to the REQUESTING window after a main-driven hidden PDF export. */
export interface PrintPdfEvent {
  invoiceId: number
  format: PrintFormat
  result: PrintOutcome
}

/** Human-readable one-liner for any print/PDF outcome (UI status text). */
export function describePrintOutcome(res: PrintOutcome): string {
  if (res.ok) {
    if (res.data.filePath) return `PDF saved to ${res.data.filePath}`
    if (res.data.printed) return 'Print dialog completed — job sent to the printer.'
    return 'Invoice preview opened.'
  }
  return res.error.message
}
