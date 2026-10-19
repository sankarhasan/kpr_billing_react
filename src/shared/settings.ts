/**
 * Shop Details settings (Phase 7) — shared types and validation.
 *
 * These values live in the existing key/value `settings` table (additive
 * keys only — NO schema migration), so they are automatically included in
 * database backups and restored with them; there is deliberately no second
 * configuration file. GSTIN is stored/printed only if the shop enters it —
 * it NEVER affects invoice calculations (GST stays governed solely by the
 * existing `tax_enabled` setting).
 */

export interface ShopSettings {
  shopName: string
  shopAddress: string
  shopPhone: string
  shopPhoneAlt: string
  gstin: string
  receiptFooter: string
}

/** The settings-table key backing each field (existing keys reused). */
export const SHOP_SETTING_KEYS: Record<keyof ShopSettings, string> = {
  shopName: 'shop_name',
  shopAddress: 'shop_address',
  shopPhone: 'shop_phone',
  shopPhoneAlt: 'shop_phone_alt',
  gstin: 'gstin',
  receiptFooter: 'receipt_footer'
}

export const SHOP_LIMITS = {
  shopName: 100,
  shopAddress: 200,
  shopPhone: 30,
  shopPhoneAlt: 30,
  gstin: 20,
  receiptFooter: 200
} as const

/** Digits with common phone punctuation only. */
const PHONE_RE = /^[0-9+()\-\s]+$/
/** Standard 15-character GSTIN: state code (2) + PAN (10) + entity (1) + 'Z' + check digit. */
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/

export interface ShopSettingsValidation {
  errors: Partial<Record<keyof ShopSettings, string>>
  value: ShopSettings
}

/** Trim + validate an untrusted shop-settings form payload. */
export function validateShopSettings(raw: unknown): ShopSettingsValidation {
  const o = (raw ?? {}) as Record<string, unknown>
  const errors: Partial<Record<keyof ShopSettings, string>> = {}

  const text = (field: keyof ShopSettings, label: string, required = false): string => {
    const v = o[field]
    const s = typeof v === 'string' ? v.trim() : ''
    if (s.length > SHOP_LIMITS[field]) {
      errors[field] = `${label} must be at most ${SHOP_LIMITS[field]} characters.`
    }
    if (required && s === '') {
      errors[field] = `${label} is required.`
    }
    return s
  }

  const shopName = text('shopName', 'Shop name', true)
  const shopAddress = text('shopAddress', 'Address')
  const shopPhone = text('shopPhone', 'Primary phone')
  const shopPhoneAlt = text('shopPhoneAlt', 'Alternate phone')
  const gstin = text('gstin', 'GSTIN').toUpperCase()
  const receiptFooter = text('receiptFooter', 'Footer message')

  if (shopPhone && !PHONE_RE.test(shopPhone)) {
    errors.shopPhone = 'Phone may contain digits and + ( ) - spaces only.'
  }
  if (shopPhoneAlt && !PHONE_RE.test(shopPhoneAlt)) {
    errors.shopPhoneAlt = 'Phone may contain digits and + ( ) - spaces only.'
  }
  if (gstin && !GSTIN_RE.test(gstin)) {
    errors.gstin = 'GSTIN must be the standard 15-character format (e.g. 22ABCDE1234F1Z5).'
  }

  return {
    errors,
    value: { shopName, shopAddress, shopPhone, shopPhoneAlt, gstin, receiptFooter }
  }
}
