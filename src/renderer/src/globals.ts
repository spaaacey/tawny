// Libraries the legacy classic scripts expect as window globals.
import './rich/entry';
import './chat/entry';
import * as chatModel from '../../shared/chat-model.js';
import { harborChat } from './components/chat';
import { harborFind } from './components/tree/find';
import { harborTree } from './components/tree/store';
import { iconFor } from './lib/fileicons';

Object.assign(window, { harborChatModel: chatModel, harborChat, harborFind, harborTree, harborIconFor: iconFor });
