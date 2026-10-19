/**
 * Phase 6 — printable invoice documents (A4 + 80mm thermal receipt).
 *
 * Both layouts render ONLY the PrintDocument model built from the SAVED
 * invoice snapshots; they never recompute money. Styling is plain inline
 * CSS (mm/pt units, black-on-white) plus one <style> block for @page and
 * print-media rules, so screen preview and printed output match.
 */
import type React from 'react'

import type { PrintDocument } from '@shared/print'
import { cssPageSize, RECEIPT_CONTENT_WIDTH_MM } from '@shared/print'

/** @page + print-media rules for the selected format (rendered once). */
export function PrintStyles({ format }: { format: 'a4' | 'receipt' }) {
  const page =
    format === 'receipt'
      ? `@page { size: ${cssPageSize('receipt')}; margin: 4mm 4mm 8mm 4mm; }`
      : `@page { size: A4; margin: 12mm; }`
  return (
    <style>{`
      ${page}
      @media print {
        .kpr-no-print { display: none !important; }
        html, body { background: #ffffff !important; }
        .kpr-doc { box-shadow: none !important; margin: 0 !important; }
      }
      .kpr-doc table { border-collapse: collapse; }
      .kpr-doc thead { display: table-header-group; } /* repeat on multi-page */
      .kpr-doc tr { break-inside: avoid; page-break-inside: avoid; }
    `}</style>
  )
}

const cell: React.CSSProperties = { padding: '3pt 4pt', verticalAlign: 'top' }
const num = (align: 'right' | 'center'): React.CSSProperties => ({
  ...cell,
  textAlign: align,
  fontVariantNumeric: 'tabular-nums'
})
const lineBottom: React.CSSProperties = { borderBottom: '0.5pt solid #000' }

// ─── A4 invoice ────────────────────────────────────────────────────────

export function A4InvoiceDocument({ doc }: { doc: PrintDocument }) {
  const showDiscCol = doc.hasAnyDiscount
  return (
    <div
      className="kpr-doc"
      style={{
        width: '186mm',
        minHeight: '240mm',
        margin: '0 auto',
        background: '#fff',
        color: '#000',
        fontFamily: "'Segoe UI', Arial, sans-serif",
        fontSize: '10.5pt',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 0 12px rgba(0,0,0,0.15)'
      }}
    >
      {/* Header — shop identity from CURRENT saved settings (empties omitted) */}
      <div style={{ textAlign: 'center', paddingBottom: '8pt', borderBottom: '2pt solid #000' }}>
        <div style={{ fontSize: '22pt', fontWeight: 700, letterSpacing: '0.5pt', overflowWrap: 'anywhere' }}>{doc.shopName}</div>
        {doc.shopAddress && (
          <div style={{ fontSize: '10pt', marginTop: '2pt', whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{doc.shopAddress}</div>
        )}
        {(doc.shopPhone || doc.shopPhoneAlt) && (
          <div style={{ fontSize: '10pt', marginTop: '1pt' }}>
            Ph: {[doc.shopPhone, doc.shopPhoneAlt].filter(Boolean).join(' / ')}
          </div>
        )}
        {doc.shopEmail && (
          <div style={{ fontSize: '10pt', marginTop: '1pt', overflowWrap: 'anywhere' }}>Email: {doc.shopEmail}</div>
        )}
        {doc.shopGstin && <div style={{ fontSize: '9pt', marginTop: '1pt' }}>GSTIN: {doc.shopGstin}</div>}
        <div style={{ fontSize: '11pt', letterSpacing: '3pt', marginTop: '3pt' }}>INVOICE</div>
      </div>

      {/* Meta: bill-to left, invoice details right */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10mm', padding: '8pt 0 10pt' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '8.5pt', textTransform: 'uppercase', letterSpacing: '1pt', color: '#444' }}>
            Bill To
          </div>
          <div style={{ fontWeight: 700, marginTop: '2pt', overflowWrap: 'anywhere' }}>{doc.customerName}</div>
          {doc.customerPhone && <div style={{ marginTop: '1pt' }}>{doc.customerPhone}</div>}
          {doc.customerAddress && (
            <div style={{ marginTop: '1pt', whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{doc.customerAddress}</div>
          )}
        </div>
        <table style={{ fontSize: '10pt' }}>
          <tbody>
            <tr>
              <td style={{ ...cell, textAlign: 'right', color: '#444', whiteSpace: 'nowrap' }}>Invoice No.</td>
              <td style={{ ...cell, textAlign: 'left', fontWeight: 700, fontFamily: 'Consolas, monospace', whiteSpace: 'nowrap' }}>
                {doc.invoiceNumber}
              </td>
            </tr>
            <tr>
              <td style={{ ...cell, textAlign: 'right', color: '#444', whiteSpace: 'nowrap' }}>Date &amp; Time</td>
              <td style={{ ...cell, whiteSpace: 'nowrap' }}>{doc.dateTimeDisplay}</td>
            </tr>
            {doc.paymentMode && (
              <tr>
                <td style={{ ...cell, textAlign: 'right', color: '#444', whiteSpace: 'nowrap' }}>Payment Method</td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>{doc.paymentMethodDisplay}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Items */}
      <table style={{ width: '100%', fontSize: '10pt' }}>
        <thead>
          <tr style={{ borderBottom: '1.5pt solid #000', textAlign: 'left' }}>
            <th style={{ ...num('center'), width: '10mm' }}>No.</th>
            <th style={{ ...cell, width: '26mm' }}>Code</th>
            <th style={cell}>Product</th>
            <th style={{ ...num('right'), width: '14mm' }}>Qty</th>
            <th style={{ ...num('right'), width: '22mm' }}>Rate</th>
            {showDiscCol && <th style={{ ...num('right'), width: '22mm' }}>Discount</th>}
            <th style={{ ...num('right'), width: '24mm' }}>Final Rate</th>
            <th style={{ ...num('right'), width: '26mm' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l) => (
            <tr key={l.serial} style={lineBottom}>
              <td style={num('center')}>{l.serial}</td>
              <td style={{ ...cell, fontFamily: 'Consolas, monospace', fontSize: '9pt' }}>{l.productCode || '—'}</td>
              <td style={{ ...cell, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{l.productName}</td>
              <td style={num('right')}>{l.quantity}</td>
              <td style={num('right')}>{l.rateDisplay}</td>
              {showDiscCol && <td style={num('right')}>{l.discountDisplay ?? '—'}</td>}
              <td style={num('right')}>{l.finalRateDisplay}</td>
              <td style={{ ...num('right'), fontWeight: 600 }}>{l.amountDisplay}</td>
            </tr>
          ))}
          {doc.lines.length === 0 && (
            <tr>
              <td colSpan={showDiscCol ? 8 : 7} style={{ ...cell, textAlign: 'center', color: '#666' }}>
                No items on this invoice.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Totals */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10pt' }}>
        <table style={{ width: '78mm', fontSize: '10.5pt' }}>
          <tbody>
            <tr>
              <td style={{ ...cell, color: '#444' }}>Subtotal</td>
              <td style={num('right')}>{doc.subtotalDisplay}</td>
            </tr>
            {doc.hasAnyDiscount && (
              <tr>
                <td style={{ ...cell, color: '#444' }}>Total Discount</td>
                <td style={num('right')}>{doc.discountDisplay}</td>
              </tr>
            )}
            {doc.hasRoundOff && (
              <tr>
                <td style={{ ...cell, color: '#444' }}>Round Off</td>
                <td style={num('right')}>{doc.roundOffDisplay}</td>
              </tr>
            )}
            {doc.taxDisplay && (
              <tr>
                <td style={{ ...cell, color: '#444' }}>GST</td>
                <td style={num('right')}>{doc.taxDisplay}</td>
              </tr>
            )}
            <tr style={{ borderTop: '1.5pt solid #000' }}>
              <td style={{ ...cell, fontWeight: 700, fontSize: '12pt' }}>GRAND TOTAL</td>
              <td style={{ ...num('right'), fontWeight: 700, fontSize: '12pt' }}>{doc.totalDisplay}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {doc.notes && (
        <div style={{ marginTop: '10pt', fontSize: '9.5pt', border: '0.5pt solid #999', padding: '5pt 7pt', overflowWrap: 'anywhere' }}>
          <span style={{ color: '#444' }}>Notes: </span>
          {doc.notes}
        </div>
      )}

      <div style={{ flex: 1 }} />
      {doc.footerMessage && (
        <div
          style={{
            marginTop: '12pt',
            paddingTop: '6pt',
            borderTop: '0.5pt dashed #999',
            textAlign: 'center',
            fontSize: '10pt',
            fontStyle: 'italic'
          }}
        >
          {doc.footerMessage}
        </div>
      )}
    </div>
  )
}

// ─── 80mm thermal receipt ──────────────────────────────────────────────

const rRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '2mm' }

export function Receipt80Document({ doc }: { doc: PrintDocument }) {
  return (
    <div
      className="kpr-doc"
      style={{
        width: `${RECEIPT_CONTENT_WIDTH_MM}mm`,
        margin: '0 auto',
        background: '#fff',
        color: '#000',
        fontFamily: "Arial, 'Segoe UI', sans-serif",
        fontSize: '10.5px',
        lineHeight: 1.45,
        padding: '2mm 0',
        boxShadow: '0 0 12px rgba(0,0,0,0.15)'
      }}
    >
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '15px', letterSpacing: '0.5px', overflowWrap: 'anywhere' }}>
        {doc.shopName}
      </div>
      {doc.shopAddress && (
        <div style={{ textAlign: 'center', fontSize: '10px', whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
          {doc.shopAddress}
        </div>
      )}
      {(doc.shopPhone || doc.shopPhoneAlt) && (
        <div style={{ textAlign: 'center', fontSize: '10px', overflowWrap: 'anywhere' }}>
          Ph: {[doc.shopPhone, doc.shopPhoneAlt].filter(Boolean).join(' / ')}
        </div>
      )}
      {doc.shopEmail && (
        <div style={{ textAlign: 'center', fontSize: '10px', overflowWrap: 'anywhere' }}>Email: {doc.shopEmail}</div>
      )}
      {doc.shopGstin && <div style={{ textAlign: 'center', fontSize: '10px' }}>GSTIN: {doc.shopGstin}</div>}
      <div style={{ textAlign: 'center', fontSize: '10px', letterSpacing: '2px' }}>INVOICE</div>

      <div style={{ borderStyle: 'dashed', borderTopWidth: '1px', borderBottomWidth: '0', borderColor: '#000', margin: '2mm 0' }} />

      <div style={rRow}>
        <span>Invoice:</span>
        <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>{doc.invoiceNumber}</span>
      </div>
      <div style={rRow}>
        <span>Date:</span>
        <span>{doc.dateTimeDisplay}</span>
      </div>
      <div style={rRow}>
        <span>Payment:</span>
        <span>{doc.paymentMethodDisplay}</span>
      </div>
      <div style={{ ...rRow, overflowWrap: 'anywhere' }}>
        <span style={{ flexShrink: 0 }}>Customer:</span>
        <span style={{ textAlign: 'right' }}>{doc.customerName}</span>
      </div>
      {doc.customerPhone && (
        <div style={{ ...rRow, overflowWrap: 'anywhere' }}>
          <span style={{ flexShrink: 0 }}>Phone:</span>
          <span style={{ textAlign: 'right' }}>{doc.customerPhone}</span>
        </div>
      )}
      {doc.customerAddress && (
        <div style={{ ...rRow, overflowWrap: 'anywhere' }}>
          <span style={{ flexShrink: 0 }}>Address:</span>
          <span style={{ textAlign: 'right', whiteSpace: 'pre-line' }}>{doc.customerAddress}</span>
        </div>
      )}

      <div style={{ borderStyle: 'dashed', borderTopWidth: '1px', borderBottomWidth: '0', borderColor: '#000', margin: '2mm 0' }} />

      {/* Items: name line, then qty/rate/amount line — wraps, never overflows */}
      {doc.lines.map((l) => (
        <div key={l.serial} style={{ marginBottom: '1.2mm' }}>
          <div style={{ overflowWrap: 'anywhere' }}>
            {l.productName}
            {l.productCode ? <span style={{ color: '#444' }}> ({l.productCode})</span> : null}
          </div>
          <div style={{ ...rRow, fontVariantNumeric: 'tabular-nums' }}>
            <span>
              {l.quantity} x {l.finalRateDisplay}
            </span>
            <span style={{ fontWeight: 600 }}>{l.amountDisplay}</span>
          </div>
        </div>
      ))}
      {doc.lines.length === 0 && <div style={{ textAlign: 'center', color: '#666' }}>No items.</div>}

      <div style={{ borderStyle: 'dashed', borderTopWidth: '1px', borderBottomWidth: '0', borderColor: '#000', margin: '2mm 0' }} />

      <div style={rRow}>
        <span>Subtotal</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{doc.subtotalDisplay}</span>
      </div>
      {doc.hasAnyDiscount && (
        <div style={rRow}>
          <span>Discount</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{doc.discountDisplay}</span>
        </div>
      )}
      {doc.hasRoundOff && (
        <div style={rRow}>
          <span>Round Off</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{doc.roundOffDisplay}</span>
        </div>
      )}
      {doc.taxDisplay && (
        <div style={rRow}>
          <span>GST</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{doc.taxDisplay}</span>
        </div>
      )}
      <div style={{ ...rRow, fontWeight: 700, fontSize: '12.5px', borderTop: '1px solid #000', marginTop: '1mm', paddingTop: '1mm' }}>
        <span>GRAND TOTAL</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{doc.totalDisplay}</span>
      </div>

      {doc.notes && (
        <div style={{ marginTop: '1.5mm', overflowWrap: 'anywhere', fontStyle: 'italic' }}>Note: {doc.notes}</div>
      )}

      <div style={{ borderStyle: 'dashed', borderTopWidth: '1px', borderBottomWidth: '0', borderColor: '#000', margin: '2mm 0' }} />
      {doc.footerMessage && (
        <div style={{ textAlign: 'center', fontSize: '10px', fontStyle: 'italic' }}>{doc.footerMessage}</div>
      )}
    </div>
  )
}
