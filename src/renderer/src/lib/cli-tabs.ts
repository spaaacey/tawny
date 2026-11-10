// `tawny tab ...` renderer handlers: list, focus and close the tabs of a workspace (bridge methods from src/main/cli/tab.ts).
import {
  allLeaves,
  closeKey,
  groupOf,
  leafById,
  pageOf,
  revealKey,
  useLayoutStore,
} from '../components/workspace/layoutStore';
import { agentLabel } from '../components/workspace/panes';
import { getApp } from '../store';
import { activate, focusTerm } from './actions';
import { registerCliHandler } from './cli-bridge';
import { allWorkspaces, basename, sessionsFor } from './selectors';

interface TabInfo {
  id: string;
  kind: string;
  title: string;
  workspace: string;
  focused: boolean;
}

const KINDS: Record<string, string> = {
  f: 'file',
  d: 'diff',
  m: 'mermaid',
  g: 'diagram',
  n: 'launcher',
  p: 'pr',
};

/** Tab ids are the session id for chats/terminals (same as TAWNY_CHAT_ID), the layout key for everything else. */
const idOf = (key: string) => (key.startsWith('a:') ? key.slice(2) : key);
const keyOf = (id: string) => (/^[fdmgnp]:/.test(id) ? id : `a:${id}`);

function describe(key: string, workspace: string): Omit<TabInfo, 'focused'> {
  if (key.startsWith('a:')) {
    const s = getApp().sessions.find((x) => x.id === key.slice(2)) ?? null;
    return { id: idOf(key), kind: s?.kind ?? 'agent', title: agentLabel(s), workspace };
  }
  const rest = key.slice(2);
  const title = key.startsWith('n:') ? 'new tab' : key.startsWith('p:') ? `PR ${rest}` : basename(rest);
  return { id: key, kind: KINDS[key[0]] ?? 'other', title, workspace };
}

function tabs(workspace: string): TabInfo[] {
  const app = getApp();
  const ws = useLayoutStore.getState().workspaces.get(workspace);
  const out: TabInfo[] = [];
  const seen = new Set<string>();
  if (ws) {
    const lay = pageOf(ws);
    const focusKey = leafById(lay, lay.focus)?.active ?? null;
    const isCurrent = app.active === workspace;
    for (const g of allLeaves(ws))
      for (const key of g.tabs) {
        seen.add(key);
        out.push({ ...describe(key, workspace), focused: isCurrent && key === focusKey });
      }
  }
  // workspaces never opened this run have no layout yet: fall back to their sessions
  const w = allWorkspaces(app).find((x) => x.path === workspace);
  if (w)
    for (const s of sessionsFor(app, w))
      if (!seen.has(`a:${s.id}`)) out.push({ ...describe(`a:${s.id}`, workspace), focused: false });
  return out;
}

function find(workspace: string, id: string) {
  const key = keyOf(id);
  const ws = useLayoutStore.getState().workspaces.get(workspace);
  const inLayout = !!ws && ws.pages.some((p) => groupOf(p, key));
  const inSessions =
    key.startsWith('a:') &&
    allWorkspaces(getApp()).some(
      (w) => w.path === workspace && sessionsFor(getApp(), w).some((s) => `a:${s.id}` === key),
    );
  if (inLayout || inSessions) return key;
  const valid = tabs(workspace)
    .map((t) => t.id)
    .join(', ');
  throw new Error(`unknown tab "${id}" in ${workspace}; valid ids: ${valid || 'none'}`);
}

registerCliHandler<{ workspace: string }>('tab.list', ({ workspace }) => tabs(workspace));

registerCliHandler<{ workspace: string; id: string }>('tab.focus', async ({ workspace, id }) => {
  const key = find(workspace, id);
  await activate(workspace);
  revealKey(key);
  if (key.startsWith('a:')) focusTerm(key.slice(2));
  return tabs(workspace).find((t) => t.id === id) ?? null;
});

registerCliHandler<{ workspace: string; id: string }>('tab.close', async ({ workspace, id }) => {
  const key = find(workspace, id);
  // editor tabs close through the current workspace's editors
  if (!key.startsWith('a:')) await activate(workspace);
  closeKey(key);
  return { closed: id };
});
