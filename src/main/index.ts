/**
 * KPR Billing - Electron main process entry.
 * Security posture: nodeIntegration OFF, contextIsolation ON, sandbox ON.
 * All SQLite access lives here (see ./db) behind validated IPC handlers (./ipc).
 */
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { initDatabase, closeDatabase, getDbStatus } from './db'
import { registerIpcHandlers } from './ipc'

// Keep a stable data folder ("kpr-billing" in %APPDATA%) for dev and packaged builds,
// so the database persists across restarts and app upgrades, and never sits in a
// temporary build/output directory.
app.setPath('userData', join(app.getPath('appData'), 'kpr-billing'))

// Single-instance lock: focus the existing window instead of opening a second app.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'KPR Billing',
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Open external http(s) links in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Dev: electron-vite injects ELECTRON_RENDERER_URL; Prod: load bundled files.
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Headless verification hook: KPR_VERIFY=1 launches the built app, confirms
  // the renderer mounted, the preload bridge works and the DB is alive,
  // then exits with a pass/fail code.
  if (process.env['KPR_VERIFY'] === '1') {
    mainWindow.webContents.once('did-finish-load', async () => {
      // Give React a moment to mount and run its initial IPC calls.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const status = getDbStatus()
      console.log(`[verify] database ok=${status.ok} schema=${status.schemaVersion} path=${status.path}`)
      try {
        const rendererOk: boolean = await mainWindow!.webContents.executeJavaScript(
          '(document.getElementById("root")?.childElementCount ?? 0) > 0 && !!window.kpr'
        )
        const ipcOk: boolean = await mainWindow!.webContents.executeJavaScript(
          'window.kpr.getDbStatus().then((s) => s.ok === true && s.schemaVersion > 0).catch(() => false)'
        )
        // End-to-end product CRUD through the secure IPC bridge. A temporary
        // product is created and ALWAYS removed again (never left as sample
        // data); duplicate-code guard and pagination search are exercised too.
        const productsResult: string = await mainWindow!.webContents.executeJavaScript(`
          (async () => {
            try {
              const code = 'ZVERIFY' + Date.now();
              const input = {
                productCode: code,
                productName: 'VERIFY TEMP (auto-removed)',
                category: '', brand: '',
                ratePaise: 12345, discountType: 'none', discountPercent: 0, discountAmountPaise: 0,
                finalRatePaise: 12345, greenCracker: false,
                description: 'Temporary row from the automated verify run.', imagePath: '',
                restoreActive: false
              };
              const created = await window.kpr.products.create(input);
              if (!created.ok) return 'CREATE_FAILED:' + JSON.stringify(created.error);
              const listRes = await window.kpr.products.list({ search: code });
              const found = listRes.total === 1;
              const dup = await window.kpr.products.create(input);
              const dupGuard = !dup.ok && dup.error.code === 'DUPLICATE_CODE';
              const upd = await window.kpr.products.update(created.data.id, { ...input, ratePaise: 99999, finalRatePaise: 99999 });
              const removed = await window.kpr.products.remove(created.data.id);
              const gone = (await window.kpr.products.list({ search: code })).total === 0;
              return found && dupGuard && upd.ok && removed.ok && removed.data.action === 'deleted' && gone
                ? 'PRODUCTS_IPC_OK' : 'PRODUCTS_IPC_MISMATCH';
            } catch (e) {
              return 'PRODUCTS_IPC_THROW:' + (e && e.message ? e.message : String(e));
            }
          })()
        `)
        const schemaOk = status.ok && status.schemaVersion === 2
        console.log(`[verify] renderer_mounted=${rendererOk} preload_ipc=${ipcOk} products=${productsResult}`)
        const allOk = rendererOk && ipcOk && schemaOk && productsResult === 'PRODUCTS_IPC_OK'
        console.log(allOk ? '[verify] PHASE2_ALL_OK' : '[verify] FAILURE')
        app.exit(allOk ? 0 : 3)
      } catch (err) {
        console.error('[verify] RENDERER CHECK ERROR:', err)
        app.exit(4)
      }
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error(`[verify] RENDERER LOAD FAILED: ${code} ${desc}`)
      app.exit(2)
    })
    // Surface renderer errors during verification.
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log(`[verify][renderer ${level}] ${message}`)
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  initDatabase()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  closeDatabase()
})
