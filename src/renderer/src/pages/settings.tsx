import type React from 'react'
import { useEffect, useState } from 'react'
import {
  Database,
  FolderOpen,
  Loader2,
  Save,
  Settings,
  ShieldCheck,
  HardDriveDownload,
  HardDriveUpload
} from 'lucide-react'

import { PagePlaceholder } from '@/components/page-placeholder'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { DbStatus } from '@shared/ipc'
import type { ShopSettings } from '@shared/settings'
import { SHOP_LIMITS } from '@shared/settings'

const EMPTY_SHOP: ShopSettings = {
  shopName: '',
  shopAddress: '',
  shopPhone: '',
  shopPhoneAlt: '',
  gstin: '',
  receiptFooter: ''
}

export function SettingsPage() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <ShopDetailsCard />
      <BackupRestoreCard />
      <div className="p-5 pt-0">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Database className="size-4" /> Data Location
            </CardTitle>
            <CardDescription>
              All application data — including shop settings — is stored locally in your Windows
              user profile. It survives app restarts, upgrades and re-installations.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
            <FolderOpen className="size-4 shrink-0" />
            <LocalDbPath />
          </CardContent>
        </Card>
      </div>
      <div className="flex-1">
        <PagePlaceholder
          title="More Settings"
          description="Invoice numbering options, tax options and printer setup."
          icon={Settings}
          phase="Planned later"
        />
      </div>
    </div>
  )
}

// ─── Shop Details (Phase 7) ────────────────────────────────────────────

function ShopDetailsCard() {
  const [form, setForm] = useState<ShopSettings>(EMPTY_SHOP)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<keyof ShopSettings, string>>>({})
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    window.kpr.settings
      .getShop()
      .then((res) => {
        if (!alive) return
        if (res.ok) setForm(res.data)
        else setMessage({ ok: false, text: res.error.message })
      })
      .catch(() => alive && setMessage({ ok: false, text: 'Could not load the saved shop details.' }))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 6000)
    return () => clearTimeout(t)
  }, [message])

  const set = (field: keyof ShopSettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm((f) => ({ ...f, [field]: e.target.value }))
    setErrors((prev) => ({ ...prev, [field]: undefined }))
  }

  const save = async () => {
    if (saving) return
    setSaving(true)
    setErrors({})
    try {
      const res = await window.kpr.settings.updateShop(form)
      if (res.ok) {
        setForm(res.data) // trimmed values as stored
        setMessage({ ok: true, text: 'Shop details saved. They will appear on every invoice/receipt printed from now on.' })
      } else {
        setMessage({ ok: false, text: res.error.message })
        setErrors((res.error.fields ?? {}) as Partial<Record<keyof ShopSettings, string>>)
      }
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Saving failed.' })
    } finally {
      setSaving(false)
    }
  }

  const fieldError = (k: keyof ShopSettings) =>
    errors[k] && <p className="text-[11px] text-destructive">{errors[k]}</p>

  return (
    <div className="p-5 pb-0">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Settings className="size-4" /> Shop Details
          </CardTitle>
          <CardDescription>
            These details are printed at the top of A4 invoices and 80 mm receipts and in PDF
            exports. Optional fields left blank are simply omitted — nothing is invented.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading shop details…
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="shop-name">
                  Shop Name <span className="text-destructive">*</span>
                </label>
                <Input id="shop-name" value={form.shopName} onChange={set('shopName')} maxLength={SHOP_LIMITS.shopName} placeholder="e.g. KPR Firecrackers" />
                {fieldError('shopName')}
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="shop-phone">
                  Primary Phone <span className="opacity-60">(optional)</span>
                </label>
                <Input id="shop-phone" value={form.shopPhone} onChange={set('shopPhone')} maxLength={SHOP_LIMITS.shopPhone} placeholder="98765 43210" />
                {fieldError('shopPhone')}
              </div>
              <div className="flex flex-col gap-1 md:col-span-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="shop-address">
                  Shop Address <span className="opacity-60">(optional)</span>
                </label>
                <textarea
                  id="shop-address"
                  value={form.shopAddress}
                  onChange={set('shopAddress')}
                  maxLength={SHOP_LIMITS.shopAddress}
                  rows={2}
                  placeholder="Street, area, city"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                {fieldError('shopAddress')}
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="shop-phone-alt">
                  Alternate Phone <span className="opacity-60">(optional)</span>
                </label>
                <Input id="shop-phone-alt" value={form.shopPhoneAlt} onChange={set('shopPhoneAlt')} maxLength={SHOP_LIMITS.shopPhoneAlt} placeholder="" />
                {fieldError('shopPhoneAlt')}
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="shop-gstin">
                  GSTIN <span className="opacity-60">(optional — printing only; does NOT enable GST)</span>
                </label>
                <Input id="shop-gstin" value={form.gstin} onChange={set('gstin')} maxLength={SHOP_LIMITS.gstin} className="font-mono uppercase" placeholder="" />
                {fieldError('gstin')}
              </div>
              <div className="flex flex-col gap-1 md:col-span-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="shop-footer">
                  Receipt Footer Message <span className="opacity-60">(optional)</span>
                </label>
                <Input id="shop-footer" value={form.receiptFooter} onChange={set('receiptFooter')} maxLength={SHOP_LIMITS.receiptFooter} placeholder="Thank you for shopping with us!" />
                {fieldError('receiptFooter')}
              </div>
              <div className="md:col-span-2 flex flex-col gap-1.5">
                <Button onClick={() => void save()} disabled={saving}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save />} Save Shop Details
                </Button>
                {message && (
                  <p className={`text-xs ${message.ok ? 'text-emerald-700' : 'text-destructive'}`}>{message.text}</p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Backup & Restore (Phase 7) ────────────────────────────────────────

function BackupRestoreCard() {
  const [busy, setBusy] = useState<'backup' | 'restore' | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [needsRestart, setNeedsRestart] = useState(false)

  const run = async (kind: 'backup' | 'restore') => {
    if (busy) return // one flow at a time
    setBusy(kind)
    setMessage(null)
    try {
      if (kind === 'backup') {
        const res = await window.kpr.backup.create()
        if (res.ok) {
          setMessage({ ok: true, text: `Backup created (includes shop settings): ${res.data.filePath}` })
        } else {
          setMessage({ ok: false, text: res.error.message })
        }
      } else {
        const res = await window.kpr.backup.restore()
        if (res.ok) {
          setMessage({
            ok: true,
            text: `Database restored. A pre-restore safety copy was kept at ${res.data.safetyBackupPath}. Restart the app so every screen shows the restored data.`
          })
          setNeedsRestart(true)
        } else {
          setMessage({ ok: false, text: res.error.message })
        }
      }
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : `${kind} failed.` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="p-5 pb-0">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4" /> Backup &amp; Restore
          </CardTitle>
          <CardDescription>
            One click copies the ENTIRE local database — invoices, customers, products, and the
            shop details above — to a file you choose. Restoring validates the file first and
            always keeps an automatic pre-restore safety copy; a failed restore cannot lose data.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void run('backup')} disabled={busy !== null}>
              {busy === 'backup' ? <Loader2 className="size-4 animate-spin" /> : <HardDriveDownload />} Back Up Now
            </Button>
            <Button variant="outline" onClick={() => void run('restore')} disabled={busy !== null}>
              {busy === 'restore' ? <Loader2 className="size-4 animate-spin" /> : <HardDriveUpload />} Restore from Backup…
            </Button>
            {needsRestart && (
              <Button onClick={() => void window.kpr.appControl.relaunch()}>Restart Application</Button>
            )}
          </div>
          {message && <p className={`text-xs ${message.ok ? 'text-emerald-700' : 'text-destructive'}`}>{message.text}</p>}
        </CardContent>
      </Card>
    </div>
  )
}

// ─── existing Data Location card helpers ───────────────────────────────

function LocalDbPath() {
  const [status, setStatus] = useState<DbStatus | null>(null)

  useEffect(() => {
    let mounted = true
    window.kpr
      .getDbStatus()
      .then((s) => mounted && setStatus(s))
      .catch(() => mounted && setStatus(null))
    return () => {
      mounted = false
    }
  }, [])

  return (
    <>
      {status?.path ?? 'Loading…'}
      {status?.ok && (
        <Badge variant="success" className="ml-2 font-sans">
          Connected
        </Badge>
      )}
    </>
  )
}
