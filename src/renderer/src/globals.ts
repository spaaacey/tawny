// Libraries the classic scripts expect as window globals.
import './rich/entry';
import './chat/entry';
import * as chatModel from '../../shared/chat-model';
import { tawnyFind } from './components/tree/find';
import { iconFor } from './lib/fileicons';

Object.assign(window, {
  tawnyChatModel: chatModel,
  tawnyFind,
  tawnyIconFor: iconFor,
});
