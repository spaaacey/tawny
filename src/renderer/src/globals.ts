// Libraries the legacy classic scripts expect as window globals.
import './rich/entry';
import './chat/entry';
import * as chatModel from '../../shared/chat-model.js';
import { harborChat } from './components/chat';

Object.assign(window, { harborChatModel: chatModel, harborChat });
