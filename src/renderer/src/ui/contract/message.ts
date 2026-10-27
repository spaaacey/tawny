import type { ComponentType, ReactNode, Ref, UIEventHandler } from 'react';

type Parts = { children?: ReactNode; className?: string };

export interface MessageApi {
  /** one turn in the thread; `end` right-aligns it (the user's turn) */
  Message: ComponentType<Parts & { align?: 'start' | 'end' }>;
  MessageContent: ComponentType<Parts>;
  /** the visible chip around a turn's text */
  Bubble: ComponentType<Parts & { align?: 'start' | 'end'; variant?: 'default' | 'muted' | 'ghost' }>;
  BubbleContent: ComponentType<Parts>;

  /** scrolling thread: follows the live edge, shows a jump-to-end button; `viewportRef`/`onViewportScroll` reach the scrolling element */
  MessageScroller: ComponentType<
    Parts & {
      contentClassName?: string;
      viewportRef?: Ref<HTMLDivElement>;
      onViewportScroll?: UIEventHandler<HTMLDivElement>;
    }
  >;
  /** one entry in the thread; `anchor` settles it near the top when it appears (the user's turn) */
  MessageScrollerItem: ComponentType<Parts & { messageId: string; anchor?: boolean }>;
}
