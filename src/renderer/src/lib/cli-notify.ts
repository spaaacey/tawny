// CLI `notify` (renderer side of bridge method `notify.send`): add a tab to the store's `unread` set (the "!" mark); focusing the tab clears it.
import { useStore } from '../store';
import { registerCliHandler } from './cli-bridge';

registerCliHandler<{ tab: string }>('notify.send', ({ tab }) => {
  const st = useStore.getState();
  const s = st.app.sessions.find((x) => x.id === tab);
  if (!s) throw new Error(`unknown tab "${tab}"`);
  if (s.kind === 'terminal') throw new Error(`tab "${tab}" is a terminal, which has no attention mark; use a chat tab`);
  if (st.focusedSession === tab) return { id: tab, marked: false, reason: 'already focused' };
  if (!st.unread.has(tab)) useStore.setState({ unread: new Set(st.unread).add(tab) });
  return { id: tab, marked: true };
});
