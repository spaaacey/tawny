import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { H } from '../../lib/harbor';
import { dirtyText } from '../editor/api';
import { ChatView } from './ChatView';
import { ChatController } from './controller';

interface Entry {
  ctl: ChatController;
  host: HTMLElement;
  root: Root;
}
const chats = new Map<string, Entry>();

function ensure(id: string): Entry {
  let e = chats.get(id);
  if (!e) {
    const host = document.createElement('div');
    host.className = 'chat';
    host.hidden = true;
    const ctl = new ChatController(id);
    const root = createRoot(host);
    root.render(createElement(ChatView, { ctl, host }));
    e = { ctl, host, root };
    chats.set(id, e);
  }
  return e;
}

H.onChatUpdate((id, e) => chats.get(id)?.ctl.dispatch({ k: 'u', seq: e.seq, update: e.update }));
H.onChatPermission((id, req) => chats.get(id)?.ctl.dispatch({ k: 'p', req }));
H.onChatPermissionDone((id, reqId) => chats.get(id)?.ctl.dispatch({ k: 'd', reqId }));
H.onChatStatus((id, st) => chats.get(id)?.ctl.dispatch({ k: 's', status: st.status, error: st.error, auth: st.auth }));
// the agent reads a file it doesn't run itself: answer with the editor's unsaved text when there is any
H.onChatReadFile((id, req) => H.chatFileReply(id, req.reqId, dirtyText(req.path)));

/** What the layout and actions call to host and drive chat tabs. */
export const harborChat = {
  el: (id: string) => ensure(id).host,
  focus: (id: string) => chats.get(id)?.ctl.focus(),
  dispose(id: string) {
    const e = chats.get(id);
    if (!e) return;
    e.root.unmount();
    e.host.remove();
    chats.delete(id);
  },
  insert: (id: string, text: string) => ensure(id).ctl.insert(text),
  ask: (id: string, ref: string, msg?: string) => ensure(id).ctl.ask(ref, msg ?? ''),
  /** Session state (working/waiting) changed in main. */
  refresh() {
    for (const e of chats.values()) e.ctl.schedule();
  },
};
