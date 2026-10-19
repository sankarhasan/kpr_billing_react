/**
 * Settings data-access (main process only).
 *
 * Reads/writes the EXISTING key/value `settings` table — the new shop-detail
 * fields are additive keys, so NO schema migration is required and the
 * values automatically ride along in database backups/restores (Phase 7).
 * Only a fixed allowlist of keys is ever touched; values are validated with
 * the shared rules before anything is written. GSTIN is stored/returned for
 * PRINTING only — invoice taxation remains governed solely by the separate
 * 'tax_enabled' setting, which this module never writes.
 */
import type Database from 'better-sqlite3'
import {
  SHOP_SETTING_KEYS,
  validateShopSettings,
  type ShopSettings
} from '../../shared/settings.ts'
import { DEFAULT_PRINT_INFO, type PrintInfo } from '../../shared/print.ts'
import { ipcErr, ipcOk, type IpcResult } from '../../shared/products.ts'

type Db = Database.Database

function getSettingValue(db: Db, key: string): string {
  const row = db
    .prepare<[{ key: string }], { value: string }>('SELECT value FROM settings WHERE key = @key')
    .get({ key })
  return row?.value ?? ''
}

const UPSERT_SETTING = `
  INSERT INTO settings (key, value) VALUES (@key, @value)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`

export function getShopSettings(db: Db): ShopSettings {
  return {
    shopName: getSettingValue(db, SHOP_SETTING_KEYS.shopName),
    shopAddress: getSettingValue(db, SHOP_SETTING_KEYS.shopAddress),
    shopPhone: getSettingValue(db, SHOP_SETTING_KEYS.shopPhone),
    shopPhoneAlt: getSettingValue(db, SHOP_SETTING_KEYS.shopPhoneAlt),
    shopEmail: getSettingValue(db, SHOP_SETTING_KEYS.shopEmail),
    gstin: getSettingValue(db, SHOP_SETTING_KEYS.gstin),
    receiptFooter: getSettingValue(db, SHOP_SETTING_KEYS.receiptFooter)
  }
}

/** Validate then persist ALL shop fields in one transaction (blank = cleared). */
export function updateShopSettings(db: Db, rawInput: unknown): IpcResult<ShopSettings> {
  const { errors, value } = validateShopSettings(rawInput)
  if (Object.keys(errors).length > 0) {
    return ipcErr<ShopSettings>('VALIDATION', 'Please correct the highlighted fields.', errors as Record<string, string>)
  }
  const tx = db.transaction(() => {
    const stmt = db.prepare(UPSERT_SETTING)
    for (const [field, key] of Object.entries(SHOP_SETTING_KEYS)) {
      stmt.run({ key, value: (value as unknown as Record<string, string>)[field] })
    }
  })
  tx()
  return ipcOk(getShopSettings(db))
}

/** Allowlisted printable business details for invoice/receipt documents. */
export function getPrintInfo(db: Db): PrintInfo {
  const s = getShopSettings(db)
  return {
    shopName: s.shopName.trim() || DEFAULT_PRINT_INFO.shopName,
    shopAddress: s.shopAddress.trim(),
    shopPhone: s.shopPhone.trim(),
    shopPhoneAlt: s.shopPhoneAlt.trim(),
    shopEmail: s.shopEmail.trim(),
    gstin: s.gstin.trim(),
    receiptFooter: s.receiptFooter.trim()
  }
}
