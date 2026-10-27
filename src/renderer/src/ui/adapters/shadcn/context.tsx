"use client"

import { Button } from "@/ui/adapters/shadcn/button"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/ui/adapters/shadcn/hover-card"
import { Progress } from "@/ui/adapters/shadcn/progress"

function formatTokens(value: number) {
  if (value >= 1e6) return `${+(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${+(value / 1e3).toFixed(1)}k`
  return String(value)
}

function Context({ used, limit }: { used: number; limit: number }) {
  if (!limit) return null
  const percent = Math.min(100, Math.round((used / limit) * 100))

  return (
    <HoverCard openDelay={10} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Button variant="outline" size="sm">
          {percent}% context
        </Button>
      </HoverCardTrigger>
      <HoverCardContent className="flex w-64 flex-col gap-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">Context</span>
          <span className="text-muted-foreground">
            {formatTokens(used)} / {formatTokens(limit)}
          </span>
        </div>
        <Progress value={percent} aria-label="Context used" />
        <div className="text-muted-foreground text-xs">
          {used.toLocaleString()} of {limit.toLocaleString()} tokens
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

export { Context }
