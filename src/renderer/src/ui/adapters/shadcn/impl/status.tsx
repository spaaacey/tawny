import type { StatusApi } from '../../../contract/status';
import { Badge } from '../badge';
import { Spinner as ShadcnSpinner } from '../spinner';
import { Tooltip as ShadcnTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip';

const DOT = {
  waiting: 'bg-[var(--wait)] animate-pulse',
  idle: 'bg-[var(--idle)]',
  none: 'border-[1.5px] border-[var(--faint)] bg-transparent',
} as const;

export const StatusDot: StatusApi['StatusDot'] = ({ state, size = 'md' }) => {
  const px = state === 'none' || size === 'sm' ? 'size-1.5' : 'size-[7px]';
  return <Badge className={`${px} min-w-0 rounded-full border p-0 ${DOT[state]}`} />;
};

export const Spinner: StatusApi['Spinner'] = ({ size = 'md' }) => (
  <ShadcnSpinner className={`${size === 'sm' ? 'size-3' : 'size-3.5'} text-[var(--work)]`} />
);

export const Tooltip: StatusApi['Tooltip'] = ({ content, side = 'top', children }) => (
  <ShadcnTooltip>
    <TooltipTrigger asChild>{children as React.ReactElement}</TooltipTrigger>
    <TooltipContent side={side}>{content}</TooltipContent>
  </ShadcnTooltip>
);

export const UIProvider: StatusApi['UIProvider'] = ({ children }) => (
  <TooltipProvider delayDuration={400}>{children}</TooltipProvider>
);
