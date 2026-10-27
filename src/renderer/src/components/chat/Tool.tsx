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
import { coloredLines, useColorVersion } from './highlight';

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
  path,
  className,
  contentClassName,
}: {
  children: string;
  variant?: 'default' | 'error';
  command?: boolean;
  /** File name whose language colors the text; commands are colored as shell. */
  path?: string;
  className?: string;
  contentClassName?: string;
}) => {
  useColorVersion();
  const text = command ? children.trim() : children.replace(/^\s*\n/, '').trimEnd();
  const lines = command || path ? coloredLines(text, command ? 'command.sh' : (path as string)) : null;
  return (
    <CodeBlock
      size="sm"
      variant={variant === 'error' ? 'destructive' : 'default'}
      className={cn(variant === 'error' ? 'text-foreground' : 'border-transparent bg-muted/60', className)}
    >
      <CodeBlockContent
        wrap
        className={cn(
          contentClassName ?? 'max-h-80',
          'text-[11.5px] leading-[1.45] group-data-[size=sm]/code-block:px-2.5 group-data-[size=sm]/code-block:py-1.5',
          command && 'text-foreground',
        )}
      >
        <span>
          {command ? <span className="select-none text-primary">$ </span> : null}
          {lines ? <span dangerouslySetInnerHTML={{ __html: lines.join('\n').replaceAll('\u00a0', ' ') }} /> : text}
        </span>
      </CodeBlockContent>
    </CodeBlock>
  );
};
