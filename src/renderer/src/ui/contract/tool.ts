import type { ComponentType, ReactNode } from 'react';

type Parts = { children?: ReactNode; className?: string };

export interface ToolApi {
  /** one tool call, controlled; className is layout-only */
  Tool: ComponentType<Parts & { open: boolean; onOpenChange: (open: boolean) => void }>;
  /** the always-visible toggle line: icon, title, status mark, chevron */
  ToolHeader: ComponentType<{
    icon?: ReactNode;
    title: ReactNode;
    status?: ReactNode;
    state?: 'running' | 'error' | 'done';
  }>;
  /** only mounted while open */
  ToolContent: ComponentType<Parts>;
  /** a command, input or output block; `error` tints it */
  ToolCode: ComponentType<{ children: string; variant?: 'default' | 'error'; className?: string }>;
}
