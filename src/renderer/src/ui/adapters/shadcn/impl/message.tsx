import type { MessageApi } from '../../../contract/message';
import * as B from '../bubble';
import * as M from '../message';

export const Message: MessageApi['Message'] = M.Message;
export const MessageContent: MessageApi['MessageContent'] = M.MessageContent;
export const Bubble: MessageApi['Bubble'] = B.Bubble;
export const BubbleContent: MessageApi['BubbleContent'] = B.BubbleContent;
