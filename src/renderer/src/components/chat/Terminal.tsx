import { TerminalIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { CodeBlock, CodeBlockContent } from '../ui/code-block';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../ui/trace';

/** A shell command and its output; `exitCode` other than 0 (or `failed`) marks it as an error. */
export function Terminal({
  command,
  description,
  output,
  running,
  exitCode,
  failed,
  duration,
  open,
  onOpenChange,
  children,
}: {
  command: string;
  description?: string;
  output: string;
  running: boolean;
  exitCode?: number | null;
  failed?: boolean;
  duration?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
}) {
  const error = !running && (failed || !!exitCode);
  const label = description || command;
  const title = error ? (exitCode ? `${label} (exit ${exitCode})` : `${label} (failed)`) : label;
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={onOpenChange}>
        <TraceCollapsibleTrigger>
          <TraceLine status={running ? 'running' : error ? 'error' : undefined}>
            <TraceIcon>
              <TerminalIcon />
            </TraceIcon>
            <TraceTitle>{title}</TraceTitle>
            {duration ? <TraceIcon className="w-auto text-[11px] opacity-60">{duration}</TraceIcon> : null}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="ml-0 border-l-0 pl-0 pr-0">
          <div className="flex flex-col items-start gap-1.5">
            {command ? (
              <CodeBlock size="sm" className="self-stretch">
                <CodeBlockContent wrap className="max-h-32 px-2.5 py-1.5 text-[12px]">
                  {`$ ${command}`}
                </CodeBlockContent>
              </CodeBlock>
            ) : null}
            {output ? (
              <CodeBlock size="sm" className="self-stretch">
                <CodeBlockContent wrap className="max-h-64 px-2.5 py-1.5 text-[12px]">
                  {output}
                </CodeBlockContent>
              </CodeBlock>
            ) : null}
            {children}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
