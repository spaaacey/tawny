import type { MessageApi } from '../../../contract/message';
import * as B from '../bubble';
import * as M from '../message';
import * as S from '../message-scroller';

export const Message: MessageApi['Message'] = M.Message;
export const MessageContent: MessageApi['MessageContent'] = M.MessageContent;
export const Bubble: MessageApi['Bubble'] = B.Bubble;
export const BubbleContent: MessageApi['BubbleContent'] = B.BubbleContent;

export const MessageScroller: MessageApi['MessageScroller'] = ({
  children,
  className,
  contentClassName,
  viewportRef,
  onViewportScroll,
}) => (
  <S.MessageScrollerProvider autoScroll>
    <S.MessageScroller className={className}>
      <S.MessageScrollerViewport ref={viewportRef} onScroll={onViewportScroll}>
        <S.MessageScrollerContent className={contentClassName}>{children}</S.MessageScrollerContent>
      </S.MessageScrollerViewport>
      <S.MessageScrollerButton />
    </S.MessageScroller>
  </S.MessageScrollerProvider>
);
export const MessageScrollerItem: MessageApi['MessageScrollerItem'] = ({ children, className, messageId, anchor }) => (
  <S.MessageScrollerItem messageId={messageId} scrollAnchor={anchor} className={className}>
    {children}
  </S.MessageScrollerItem>
);
