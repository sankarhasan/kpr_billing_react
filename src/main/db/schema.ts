/**
 * SQLite schema definitions.
 *
 * v1 (Phase 1) — preserved verbatim below as LEGACY_SCHEMA_V1_SQL so that
 * existing Phase 1 databases can be detected and migrated safely.
 * v2 (Phase 2) — products table rebuilt around integer-paise money, unique
 * product codes, discount definition and NO stock fields (per requirements).
 */

export const SCHEMA_VERSION = 5

/** Non-product base tables. v3: customers notes+archived_at. v4: invoices paise+snapshots. v5: invoices round_off_paise. */
export const BASE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  phone         TEXT    NOT NULL DEFAULT '',
  address       TEXT    NOT NULL DEFAULT '',
  gstin         TEXT    NOT NULL DEFAULT '',
  notes         TEXT    NOT NULL DEFAULT '',
  archived_at   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone);

CREATE TABLE IF NOT EXISTS invoices (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number    TEXT    NOT NULL UNIQUE,
  customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name     TEXT    NOT NULL DEFAULT 'Walk-in Customer',
  customer_phone    TEXT    NOT NULL DEFAULT '',
  customer_address  TEXT    NOT NULL DEFAULT '',
  invoice_date      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  subtotal_paise    INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_paise >= 0),
  discount_paise    INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  round_off_paise   INTEGER NOT NULL DEFAULT 0,
  tax_amount_paise  INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount_paise >= 0),
  total_paise       INTEGER NOT NULL DEFAULT 0 CHECK (total_paise >= 0),
  payment_mode      TEXT    NOT NULL DEFAULT 'cash',
  status            TEXT    NOT NULL DEFAULT 'completed',
  notes             TEXT    NOT NULL DEFAULT '',
  created_at        TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices (invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices (invoice_number);

CREATE TABLE IF NOT EXISTS invoice_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id            INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id            INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_code          TEXT    NOT NULL DEFAULT '',
  product_name          TEXT    NOT NULL,
  quantity              REAL    NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_paise      INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_paise >= 0),
  line_total_paise      INTEGER NOT NULL DEFAULT 0 CHECK (line_total_paise >= 0),
  original_rate_paise   INTEGER NOT NULL DEFAULT 0,
  discount_type         TEXT    NOT NULL DEFAULT 'none',
  discount_percent      REAL    NOT NULL DEFAULT 0,
  discount_amount_paise INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** Current (v2) products table. Money as INTEGER paise; no stock columns. */
export const PRODUCTS_V2_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS products (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  product_code         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  product_name         TEXT    NOT NULL,
  category             TEXT    NOT NULL DEFAULT '',
  brand                TEXT    NOT NULL DEFAULT '',
  rate_paise           INTEGER NOT NULL DEFAULT 0 CHECK (rate_paise >= 0),
  discount_type        TEXT    NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none','percent','amount')),
  discount_percent     REAL    NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  discount_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount_paise >= 0),
  final_rate_paise     INTEGER NOT NULL DEFAULT 0 CHECK (final_rate_paise >= 0),
  green_cracker        INTEGER NOT NULL DEFAULT 0 CHECK (green_cracker IN (0, 1)),
  description          TEXT    NOT NULL DEFAULT '',
  image_path           TEXT    NOT NULL DEFAULT '',
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at           TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`

export const PRODUCTS_V2_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_products_name ON products (product_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
`

/**
 * Default application settings (not sample business data).
 * tax_enabled = 0 keeps GST disabled by default per requirements.
 */
export const DEFAULT_SETTINGS_SQL = `
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('shop_name', 'KPR Firecrackers'),
  ('tax_enabled', '0'),
  ('invoice_prefix', 'KPR-'),
  ('next_invoice_number', '1'),
  ('round_off_enabled', '0'),
  ('currency_symbol', '₹'),
  ('receipt_footer', 'Thank you for shopping with us!');
`

/**
 * v3 invoices/invoice_items DDL (REAL rupee money, no snapshot columns).
 * Kept ONLY so v3 -> v4 upgrade tests can build a realistic old database.
 * Do NOT execute on new databases.
 */
export const LEGACY_V3_INVOICES_SQL = `
CREATE TABLE IF NOT EXISTS invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number  TEXT    NOT NULL UNIQUE,
  customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  invoice_date    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  subtotal        REAL    NOT NULL DEFAULT 0,
  discount        REAL    NOT NULL DEFAULT 0,
  tax_amount      REAL    NOT NULL DEFAULT 0,
  total           REAL    NOT NULL DEFAULT 0,
  payment_mode    TEXT    NOT NULL DEFAULT 'cash',
  status          TEXT    NOT NULL DEFAULT 'completed',
  notes           TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name  TEXT    NOT NULL,
  quantity      REAL    NOT NULL DEFAULT 1,
  unit          TEXT    NOT NULL DEFAULT 'pcs',
  unit_price    REAL    NOT NULL DEFAULT 0,
  line_total    REAL    NOT NULL DEFAULT 0,
  gst_rate      REAL    NOT NULL DEFAULT 0,
  gst_amount    REAL    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id);
`

/**
 * Phase 1 (v1) schema, kept ONLY for detection/migration and its tests.
 * Do NOT execute on new databases.
 */
export const LEGACY_SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  category      TEXT    NOT NULL DEFAULT '',
  unit          TEXT    NOT NULL DEFAULT 'pcs',
  sale_price    REAL    NOT NULL DEFAULT 0,
  cost_price    REAL    NOT NULL DEFAULT 0,
  hsn           TEXT    NOT NULL DEFAULT '',
  gst_rate      REAL    NOT NULL DEFAULT 0,
  tax_enabled   INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_products_name ON products (name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);

CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  phone         TEXT    NOT NULL DEFAULT '',
  address       TEXT    NOT NULL DEFAULT '',
  gstin         TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone);

CREATE TABLE IF NOT EXISTS invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number  TEXT    NOT NULL UNIQUE,
  customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  invoice_date    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  subtotal        REAL    NOT NULL DEFAULT 0,
  discount        REAL    NOT NULL DEFAULT 0,
  tax_amount      REAL    NOT NULL DEFAULT 0,
  total           REAL    NOT NULL DEFAULT 0,
  payment_mode    TEXT    NOT NULL DEFAULT 'cash',
  status          TEXT    NOT NULL DEFAULT 'completed',
  notes           TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices (invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices (invoice_number);

CREATE TABLE IF NOT EXISTS invoice_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name  TEXT    NOT NULL,
  quantity      REAL    NOT NULL DEFAULT 1,
  unit          TEXT    NOT NULL DEFAULT 'pcs',
  unit_price    REAL    NOT NULL DEFAULT 0,
  line_total    REAL    NOT NULL DEFAULT 0,
  gst_rate      REAL    NOT NULL DEFAULT 0,
  gst_amount    REAL    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
