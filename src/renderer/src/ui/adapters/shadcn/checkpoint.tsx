import { BookmarkIcon } from "lucide-react"
import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"
import { Button } from "./button"
import { Separator } from "./separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

// Adapted from AI Elements' checkpoint (registry.ai-sdk.dev).
function Checkpoint({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="checkpoint"
      className={cn("flex items-center gap-0.5 overflow-hidden text-muted-foreground", className)}
      {...props}
    >
      {children}
      <Separator />
    </div>
  )
}

function CheckpointIcon({ className, children, ...props }: ComponentProps<typeof BookmarkIcon>) {
  return (
    children ?? <BookmarkIcon className={cn("size-4 shrink-0", className)} {...props} />
  )
}

function CheckpointTrigger({
  children,
  variant = "ghost",
  size = "sm",
  tooltip,
  ...props
}: ComponentProps<typeof Button> & { tooltip?: string }) {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
    </Button>
  )
  if (!tooltip) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent align="start" side="bottom">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export { Checkpoint, CheckpointIcon, CheckpointTrigger }
