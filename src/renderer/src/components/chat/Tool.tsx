import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CodeBlock, CodeBlockContent } from '../ui/code-block';
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../ui/trace';

type Parts = { children?: ReactNode; className?: string };

/** One tool call, controlled; className is layout-only. */
export const Tool = ({
  open,
  onOpenChange,
  children,
  className,
}: Parts & { open: boolean; onOpenChange: (open: boolean) => void }) => (
  <TraceCollapsible open={open} onOpenChange={onOpenChange} className={className}>
    {children}
  </TraceCollapsible>
);

/** The always-visible toggle line: icon, title, status mark, chevron. */
export const ToolHeader = ({
  icon,
  title,
  status,
  state,
}: {
  icon?: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  state?: 'running' | 'error' | 'done';
}) => (
  <TraceCollapsibleTrigger>
    <TraceLine status={state === 'done' ? undefined : state}>
      {icon ? <TraceIcon>{icon}</TraceIcon> : null}
      <TraceTitle>{title}</TraceTitle>
      {status ? <TraceIcon>{status}</TraceIcon> : null}
    </TraceLine>
  </TraceCollapsibleTrigger>
);

/** Only mounted while open. */
export const ToolContent = ({ children, className }: Parts) => (
  <TraceCollapsibleContent className={className}>{children}</TraceCollapsibleContent>
);

/** A command, input or output block; `error` tints it, `command` highlights it, output is dimmed. */
export const ToolCode = ({
  children,
  variant,
  command,
  className,
  contentClassName,
}: {
  children: string;
  variant?: 'default' | 'error';
  command?: boolean;
  className?: string;
  contentClassName?: string;
}) => (
  <CodeBlock
    size="sm"
    variant={variant === 'error' ? 'destructive' : 'default'}
    className={cn(command ? 'border-transparent bg-muted/60' : 'text-foreground/70', className)}
  >
    <CodeBlockContent
      wrap
      className={cn(
        contentClassName ?? 'max-h-80',
        'text-[11.5px] leading-[1.45] group-data-[size=sm]/code-block:px-2.5 group-data-[size=sm]/code-block:py-1.5',
        command && 'text-foreground',
      )}
    >
      {command ? (
        <span>
          <span className="select-none text-primary">$ </span>
          {children.trim()}
        </span>
      ) : (
        children.replace(/^\s*\n/, '').trimEnd()
      )}
    </CodeBlockContent>
  </CodeBlock>
);
