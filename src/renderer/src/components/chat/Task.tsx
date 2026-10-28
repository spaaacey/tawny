import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Chevron } from '../Chevron';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

type Parts = { children?: ReactNode; className?: string };

/** A collapsible list of work items (ai-elements "Task"), controlled. */
export const Task = ({
  open,
  onOpenChange,
  children,
  className,
}: Parts & { open: boolean; onOpenChange: (open: boolean) => void }) => (
  <Collapsible open={open} onOpenChange={onOpenChange} className={className}>
    {children}
  </Collapsible>
);

/** Toggle line: title, optional count, chevron. */
export const TaskTrigger = ({ title, meta, className }: { title: ReactNode; meta?: ReactNode; className?: string }) => (
  <CollapsibleTrigger
    className={cn(
      'group/task flex w-full items-center gap-1.5 text-left text-muted-foreground hover:text-foreground',
      className,
    )}
  >
    <span className="text-[var(--faint)]">{title}</span>
    {meta ? <span className="text-muted-foreground">{meta}</span> : null}
    <span className="ml-auto opacity-60 group-data-[state=open]/task:[&_.chev]:rotate-90">
      <Chevron />
    </span>
  </CollapsibleTrigger>
);

export const TaskContent = ({ children, className }: Parts) => (
  <CollapsibleContent>
    <div className={cn('mt-1 ml-1.5 flex flex-col gap-1 border-l border-border pl-3', className)}>{children}</div>
  </CollapsibleContent>
);

/** One line of a task; `status` styles it. */
export const TaskItem = ({
  status,
  children,
  className,
}: Parts & { status?: 'pending' | 'in_progress' | 'completed' }) => (
  <div
    data-status={status}
    className={cn(
      'flex items-start gap-2 text-[12px] text-muted-foreground',
      status === 'completed' && 'text-[var(--faint)] line-through',
      status === 'in_progress' && 'text-foreground',
      className,
    )}
  >
    {children}
  </div>
);

/** Inline file chip inside a TaskItem. */
export const TaskItemFile = ({ children, className }: Parts) => (
  <span className={cn('inline-flex items-center gap-1 rounded border bg-muted px-1.5 py-0.5 text-[11px]', className)}>
    {children}
  </span>
);
