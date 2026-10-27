import type { ToolApi } from '../../../contract/tool';
import { CodeBlock, CodeBlockContent } from '../code-block';
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../trace';

export const Tool: ToolApi['Tool'] = ({ open, onOpenChange, children, className }) => (
  <TraceCollapsible open={open} onOpenChange={onOpenChange} className={className}>
    {children}
  </TraceCollapsible>
);

export const ToolHeader: ToolApi['ToolHeader'] = ({ icon, title, status, state }) => (
  <TraceCollapsibleTrigger className="w-full">
    <TraceLine status={state === 'done' ? undefined : state} className="w-full flex-1">
      {icon ? <TraceIcon>{icon}</TraceIcon> : null}
      <TraceTitle className="flex-1">{title}</TraceTitle>
      {status ? <TraceIcon>{status}</TraceIcon> : null}
    </TraceLine>
  </TraceCollapsibleTrigger>
);

export const ToolContent: ToolApi['ToolContent'] = ({ children, className }) => (
  <TraceCollapsibleContent className={className}>{children}</TraceCollapsibleContent>
);

export const ToolCode: ToolApi['ToolCode'] = ({ children, variant, className }) => (
  <CodeBlock size="sm" variant={variant === 'error' ? 'destructive' : 'default'} className={className}>
    <CodeBlockContent wrap className="max-h-80 px-2.5 py-1.5 text-[12px]">
      {children}
    </CodeBlockContent>
  </CodeBlock>
);
