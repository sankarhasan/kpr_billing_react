/**
 * CSV engine tests: quoting, escapes, BOM, ragged rows, serialization.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCsv, parseCsvRawAsync, toCsv, csvEscape, stripBom } from '../src/shared/csv.ts'

test('parses plain rows', () => {
  const { headers, rows } = parseCsv('a,b,c\r\n1,2,3\r\n4,5,6\r\n')
  assert.deepEqual(headers, ['a', 'b', 'c'])
  assert.equal(rows.length, 2)
  assert.equal(rows[1].c, '6')
})

test('handles quoted fields with commas and newlines', () => {
  const csv = 'name,desc\r\n"Sparklers, big","line1\nline2"\r\n'
  const { rows } = parseCsv(csv)
  assert.equal(rows[0].name, 'Sparklers, big')
  assert.equal(rows[0].desc, 'line1\nline2')
})

test('handles escaped double quotes', () => {
  const csv = 'v\r\n"say ""hi"""'
  const { rows } = parseCsv(csv)
  assert.equal(rows[0].v, 'say "hi"')
})

test('strips a UTF-8 BOM', () => {
  assert.equal(stripBom('\ufeffabc'), 'abc')
  const { headers } = parseCsv('\ufeffproductCode,name\r\nA1,x\r\n')
  assert.equal(headers[0], 'productCode')
  assert.notEqual(headers[0], '\ufeffproductCode')
})

test('reports ragged rows instead of guessing', () => {
  const { rows, raggedRowNumbers } = parseCsv('a,b\r\n1,2\r\n3\r\n4,5,6\r\n')
  assert.deepEqual(raggedRowNumbers, [2, 3])
  assert.equal(rows[1].b, '') // missing cell mapped to empty
})

test('empty lines are dropped', () => {
  const { rows } = parseCsv('a,b\r\n1,2\r\n\r\n\r\n')
  assert.equal(rows.length, 1)
})

test('async chunked parser matches the sync parser', async () => {
  const headers = ['code', 'name']
  let csv = headers.join(',') + '\r\n'
  for (let i = 0; i < 5000; i++) {
    csv += `C${i},"Name, ${i}"\r\n`
  }
  const raw = await parseCsvRawAsync(csv, 500)
  assert.equal(raw.length, 5001)
  assert.equal(raw[5000][0], 'C4999')
  assert.equal(raw[5000][1], 'Name, 4999')
})

test('csvEscape quotes only when needed', () => {
  assert.equal(csvEscape('plain'), 'plain')
  assert.equal(csvEscape('a,b'), '"a,b"')
  assert.equal(csvEscape('say "x"'), '"say ""x"""')
  assert.equal(csvEscape('multi\nline'), '"multi\nline"')
  assert.equal(csvEscape(' padded '), '" padded "')
})

test('toCsv output re-parses identically (round trip)', () => {
  const headers = ['productCode', 'productName', 'description']
  const rows = [
    ['A1', 'Chakkar, big', 'He said "wow"\r\nand left'],
    ['B2', 'Plain', '']
  ]
  const csv = toCsv(headers, rows)
  const parsed = parseCsv(csv)
  assert.deepEqual(parsed.headers, headers)
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.rows[0].productName, 'Chakkar, big')
  assert.equal(parsed.rows[0].description, 'He said "wow"\r\nand left')
})
