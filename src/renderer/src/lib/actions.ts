import type { AppState } from '../../../shared/types';
import { tawnyChat } from '../components/chat';
import { forgetRoot as forgetEditorRoot, setRoot as setEditorRoot, setLspStatus } from '../components/editor/api';
import {
  activeKey,
  currentAgent,
  expectAgent,
  focusedGroup,
  paneRightOf,
  revealAgent,
  setRoot as setLayoutRoot,
  splitFocused,
  sync,
} from '../components/workspace/layoutStore';
import { agentLabel, renderTabs } from '../components/workspace/panes';
import { getApp, useStore } from '../store';
import { alertDialog, confirmDialog } from './dialog';
import { activeWorkspace, allWorkspaces, attentionItems, sessionsFor, workspaceLabel } from './selectors';
import { H } from './tawny';
import { focusTermNow, getTerm } from './terminals';
import { theme } from './theme';

export const toast = (msg: string, ms = 4000) => useStore.getState().pushToast(msg, ms);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- state

let lastRoot: string | null = null;

/** Store the new state and bring the imperative (legacy) views in line with it. */
export function applyState(s: AppState, { fromPush = false } = {}) {
  useStore.getState().setApp(s);
  if (fromPush) {
    theme.sync(s.settings.theme);
  }
  syncLegacy(s);
  if (fromPush) tawnyChat.refresh();
}

function syncLegacy(s: AppState) {
  const w = activeWorkspace(s);
  const ids = w ? sessionsFor(s, w).map((x) => x.id) : [];
  if (s.active !== lastRoot) {
    lastRoot = s.active;
    setEditorRoot(s.active);
    setLayoutRoot(s.active, ids);
  } else sync(s.active, ids);
  setLspStatus(s.lsp);
  renderTabs();
}

export async function refreshState() {
  applyState(await H.state());
}

// ---------------------------------------------------------------- sessions

export const isChat = (id: string) => getApp().sessions.some((x) => x.id === id && x.kind === 'chat');

export function focusTerm(id: string) {
  if (isChat(id)) tawnyChat.focus(id);
  else focusTermNow(id);
}

export function focusAgent() {
  const id = currentAgent();
  if (id) {
    revealAgent(id);
    focusTerm(id);
  } else document.querySelector<HTMLElement>('.glaunch:not([hidden]) .lq')?.focus();
}

/** Start an agent (or a plain terminal) as a tab in group `gid` (default: the focused group). */
export async function newAgent(
  gid?: string,
  kind = 'agent',
  opts?: { agent?: string; sessionId?: string; title?: string },
) {
  const w = activeWorkspace(getApp());
  if (!w) return;
  expectAgent(typeof gid === 'string' ? gid : focusedGroup());
  let id: string;
  try {
    id = await H.createAgent(w.path, kind, opts);
  } catch (e) {
    toast(`Agent failed to start: ${errMsg(e)}`, 8000);
    await refreshState();
    expectAgent(null);
    return;
  }
  await refreshState();
  expectAgent(null);
  revealAgent(id);
  focusTerm(id);
  return id;
}

/** Sign in to a chat's agent: opens a terminal tab with its login command, or lets the agent authenticate itself. */
export async function chatAuth(id: string, methodId?: string) {
  expectAgent(focusedGroup());
  let nid: string | null | undefined;
  try {
    nid = await H.chatAuth(id, methodId);
  } finally {
    await refreshState();
    expectAgent(null);
  }
  if (nid) {
    revealAgent(nid);
    focusTerm(nid);
  }
}

/** Close a chat tab and continue its conversation in a terminal agent tab (same pane). */
export async function chatToTerminal(id: string) {
  expectAgent(focusedGroup());
  let nid: string;
  try {
    nid = await H.chatToTerminal(id);
  } finally {
    await refreshState();
    expectAgent(null);
  }
  revealAgent(nid);
  focusTerm(nid);
}

/** Split the focused pane downward and start a terminal in the new pane. */
export function newSplitTerminal() {
  const g = splitFocused('bottom');
  return g && newAgent(g.id, 'terminal');
}

export const stopAgent = (id: string) => H.killAgent(id);

/** Type text into the current worktree's agent (or agent `id`), starting one if needed. */
export async function sendToAgent(text: string, id?: string) {
  if (!activeWorkspace(getApp())) return;
  let target = id || currentAgent();
  if (!target) {
    await newAgent();
    await new Promise((r) => setTimeout(r, 2500));
    target = currentAgent();
  }
  if (!target) return;
  if (isChat(target)) {
    tawnyChat.insert(target, text);
    revealAgent(target);
    focusTerm(target);
    return;
  }
  H.writeAgent(target, text);
  revealAgent(target);
  focusTerm(target);
}

/** Send `ref` + `msg` to agent `id` (or the current one) and press enter; with no message just drop the reference into the prompt. */
export async function askAgent(ref: string, msg: string, id?: string) {
  const target = id || currentAgent();
  if (target && isChat(target)) {
    revealAgent(target);
    tawnyChat.ask(target, ref, msg);
    return focusTerm(target);
  }
  if (!msg) return sendToAgent(`${ref} `, id);
  await sendToAgent(`${ref} ${msg}`, id);
  const t = id || currentAgent();
  if (!t) return;
  setTimeout(() => H.writeAgent(t, '\r'), 80); // separate write so it's Enter, not part of a paste
}

/** Ask a brand-new agent, started as a tab in the pane right of group `gid` (created if there is none). */
export async function askNewAgent(ref: string, msg: string, gid: string) {
  const pane = paneRightOf(gid);
  const id = await newAgent(pane?.id ?? gid);
  if (!id) return;
  if (!isChat(id)) await new Promise((r) => setTimeout(r, 2500)); // let the terminal agent boot
  return askAgent(ref, msg, id);
}

/** The current worktree's agents and the index of the one that is current, for the selection message box. */
export function sendTargets() {
  const app = getApp();
  const w = activeWorkspace(app);
  const agents = w
    ? sessionsFor(app, w)
        .filter((s) => s.kind === 'agent' || s.kind === 'chat')
        .map((a) => ({ id: a.id, label: agentLabel(a) as string, working: a.working, waiting: a.waiting }))
    : [];
  return {
    agents,
    index: Math.max(
      0,
      agents.findIndex((a) => a.id === currentAgent()),
    ),
  };
}

// ---------------------------------------------------------------- workspaces

export async function activate(p: string) {
  if (p === getApp().active) return;
  applyState({ ...getApp(), active: p });
  try {
    await H.activate(p);
  } catch (e) {
    toast(errMsg(e));
  }
}

export async function addRepo() {
  try {
    await H.addRepo();
  } catch (e) {
    void alertDialog(errMsg(e));
  }
}

export async function newScratch() {
  try {
    await H.addScratch();
  } catch (e) {
    toast(errMsg(e));
  }
}

export async function addFolder() {
  try {
    await H.addFolder();
  } catch (e) {
    toast(errMsg(e));
  }
}

export async function removeWorkspace(p: string) {
  const app = getApp();
  const w = allWorkspaces(app).find((x) => x.path === p);
  if (!w) return;
  const ss = sessionsFor(app, w);
  const what = w.scratch ? 'Its folder is deleted if empty.' : 'The folder is untouched.';
  const stops = ss.length ? `${ss.length} agent/terminal tab(s) will be stopped. ` : '';
  if (
    !(await confirmDialog({
      title: 'Remove workspace',
      message: `Remove workspace "${workspaceLabel(w)}"?\n\n${stops}${what}`,
      confirmLabel: 'Remove',
      danger: true,
    }))
  )
    return;
  try {
    await H.removeWorkspace(p);
    forgetEditorRoot(p);
  } catch (e) {
    void alertDialog(errMsg(e));
  }
}

export async function removeRepo(repo: string) {
  if (
    await confirmDialog({
      title: 'Remove repository',
      message: `Remove ${repo.split('/').pop()} from Tawny?\n\nNothing on disk is deleted.`,
      confirmLabel: 'Remove',
    })
  )
    await H.removeRepo(repo);
}

export async function deleteWorktree(p: string) {
  const app = getApp();
  const w = allWorkspaces(app).find((x) => x.path === p);
  if (!w) return;
  const ss = sessionsFor(app, w);
  const stops = ss.length ? `${ss.length} agent(s) will be stopped. ` : '';
  if (
    !(await confirmDialog({
      title: 'Delete worktree',
      message: `Delete worktree "${workspaceLabel(w)}"?\n\n${w.path}\n${stops}The branch is kept.`,
      confirmLabel: 'Delete',
      danger: true,
    }))
  )
    return;
  const forget = () => forgetEditorRoot(p);
  try {
    await H.deleteWorktree({ path: p });
    forget();
  } catch (e) {
    const msg = errMsg(e);
    const dirty = /modified|untracked|dirty|locked/i.test(msg);
    if (
      dirty &&
      (await confirmDialog({
        title: 'Delete worktree',
        message: `It has uncommitted changes:\n${msg}\n\nDelete anyway?`,
        confirmLabel: 'Delete anyway',
        danger: true,
      }))
    ) {
      try {
        await H.deleteWorktree({ path: p, force: true });
        forget();
      } catch (e2) {
        void alertDialog(errMsg(e2));
      }
    } else if (!dirty) void alertDialog(msg);
  }
}

/** Jump to the next (d=1) / previous (d=-1) agent that needs you, wrapping; starts from the focused one. */
export async function cycleAttention(d: number) {
  const { app, unread, focusedSession } = useStore.getState();
  const items = attentionItems(app, unread, focusedSession);
  if (!items.length) return;
  const at = items.findIndex((it) => it.s.id === focusedSession);
  const next = items[at < 0 ? (d > 0 ? 0 : items.length - 1) : (at + d + items.length) % items.length];
  await activate(next.w.path);
  revealAgent(next.s.id);
  focusTerm(next.s.id);
}

/** cmd+`: open the session switcher (needs-attention first) and step through it; the switcher commits on cmd release. */
export function cycleSessions(d: number) {
  const st = useStore.getState();
  if (st.overlay === 'sessions' && st.sessionCycle) return st.setSessionCycle({ n: st.sessionCycle.n + d });
  st.openOverlay('sessions');
  st.setSessionCycle({ n: d });
}

export function cycleWorkspace(d: number) {
  const app = getApp();
  const list = allWorkspaces(app);
  const i = list.findIndex((w) => w.path === app.active);
  if (list.length) activate(list[(i + d + list.length) % list.length].path);
}

export async function openNewWorktree(repo?: string) {
  const app = getApp();
  if (!app.repos.length) return addRepo();
  useStore.getState().setWorktreeRepo(repo || activeWorkspace(app)?.repo || app.repos[0].path);
  useStore.getState().openOverlay('worktree');
}

export function openPalette(initial = '>') {
  const st = useStore.getState();
  st.setPaletteInitial(initial);
  st.openOverlay('palette');
}

export function setSidebarSide(side: 'left' | 'right') {
  useStore.getState().setSidebarSide(side);
  H.saveUi({ sidebarSide: side });
}

export async function revealSession(p: string, id: string) {
  await activate(p);
  revealAgent(id);
  focusTerm(id);
}

// ---------------------------------------------------------------- views the layout hosts

/** The element of an agent tab: a chat view or an xterm, created outside React and re-parented by the pane. */
export const termEl = (id: string) => (isChat(id) ? tawnyChat.el(id) : getTerm(id).el);

export const agentInfo = (id: string) => getApp().sessions.find((x) => x.id === id) ?? null;

export const appSettings = () => getApp().settings;

export const toggleSidebar = () => useStore.getState().toggleSidebar();

/** Mark the sidebar row of the focused agent tab. */
export function markSidebar() {
  const k = activeKey();
  const id = k?.startsWith('a:') ? k.slice(2) : null;
  useStore.getState().setFocusedSession(id);
  H.setFocusedAgent(id);
}
