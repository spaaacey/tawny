import { BrainIcon, ChevronDownIcon, DotIcon } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { createContext, useContext } from "react"
import { cn } from "@/lib/utils"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible"

// Adapted from AI Elements' chain-of-thought (registry.ai-sdk.dev): a single
// controlled Collapsible shares open state between header and content.
const OpenContext = createContext(false)

function ChainOfThought({
  className,
  open,
  onOpenChange,
  children,
  ...props
}: Omit<ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> & {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <OpenContext.Provider value={open}>
      <Collapsible
        data-slot="chain-of-thought"
        open={open}
        onOpenChange={onOpenChange}
        className={cn("not-prose space-y-2", className)}
        {...props}
      >
        {children}
      </Collapsible>
    </OpenContext.Provider>
  )
}

function ChainOfThoughtHeader({
  className,
  children,
  ...props
}: ComponentProps<typeof CollapsibleTrigger>) {
  const open = useContext(OpenContext)
  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-2 text-muted-foreground transition-colors hover:text-foreground",
        className
      )}
      {...props}
    >
      <BrainIcon className="size-5" />
      <span className="flex-1 text-left">{children ?? "Chain of Thought"}</span>
      <ChevronDownIcon
        className={cn("size-5 transition-transform", open && "rotate-180")}
      />
    </CollapsibleTrigger>
  )
}

function ChainOfThoughtContent({
  className,
  ...props
}: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      className={cn("mt-2 space-y-3 outline-none", className)}
      {...props}
    />
  )
}

function ChainOfThoughtStep({
  className,
  label,
  description,
  status = "complete",
  children,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  label?: ReactNode
  description?: ReactNode
  status?: "complete" | "active" | "pending"
  children?: ReactNode
}) {
  const tone = {
    complete: "text-muted-foreground",
    active: "text-foreground",
    pending: "text-muted-foreground/50",
  }[status]
  return (
    <div className={cn("flex gap-2", tone, className)} {...props}>
      <div className="relative mt-0.5">
        <DotIcon className="size-5" />
        <div className="absolute top-7 bottom-0 left-1/2 -mx-px w-px bg-border" />
      </div>
      <div className="flex-1 space-y-2 overflow-hidden">
        {label && <div>{label}</div>}
        {description && (
          <div className="text-xs text-muted-foreground">{description}</div>
        )}
        {children}
      </div>
    </div>
  )
}

export {
  ChainOfThought,
  ChainOfThoughtHeader,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
}
