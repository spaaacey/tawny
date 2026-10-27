import { TerminalIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../ui/trace';
import { ToolCode } from './Tool';

/** File a command prints (`cat src/a.ts`), so its output can be colored as that language. */
const printedFile = (cmd: string) => {
  const m = cmd.match(/^(?:cat|head|tail|bat|less)\s+(?:-\S+\s+)*(\S+\.\w+)\s*$/);
  return m?.[1].replace(/^['"]|['"]$/g, '');
};

/** Row title fallback when the agent gave no description: first line, without a leading `cd <dir> &&`. */
const shortCommand = (cmd: string) => cmd.replace(/^cd\s+\S+\s*&&\s*/, '').split('\n')[0];

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
  const label = description || shortCommand(command);
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
              <ToolCode command className="self-stretch" contentClassName="max-h-32">
                {command}
              </ToolCode>
            ) : null}
            {output ? (
              <ToolCode className="self-stretch" contentClassName="max-h-64" path={printedFile(command)}>
                {output}
              </ToolCode>
            ) : null}
            {children}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
