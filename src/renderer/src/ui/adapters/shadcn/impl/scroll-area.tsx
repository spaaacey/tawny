import type { ScrollAreaProps } from '../../../contract/scroll-area';
import { ScrollArea as SA } from '../scroll-area';

// Radix wraps content in a display:table div, which breaks text-overflow ellipsis; force block.
export const ScrollArea = ({ className, children }: ScrollAreaProps) => (
  <SA className={`${className ?? ''} [&_[data-slot=scroll-area-viewport]>div]:!block`}>{children}</SA>
);
