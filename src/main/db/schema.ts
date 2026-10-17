/**
 * Initial SQLite schema for KPR Billing (Phase 1).
 * Tables are created but full management features arrive in later phases.
 * GST/tax is disabled by default (tax_enabled = 0 in settings, 0 rates on rows).
 */

export const SCHEMA_VERSION = 1

export const INITIAL_SCHEMA_SQL = `
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
  ('currency_symbol', '₹'),
  ('receipt_footer', 'Thank you for shopping with us!'),
  ('schema_version', '1');
`
