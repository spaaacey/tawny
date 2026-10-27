import type { ComponentType, ReactNode } from 'react';

type Parts = { children?: ReactNode; className?: string };

export interface MessageApi {
  /** one turn in the thread; `end` right-aligns it (the user's turn) */
  Message: ComponentType<Parts & { align?: 'start' | 'end' }>;
  MessageContent: ComponentType<Parts>;
  /** the visible chip around a turn's text */
  Bubble: ComponentType<Parts & { align?: 'start' | 'end'; variant?: 'default' | 'muted' | 'ghost' }>;
  BubbleContent: ComponentType<Parts>;
}
