import type { ReactNode } from 'react';
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
  <TraceCollapsibleTrigger className="w-full">
    <TraceLine status={state === 'done' ? undefined : state} className="w-full flex-1">
      {icon ? <TraceIcon>{icon}</TraceIcon> : null}
      <TraceTitle className="flex-1">{title}</TraceTitle>
      {status ? <TraceIcon>{status}</TraceIcon> : null}
    </TraceLine>
  </TraceCollapsibleTrigger>
);

/** Only mounted while open. */
export const ToolContent = ({ children, className }: Parts) => (
  <TraceCollapsibleContent className={className}>{children}</TraceCollapsibleContent>
);

/** A command, input or output block; `error` tints it. */
export const ToolCode = ({
  children,
  variant,
  className,
}: {
  children: string;
  variant?: 'default' | 'error';
  className?: string;
}) => (
  <CodeBlock size="sm" variant={variant === 'error' ? 'destructive' : 'default'} className={className}>
    <CodeBlockContent wrap className="max-h-80 px-2.5 py-1.5 text-[12px]">
      {children}
    </CodeBlockContent>
  </CodeBlock>
);
