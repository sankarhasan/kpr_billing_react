// TEMP inspection helper (deleted after verification)
import Database from 'better-sqlite3'
const db = new Database('C:/Users/Rabin Thilak/AppData/Roaming/kpr-billing/kpr-billing.db', { readonly: true })
console.log('count:', db.prepare('SELECT COUNT(*) c FROM products').get().c)
console.log('oldest/newest created_at:', JSON.stringify(db.prepare('SELECT product_code, created_at FROM products ORDER BY created_at LIMIT 3').all()))
console.log('newest:', JSON.stringify(db.prepare('SELECT product_code, created_at FROM products ORDER BY created_at DESC LIMIT 3').all()))
console.log('TEST-UI:', JSON.stringify(db.prepare("SELECT product_code, created_at FROM products WHERE product_code = 'TEST-UI'").all()))
console.log('settings:', JSON.stringify(db.prepare("SELECT key, value FROM settings WHERE key IN ('schema_version','tax_enabled')").all()))
db.close()
