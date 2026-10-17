/**
 * Smoke test: verifies that better-sqlite3 (N-API prebuilt binary) loads inside
 * the Electron main process and that SQLite can create/read a database.
 * Uses a throwaway temp file — never touches the real application database.
 *
 * Run: npm run smoke:db   (exits 0 on success, 1 on failure)
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const { app } = require('electron')

app.whenReady().then(() => {
  try {
    const Database = require('better-sqlite3')
    const tmpDb = path.join(os.tmpdir(), `kpr-smoke-${Date.now()}.db`)
    const db = new Database(tmpDb)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    db.prepare('INSERT INTO t (v) VALUES (?)').run('hello')
    const row = db.prepare('SELECT v FROM t WHERE id = 1').get()
    const sqliteVersion = db.sqliteVersion
    const ok = row && row.v === 'hello'
    db.close()
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(tmpDb + suffix, { force: true })
    }
    if (!ok) throw new Error('Round-trip value mismatch')
    console.log(
      `[smoke] OK electron=${process.versions.electron} node=${process.versions.node} ` +
        `sqlite=${sqliteVersion} — better-sqlite3 loaded and queried successfully`
    )
    app.exit(0)
  } catch (err) {
    console.error('[smoke] FAILED:', err && err.stack ? err.stack : err)
    app.exit(1)
  }
})
