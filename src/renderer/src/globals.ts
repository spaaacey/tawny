// Libraries the legacy classic scripts expect as window globals.
import './rich/entry';
import './chat/entry';
import * as chatModel from '../../shared/chat-model';
import { harborFind } from './components/tree/find';
import { iconFor } from './lib/fileicons';

Object.assign(window, {
  harborChatModel: chatModel,
  harborFind,
  harborIconFor: iconFor,
});
