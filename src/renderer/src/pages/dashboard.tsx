import { useEffect, useState } from 'react'
import {
  Database,
  Package,
  Users,
  ReceiptText,
  ShieldCheck,
  BadgeIndianRupee,
  FolderOpen
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { AppInfo, DbStatus } from '@shared/ipc'

function StatCard({
  title,
  value,
  icon: Icon
}: {
  title: string
  value: number
  icon: typeof Package
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {title}
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{value.toLocaleString()}</div>
        </div>
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </div>
      </CardContent>
    </Card>
  )
}

export function DashboardPage() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    Promise.all([window.kpr.getAppInfo(), window.kpr.getDbStatus()])
      .then(([info, status]) => {
        if (!mounted) return
        setAppInfo(info)
        setDbStatus(status)
      })
      .catch((err: unknown) => {
        if (mounted) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      mounted = false
    }
  }, [])

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Dashboard</h1>
          <p className="text-xs text-muted-foreground">
            Overview of your shop &mdash; local data, no internet required.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="success" className="gap-1">
            <ShieldCheck className="size-3.5" /> Offline Ready
          </Badge>
          <Badge variant="secondary" className="gap-1">
            <BadgeIndianRupee className="size-3.5" /> GST Disabled
          </Badge>
        </div>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-sm text-destructive">
            IPC / database error: {error}
          </CardContent>
        </Card>
      )}

      {/* Row 1: data counts (0 until Phase 2+ features add real records) */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          title="Products"
          value={dbStatus?.counts.products ?? 0}
          icon={Package}
        />
        <StatCard
          title="Customers"
          value={dbStatus?.counts.customers ?? 0}
          icon={Users}
        />
        <StatCard
          title="Invoices"
          value={dbStatus?.counts.invoices ?? 0}
          icon={ReceiptText}
        />
      </div>

      {/* Row 2: system status */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Database className="size-4" /> Local Database
            </CardTitle>
            <CardDescription>SQLite via secure IPC (main process)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              {dbStatus ? (
                dbStatus.ok ? (
                  <Badge variant="success">Initialized</Badge>
                ) : (
                  <Badge variant="destructive">Error</Badge>
                )
              ) : (
                <Badge variant="outline">Checking…</Badge>
              )}
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Schema version</span>
              <span className="font-medium tabular-nums">{dbStatus?.schemaVersion ?? '—'}</span>
            </div>
            <div className="flex items-start justify-between gap-4">
              <span className="shrink-0 text-muted-foreground">Data file</span>
              <span className="flex items-center gap-1.5 truncate text-right font-mono text-xs">
                <FolderOpen className="size-3.5 shrink-0" />
                {dbStatus?.path ?? '—'}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Application</CardTitle>
            <CardDescription>Runtime information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Version</span>
              <span className="font-medium tabular-nums">{appInfo?.version ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Electron</span>
              <span className="font-medium tabular-nums">{appInfo?.electronVersion ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Platform</span>
              <span className="font-medium">{appInfo?.platform ?? '—'}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Phase 1 foundation complete. Product, customer, billing and history features will appear
        here in later phases.
      </p>
    </div>
  )
}
