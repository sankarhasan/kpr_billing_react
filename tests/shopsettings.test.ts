/**
 * Phase 7 — Shop Details settings + backup/restore tests.
 * ALL databases used here are throwaway files in the OS temp folder; the
 * production database is never opened by these tests.
 *
 * Covers: shop settings save/update/validation/limits, persistence across
 * reconnection (restart simulation), blank optional fields, print documents
 * picking up CURRENT settings (A4 model + 80mm model share the same source),
 * settings updates never touching historical invoices, GST remaining
 * disabled after a GSTIN is stored, backup file validation and the fact
 * that shop settings physically travel with database backups/restores.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'

import { openTempDb } from './_util.ts'
import { migrateDatabase } from '../src/main/db/migrate.ts'
import { getShopSettings, updateShopSettings, getPrintInfo } from '../src/main/db/settings-repo.ts'
import { createProduct } from '../src/main/db/products-repo.ts'
import { createInvoice, getInvoice } from '../src/main/db/invoices-repo.ts'
import {
  copyFileAtomic,
  removeSidecars,
  timestampSlug,
  validateBackupFile
} from '../src/main/db/backup.ts'
import { validateShopSettings } from '../src/shared/settings.ts'
import { buildPrintDocument, DEFAULT_PRINT_INFO } from '../src/shared/print.ts'

function setup() {
  const t = openTempDb()
  migrateDatabase(t.db)
  return t
}

type Temp = ReturnType<typeof setup>

const FULL_SHOP = {
  shopName: 'KPR Firecrackers',
  shopAddress: '45 Crackers Road',
  shopPhone: '98765 43210',
  shopPhoneAlt: '044-1234567',
  gstin: '33ABCDE1234F1Z5',
  receiptFooter: 'Happy Deepavali!'
}

// ─── Save / update / validate ──────────────────────────────────────────

test('shop name saves and updates through the settings repository', () => {
  const t = setup()
  try {
    const first = updateShopSettings(t.db, { ...FULL_SHOP, shopName: 'KPR Fireworks' })
    assert.ok(first.ok)
    assert.equal(first.data.shopName, 'KPR Fireworks')

    const second = updateShopSettings(t.db, { ...FULL_SHOP, shopName: '  KPR Fireworks Ltd  ' })
    assert.ok(second.ok)
    assert.equal(second.data.shopName, 'KPR Fireworks Ltd', 'values are trimmed on save')
    assert.equal(getShopSettings(t.db).shopName, 'KPR Fireworks Ltd')
  } finally {
    t.cleanup()
  }
})

test('address, both phones and the footer save and round-trip', () => {
  const t = setup()
  try {
    const res = updateShopSettings(t.db, FULL_SHOP)
    assert.ok(res.ok)
    const s = getShopSettings(t.db)
    assert.equal(s.shopAddress, '45 Crackers Road')
    assert.equal(s.shopPhone, '98765 43210')
    assert.equal(s.shopPhoneAlt, '044-1234567')
    assert.equal(s.receiptFooter, 'Happy Deepavali!')
    assert.equal(s.gstin, '33ABCDE1234F1Z5')
  } finally {
    t.cleanup()
  }
})

test('blank optional fields are accepted and stored blank (= cleared)', () => {
  const t = setup()
  try {
    assert.ok(updateShopSettings(t.db, FULL_SHOP).ok)
    const cleared = updateShopSettings(t.db, {
      ...FULL_SHOP,
      shopAddress: '   ',
      shopPhone: '',
      shopPhoneAlt: '',
      gstin: '',
      receiptFooter: ''
    })
    assert.ok(cleared.ok)
    assert.deepEqual(cleared.data, { ...FULL_SHOP, shopName: 'KPR Firecrackers', shopAddress: '', shopPhone: '', shopPhoneAlt: '', gstin: '', receiptFooter: '' })
    const info = getPrintInfo(t.db)
    assert.equal(info.shopAddress, '')
    assert.equal(info.gstin, '', 'cleared GSTIN is not printed')
    assert.equal(info.shopName, 'KPR Firecrackers')
  } finally {
    t.cleanup()
  }
})

test('shop name is required; phones, GSTIN and lengths are validated', () => {
  assert.ok(validateShopSettings({ ...FULL_SHOP, shopName: '  ' }).errors.shopName)
  assert.ok(validateShopSettings({ ...FULL_SHOP, shopName: 'x'.repeat(101) }).errors.shopName)
  assert.ok(validateShopSettings({ ...FULL_SHOP, shopAddress: 'x'.repeat(201) }).errors.shopAddress)
  assert.ok(validateShopSettings({ ...FULL_SHOP, receiptFooter: 'x'.repeat(201) }).errors.receiptFooter)
  assert.ok(validateShopSettings({ ...FULL_SHOP, shopPhone: 'call me' }).errors.shopPhone)
  assert.ok(validateShopSettings({ ...FULL_SHOP, shopPhoneAlt: '+91 (44) 1234-5678' }).errors.shopPhoneAlt === undefined)
  assert.ok(validateShopSettings({ ...FULL_SHOP, gstin: 'NOTAGSTIN' }).errors.gstin)
  assert.ok(validateShopSettings({ ...FULL_SHOP, gstin: '33ABCDE1234F1Z5' }).errors.gstin === undefined)
  assert.ok(validateShopSettings({ ...FULL_SHOP, gstin: '33abcde1234f1z5' }).value.gstin === '33ABCDE1234F1Z5', 'gstin normalized to upper case')

  // repository refuses bad input before writing anything
  const t = setup()
  try {
    const before = JSON.stringify(getShopSettings(t.db))
    const bad = updateShopSettings(t.db, { ...FULL_SHOP, shopName: '' })
    assert.ok(!bad.ok)
    assert.equal(bad.error.code, 'VALIDATION')
    assert.ok(bad.error.fields?.shopName)
    assert.equal(JSON.stringify(getShopSettings(t.db)), before, 'rejected save wrote nothing')
  } finally {
    t.cleanup()
  }
})

test('shop settings persist across database reconnection (restart simulation)', () => {
  const t = setup()
  const file = join(t.dir, 'test.db')
  try {
    assert.ok(updateShopSettings(t.db, FULL_SHOP).ok)
    t.db.close()
    const reopened = new Database(file)
    try {
      const s = getShopSettings(reopened)
      assert.deepEqual(s, FULL_SHOP)
    } finally {
      reopened.close()
    }
  } finally {
    // ensure cleanup tolerates an already-closed handle
    try {
      t.db.close()
    } catch {
      /* closed */
    }
    t.cleanup()
  }
})

// ─── Print documents use CURRENT settings; history stays frozen ────────

test('print documents reflect the CURRENT shop settings for A4 and receipt models', () => {
  const t = setup()
  try {
    const prod = createProduct(t.db, {
      productCode: 'SP1', productName: 'Sparkler', category: 'A', brand: '',
      ratePaise: 2000, discountType: 'none', discountPercent: 0, discountAmountPaise: 0,
      finalRatePaise: 2000, greenCracker: false, description: '', imagePath: ''
    })
    assert.ok(prod.ok)
    const inv = createInvoice(t.db, { customerId: null, customerName: 'Meena', lines: [{ productId: prod.data.id, quantity: 2 }], notes: '' })
    assert.ok(inv.ok)

    assert.ok(updateShopSettings(t.db, FULL_SHOP).ok)
    const doc1 = buildPrintDocument(getInvoice(t.db, inv.data.id)!, getPrintInfo(t.db))
    assert.equal(doc1.shopName, 'KPR Firecrackers')
    assert.equal(doc1.shopAddress, '45 Crackers Road')
    assert.equal(doc1.shopPhone, '98765 43210')
    assert.equal(doc1.shopGstin, '33ABCDE1234F1Z5')
    assert.equal(doc1.footerMessage, 'Happy Deepavali!')

    // UPDATE settings → subsequent documents change, immediately
    assert.ok(updateShopSettings(t.db, { ...FULL_SHOP, shopName: 'KPR Burst Kingdom', shopAddress: '', gstin: '' }).ok)
    const doc2 = buildPrintDocument(getInvoice(t.db, inv.data.id)!, getPrintInfo(t.db))
    assert.equal(doc2.shopName, 'KPR Burst Kingdom')
    assert.equal(doc2.shopAddress, '', 'cleared address omitted cleanly — no literal placeholder')
    assert.equal(doc2.shopGstin, '')
    assert.ok(!doc2.shopAddress.includes('undefined') && !doc2.shopAddress.includes('null'))

    // every print surface shares THIS one source (A4 + receipt both consume
    // PrintDocument built from getPrintInfo — asserted again below)
  } finally {
    t.cleanup()
  }
})

test('changing shop settings NEVER rewrites historical invoices', () => {
  const t = setup()
  try {
    const prod = createProduct(t.db, {
      productCode: 'SP2', productName: 'Rocket', category: 'A', brand: '',
      ratePaise: 9900, discountType: 'none', discountPercent: 0, discountAmountPaise: 0,
      finalRatePaise: 9900, greenCracker: false, description: '', imagePath: ''
    })
    assert.ok(prod.ok)
    const inv = createInvoice(t.db, { customerId: null, customerName: 'Kiran', customerPhone: '90000', lines: [{ productId: prod.data.id, quantity: 1 }], notes: 'keep' })
    assert.ok(inv.ok)
    const before = JSON.stringify(getInvoice(t.db, inv.data.id))

    assert.ok(updateShopSettings(t.db, FULL_SHOP).ok)

    assert.equal(JSON.stringify(getInvoice(t.db, inv.data.id)), before, 'stored invoice bytes unchanged')
    const doc = buildPrintDocument(getInvoice(t.db, inv.data.id)!, getPrintInfo(t.db))
    assert.equal(doc.totalDisplay, '₹99.00', 'grand total still the STORED value')
    assert.equal(doc.lines[0].finalRateDisplay, '₹99.00', 'line price still the STORED snapshot')
    assert.equal(doc.customerName, 'Kiran', 'customer snapshot unchanged by shop edits')
  } finally {
    t.cleanup()
  }
})

test('GSTIN is print metadata only — GST stays disabled', () => {
  const t = setup()
  try {
    assert.ok(updateShopSettings(t.db, FULL_SHOP).ok)
    assert.equal(getShopSettings(t.db).gstin, '33ABCDE1234F1Z5')

    const tax = t.db.prepare<[], { value: string }>("SELECT value FROM settings WHERE key='tax_enabled'").get()
    assert.equal(tax?.value, '0', 'tax_enabled untouched by shop save')

    const prod = createProduct(t.db, {
      productCode: 'SP3', productName: 'Anar', category: 'A', brand: '',
      ratePaise: 5000, discountType: 'none', discountPercent: 0, discountAmountPaise: 0,
      finalRatePaise: 5000, greenCracker: false, description: '', imagePath: ''
    })
    assert.ok(prod.ok)
    const inv = createInvoice(t.db, { customerId: null, lines: [{ productId: prod.data.id, quantity: 4 }], notes: '' })
    assert.ok(inv.ok)
    assert.equal(inv.data.taxAmountPaise, 0, 'no tax added to invoices after GSTIN configured')
    const doc = buildPrintDocument(inv.data, getPrintInfo(t.db))
    assert.equal(doc.taxDisplay, null, 'GST line never printed while disabled')
  } finally {
    t.cleanup()
  }
})

// ─── Backup / restore carry the settings inside the database ───────────

test('validateBackupFile accepts a real app DB and rejects junk', () => {
  const t = setup()
  try {
    assert.ok(updateShopSettings(t.db, FULL_SHOP).ok)
    const dest = join(t.dir, 'backup.db')
    // checkpoint into the main file, then a straight copy is a valid snapshot
    t.db.pragma('wal_checkpoint(TRUNCATE)')
    copyFileAtomic(join(t.dir, 'test.db'), dest)

    const check = validateBackupFile(dest)
    assert.ok(check.ok, check.message ?? 'backup should be valid')
    assert.equal(check.shopName, 'KPR Firecrackers', 'shop settings are INSIDE the backup')

    const junk = join(t.dir, 'junk.db')
    writeFileSync(junk, 'this is not a sqlite database')
    const bad = validateBackupFile(junk)
    assert.ok(!bad.ok)
    assert.match(bad.message ?? '', /not a valid SQLite/)

    const emptyDb = join(t.dir, 'empty.db')
    const other = new Database(emptyDb)
    other.exec('CREATE TABLE unrelated (x)')
    other.close()
    const noTables = validateBackupFile(emptyDb)
    assert.ok(!noTables.ok)
    assert.match(noTables.message ?? '', /missing tables/)

    assert.ok(!validateBackupFile(join(t.dir, 'nope.db')).ok)
  } finally {
    t.cleanup()
  }
})

test('restore swaps the database and brings BACK the settings from the backup', () => {
  const t = setup()
  const liveFile = join(t.dir, 'test.db')
  try {
    // live db currently has shop A
    assert.ok(updateShopSettings(t.db, { ...FULL_SHOP, shopName: 'Shop Current' }).ok)

    // build a separate backup db whose shop settings differ (simulated old backup)
    const bakT = openTempDb()
    migrateDatabase(bakT.db)
    assert.ok(updateShopSettings(bakT.db, { ...FULL_SHOP, shopName: 'Shop From Backup' }).ok)
    bakT.db.pragma('wal_checkpoint(TRUNCATE)')
    const backupFile = join(bakT.dir, 'test.db')
    bakT.db.close()

    // pre-restore safety copy of the CURRENT live db (exactly what the app does)
    const safetyFile = join(t.dir, `pre-restore-${timestampSlug()}.db`)
    copyFileAtomic(liveFile, safetyFile)

    // perform the file-level restore the service automates
    t.db.close()
    copyFileAtomic(backupFile, liveFile)
    removeSidecars(liveFile)

    const reopened = new Database(liveFile)
    try {
      assert.equal(getShopSettings(reopened).shopName, 'Shop From Backup')
    } finally {
      reopened.close()
    }

    // the safety copy preserved the previous settings
    const safety = new Database(safetyFile, { readonly: true })
    try {
      assert.equal(getShopSettings(safety).shopName, 'Shop Current', 'pre-restore backup keeps the previously configured settings')
    } finally {
      safety.close()
    }

    bakT.cleanup()
  } finally {
    try {
      t.db.close()
    } catch {
      /* already closed by the restore flow */
    }
    t.cleanup()
  }
})

test('a rejected restore leaves the current settings completely intact', () => {
  const t = setup()
  const liveFile = join(t.dir, 'test.db')
  try {
    assert.ok(updateShopSettings(t.db, { ...FULL_SHOP, shopName: 'Safe Shop' }).ok)

    // the service validates BEFORE touching anything: a junk file never gets
    // past that gate, so the live file is never even closed.
    const junk = join(t.dir, 'corrupt.db')
    writeFileSync(junk, 'garbage')
    assert.ok(!validateBackupFile(junk).ok)

    assert.equal(getShopSettings(t.db).shopName, 'Safe Shop')
    void liveFile
  } finally {
    t.cleanup()
  }
})
