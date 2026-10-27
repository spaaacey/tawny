import type { ComponentType, ReactNode } from 'react';

type Parts = { children?: ReactNode; className?: string };

export interface CollapsibleApi {
  /** controlled; className is layout-only */
  Collapsible: ComponentType<Parts & { open: boolean; onOpenChange: (open: boolean) => void }>;
  /** the always-visible header that toggles the content; sets data-state="open|closed" */
  CollapsibleTrigger: ComponentType<Parts>;
  /** only mounted while open */
  CollapsibleContent: ComponentType<Parts>;
}
