import type { ComponentType, ReactNode } from 'react';

type Parts = { children?: ReactNode; className?: string };

export interface ChainOfThoughtApi {
  /** controlled; className is layout-only */
  ChainOfThought: ComponentType<Parts & { open: boolean; onOpenChange: (open: boolean) => void }>;
  /** the always-visible toggle: brain icon, label (children), chevron */
  ChainOfThoughtHeader: ComponentType<Parts>;
  /** only mounted while open */
  ChainOfThoughtContent: ComponentType<Parts>;
  /** one reasoning step on the timeline rail */
  ChainOfThoughtStep: ComponentType<
    Parts & { label?: ReactNode; description?: ReactNode; status?: 'complete' | 'active' | 'pending' }
  >;
}
