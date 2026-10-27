import type { ComponentType, ReactNode } from 'react';

export interface ResizablePanelGroupProps {
  direction: 'horizontal' | 'vertical';
  children?: ReactNode;
}

export interface ResizablePanelProps {
  /** Percent of the group (0-100). */
  defaultSize?: number;
  /** Percent of the group (0-100). */
  minSize?: number;
  children?: ReactNode;
}

export type ResizableHandleProps = Record<string, never>;

export interface ResizableApi {
  ResizablePanelGroup: ComponentType<ResizablePanelGroupProps>;
  ResizablePanel: ComponentType<ResizablePanelProps>;
  ResizableHandle: ComponentType<ResizableHandleProps>;
}
