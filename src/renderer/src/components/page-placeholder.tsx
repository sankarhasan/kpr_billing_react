import type { LucideIcon } from 'lucide-react'
import { Construction } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface PlaceholderProps {
  title: string
  description: string
  icon: LucideIcon
  phase: string
}

export function PagePlaceholder({ title, description, icon: Icon, phase }: PlaceholderProps) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-muted">
            <Icon className="size-7 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          <Badge variant="secondary" className="gap-1.5 py-1">
            <Construction className="size-3.5" />
            {phase}
          </Badge>
        </CardContent>
      </Card>
    </div>
  )
}
