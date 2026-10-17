import { useEffect, useState } from 'react'
import { Settings, Database, FolderOpen } from 'lucide-react'

import { PagePlaceholder } from '@/components/page-placeholder'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { DbStatus } from '@shared/ipc'

export function SettingsPage() {
  return (
    <div className="flex h-full flex-col">
      <div className="p-5 pb-0">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Database className="size-4" /> Data Location
            </CardTitle>
            <CardDescription>
              All application data is stored locally in your Windows user profile. It survives
              app restarts, upgrades and re-installations.
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
          title="Settings"
          description="Shop profile, invoice numbering, tax options, printer setup, backup & restore."
          icon={Settings}
          phase="Arrives in Phase 7"
        />
      </div>
    </div>
  )
}

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
