import type { AppState } from '../../../shared/types';
import { getApp, useStore } from '../store';
import { Editor, H, Layout } from './legacy';
import { activeWorkspace, allWorkspaces, sessionsFor, workspaceLabel } from './selectors';
import { focusTermNow } from './terminals';
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
  if (fromPush) window.harborChat.refresh();
}

function syncLegacy(s: AppState) {
  const w = activeWorkspace(s);
  const ids = w ? sessionsFor(s, w).map((x) => x.id) : [];
  if (s.active !== lastRoot) {
    lastRoot = s.active;
    Editor().setRoot(s.active);
    Layout().setRoot(s.active, ids);
  } else Layout().sync(s.active, ids);
  Editor().setLspStatus(s.lsp);
  Layout().renderTabs();
}

export async function refreshState() {
  applyState(await H.state());
}

// ---------------------------------------------------------------- sessions

export const isChat = (id: string) => getApp().sessions.some((x) => x.id === id && x.kind === 'chat');

export function focusTerm(id: string) {
  if (isChat(id)) window.harborChat.focus(id);
  else focusTermNow(id);
}

export function focusAgent() {
  const id = Layout().currentAgent();
  if (id) {
    Layout().revealAgent(id);
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
  const lay = Layout();
  lay.expectAgent(typeof gid === 'string' ? gid : lay.focusedGroup());
  let id: string;
  try {
    id = await H.createAgent(w.path, kind, opts);
  } catch (e) {
    toast(`Agent failed to start: ${errMsg(e)}`, 8000);
    await refreshState();
    lay.expectAgent(null);
    return;
  }
  await refreshState();
  lay.expectAgent(null);
  lay.revealAgent(id);
  focusTerm(id);
}

/** Sign in to a chat's agent: opens a terminal tab with its login command, or lets the agent authenticate itself. */
export async function chatAuth(id: string, methodId?: string) {
  const lay = Layout();
  lay.expectAgent(lay.focusedGroup());
  let nid: string | undefined;
  try {
    nid = await H.chatAuth(id, methodId);
  } finally {
    await refreshState();
    lay.expectAgent(null);
  }
  if (nid) {
    lay.revealAgent(nid);
    focusTerm(nid);
  }
}

/** Close a chat tab and continue its conversation in a terminal agent tab (same pane). */
export async function chatToTerminal(id: string) {
  const lay = Layout();
  lay.expectAgent(lay.focusedGroup());
  let nid: string;
  try {
    nid = await H.chatToTerminal(id);
  } finally {
    await refreshState();
    lay.expectAgent(null);
  }
  lay.revealAgent(nid);
  focusTerm(nid);
}

/** Split the focused pane downward and start a terminal in the new pane. */
export function newSplitTerminal() {
  const g = Layout().splitFocused('bottom');
  return g && newAgent(g.id, 'terminal');
}

export const stopAgent = (id: string) => H.killAgent(id);

/** Type text into the current worktree's agent (or agent `id`), starting one if needed. */
export async function sendToAgent(text: string, id?: string) {
  if (!activeWorkspace(getApp())) return;
  let target = id || Layout().currentAgent();
  if (!target) {
    await newAgent();
    await new Promise((r) => setTimeout(r, 2500));
    target = Layout().currentAgent();
  }
  if (!target) return;
  if (isChat(target)) {
    window.harborChat.insert(target, text);
    Layout().revealAgent(target);
    focusTerm(target);
    return;
  }
  H.writeAgent(target, text);
  Layout().revealAgent(target);
  focusTerm(target);
}

/** Send `ref` + `msg` to agent `id` (or the current one) and press enter; with no message just drop the reference into the prompt. */
export async function askAgent(ref: string, msg: string, id?: string) {
  const target = id || Layout().currentAgent();
  if (target && isChat(target)) {
    Layout().revealAgent(target);
    window.harborChat.ask(target, ref, msg);
    return focusTerm(target);
  }
  if (!msg) return sendToAgent(`${ref} `, id);
  await sendToAgent(`${ref} ${msg}`, id);
  const t = id || Layout().currentAgent();
  if (!t) return;
  setTimeout(() => H.writeAgent(t, '\r'), 80); // separate write so it's Enter, not part of a paste
}

/** The current worktree's agents and the index of the one that is current, for the selection message box. */
export function sendTargets() {
  const app = getApp();
  const w = activeWorkspace(app);
  const agents = w
    ? sessionsFor(app, w)
        .filter((s) => s.kind === 'agent' || s.kind === 'chat')
        .map((a) => ({ id: a.id, label: Layout().agentLabel(a) as string, working: a.working, waiting: a.waiting }))
    : [];
  return {
    agents,
    index: Math.max(
      0,
      agents.findIndex((a) => a.id === Layout().currentAgent()),
    ),
  };
}

export function composeToAgent(ref: string) {
  if (!activeWorkspace(getApp())) return;
  const st = useStore.getState();
  st.setSendRef(ref);
  st.openOverlay('send');
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
    alert(errMsg(e));
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
  if (!confirm(`Remove workspace "${workspaceLabel(w)}"?\n\n${stops}${what}`)) return;
  try {
    await H.removeWorkspace(p);
    Editor().forgetRoot(p);
  } catch (e) {
    alert(errMsg(e));
  }
}

export async function removeRepo(repo: string) {
  if (confirm(`Remove ${repo.split('/').pop()} from Tawny?\n\nNothing on disk is deleted.`)) await H.removeRepo(repo);
}

export async function deleteWorktree(p: string) {
  const app = getApp();
  const w = allWorkspaces(app).find((x) => x.path === p);
  if (!w) return;
  const ss = sessionsFor(app, w);
  const stops = ss.length ? `${ss.length} agent(s) will be stopped. ` : '';
  if (!confirm(`Delete worktree "${workspaceLabel(w)}"?\n\n${w.path}\n${stops}The branch is kept.`)) return;
  const forget = () => Editor().forgetRoot(p);
  try {
    await H.deleteWorktree({ path: p });
    forget();
  } catch (e) {
    const msg = errMsg(e);
    const dirty = /modified|untracked|dirty|locked/i.test(msg);
    if (dirty && confirm(`It has uncommitted changes:\n${msg}\n\nDelete anyway?`)) {
      try {
        await H.deleteWorktree({ path: p, force: true });
        forget();
      } catch (e2) {
        alert(errMsg(e2));
      }
    } else if (!dirty) alert(msg);
  }
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
  Layout().revealAgent(id);
  focusTerm(id);
}
