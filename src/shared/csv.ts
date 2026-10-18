/**
 * Shared CSV engine — pure TypeScript, no dependencies.
 * RFC-4180 style parsing: quoted fields, embedded commas/newlines,
 * "" escaping, CRLF handling and UTF-8 BOM stripping.
 * The original file is never modified: parsing works on a string that
 * main read and returned over IPC.
 */

export interface ParsedCsv {
  headers: string[]
  rows: Record<string, string>[]
  /** Rows whose column count differs from the header row (reported, never guessed). */
  raggedRowNumbers: number[]
}

/** Strip a leading UTF-8 BOM. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Parse CSV text into raw records (array of string cells per logical row). */
export function parseCsvRaw(text: string): string[][] {
  const input = stripBom(text)
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let i = 0

  const endField = () => {
    record.push(field)
    field = ''
  }
  const endRecord = () => {
    endField()
    records.push(record)
    record = []
  }

  while (i < input.length) {
    const ch = input[i]
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      if (field.length === 0) {
        inQuotes = true
        i++
        continue
      }
      // Quote inside an unquoted field: keep literally.
      field += ch
      i++
      continue
    }
    if (ch === ',') {
      endField()
      i++
      continue
    }
    if (ch === '\r') {
      if (input[i + 1] === '\n') i++
      endRecord()
      i++
      continue
    }
    if (ch === '\n') {
      endRecord()
      i++
      continue
    }
    field += ch
    i++
  }
  // Last field/record (when file does not end with a newline).
  if (field.length > 0 || record.length > 0) endRecord()

  return records
}

/**
 * Chunked async parse for large files: the character scan is split per
 * logical row and yields to the event loop periodically so the UI thread
 * is never blocked for long stretches.
 */
export async function parseCsvRawAsync(text: string, yieldEvery = 2000): Promise<string[][]> {
  const input = stripBom(text)
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let rowsSinceYield = 0
  let i = 0

  while (i < input.length) {
    const ch = input[i]
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      if (field.length === 0) {
        inQuotes = true
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === ',') {
      record.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      record.push(field)
      field = ''
      records.push(record)
      record = []
      i++
      if (++rowsSinceYield >= yieldEvery) {
        rowsSinceYield = 0
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      continue
    }
    field += ch
    i++
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}

/** Parse into header-keyed row objects. Empty trailing lines are dropped. */
export function parseCsv(text: string): ParsedCsv {
  const raw = parseCsvRaw(text).filter((r) => !(r.length === 1 && r[0].trim() === ''))
  if (raw.length === 0) {
    return { headers: [], rows: [], raggedRowNumbers: [] }
  }
  const headers = raw[0].map((h) => h.trim())
  const rows: Record<string, string>[] = []
  const raggedRowNumbers: number[] = []
  for (let r = 1; r < raw.length; r++) {
    const cells = raw[r]
    // CSV logical row r => data row r-1; report 1-based data row number.
    if (cells.length !== headers.length) {
      raggedRowNumbers.push(r)
      // Still map what we can; shorter rows leave the rest empty.
    }
    const obj: Record<string, string> = {}
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (cells[c] ?? '').trim()
    }
    rows.push(obj)
  }
  return { headers, rows, raggedRowNumbers }
}

/** Escape one cell per RFC-4180. */
export function csvEscape(value: string): string {
  const s = value ?? ''
  if (/[",\r\n]/.test(s) || s !== s.trim()) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** Serialize a full table (CRLF line endings, no trailing newline after last row is fine). */
export function toCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines: string[] = [headers.map(csvEscape).join(',')]
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}
