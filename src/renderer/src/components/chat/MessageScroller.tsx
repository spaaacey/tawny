import { type ReactNode, type Ref, type UIEventHandler, useEffect } from 'react';
import {
  MessageScrollerItem as Item,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScroller as Root,
  useMessageScroller,
} from '../ui/message-scroller';

const JumpToEnd = ({ jumpKey }: { jumpKey: unknown }) => {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    scrollToEnd();
  }, [jumpKey, scrollToEnd]);
  return null;
};

/** Scrolling thread: follows the live edge, shows a jump-to-end button; `viewportRef`/`onViewportScroll` reach the scrolling element. */
export function MessageScroller({
  children,
  className,
  contentClassName,
  viewportRef,
  onViewportScroll,
  jumpKey,
}: {
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
  onViewportScroll?: UIEventHandler<HTMLDivElement>;
  /** jump to the live edge whenever this value changes (e.g. the user sent a prompt) */
  jumpKey?: unknown;
}) {
  return (
    <MessageScrollerProvider autoScroll>
      <Root className={className}>
        <MessageScrollerViewport ref={viewportRef} onScroll={onViewportScroll}>
          <MessageScrollerContent className={contentClassName}>{children}</MessageScrollerContent>
          {jumpKey === undefined ? null : <JumpToEnd jumpKey={jumpKey} />}
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </Root>
    </MessageScrollerProvider>
  );
}

/** One entry in the thread; `anchor` settles it near the top when it appears (the user's turn). */
export function MessageScrollerItem({
  children,
  className,
  messageId,
  anchor,
}: {
  children?: ReactNode;
  className?: string;
  messageId: string;
  anchor?: boolean;
}) {
  return (
    <Item messageId={messageId} scrollAnchor={anchor} className={className}>
      {children}
    </Item>
  );
}
