import { initTree, showView, toggleTree } from './components/tree/store';
import {
  activate,
  addFolder,
  addRepo,
  applyState,
  askAgent,
  chatAuth,
  chatToTerminal,
  composeToAgent,
  cycleWorkspace,
  focusAgent,
  focusTerm,
  isChat,
  newAgent,
  newScratch,
  newSplitTerminal,
  openNewWorktree,
  openPalette,
  revealSession,
  sendTargets,
  sendToAgent,
  stopAgent,
  toast,
} from './lib/actions';
import { openFindPalette, openSymbolPalette } from './lib/commands';
import { Editor, H, type HarborApp, Layout } from './lib/legacy';
import { paletteBridge } from './lib/palette-bridge';
import { allWorkspaces } from './lib/selectors';
import { fitAll, getTerm, listenTerminals, retheme } from './lib/terminals';
import { getApp, useStore } from './store';

/** window.harborApp: what the classic-script modules (layout, editor, chat, debug, find) call back into. */
const app: HarborApp = {
  openPalette,
  settings: () => getApp().settings,
  toast,
  sendToAgent,
  composeToAgent,
  askAgent,
  sendTargets,
  newAgent,
  chatAuth,
  chatToTerminal,
  stopAgent,
  fitAll,
  focusTerm,
  termEl: (id) => (isChat(id) ? window.harborChat.el(id) : getTerm(id).el),
  renameAgent: (id, title) => H.renameAgent(id, title),
  markSidebar: () => {
    const k = Layout().activeKey() as string | null;
    useStore.getState().setFocusedSession(k?.startsWith('a:') ? k.slice(2) : null);
  },
  toggleSidebar: () => useStore.getState().toggleSidebar(),
  state: getApp,
  revealSession,
  activePath: () => allWorkspaces(getApp()).find((w) => w.path === getApp().active)?.path ?? null,
  agentInfo: (id) => getApp().sessions.find((x) => x.id === id) ?? null,
};

/** Runs once, after the legacy scripts have loaded. */
export async function startBridge() {
  window.harborApp = app;
  listenTerminals();
  H.onToast((m) => toast(m, 6000));
  H.onState((s) => applyState(s, { fromPush: true }));
  window.harborTheme.onChange(retheme);
  H.onMenu((cmd, rawArg) => {
    // Menu args are a number (cycle/jump/move) or a side name, depending on the command.
    const arg = rawArg as never;
    const list = allWorkspaces(getApp());
    const lay = Layout();
    switch (cmd) {
      case 'addRepo':
        return addRepo();
      case 'newScratch':
        return newScratch();
      case 'addFolder':
        return addFolder();
      case 'newWorktree':
        return openNewWorktree();
      case 'palette':
        return openPalette();
      case 'quickSwitch':
        return useStore.getState().openOverlay('quick');
      case 'cycle':
        return cycleWorkspace(arg);
      case 'jump':
        if (list[arg]) activate(list[arg].path);
        return;
      case 'focusAgent':
        return focusAgent();
      case 'newAgent':
        return newAgent();
      case 'newTab':
        return lay.newTab();
      case 'newSplitTerminal':
        return newSplitTerminal();
      case 'newSplitTab':
        return lay.splitFocused(arg || 'right');
      case 'toggleRich':
        return Editor().toggleRich();
      case 'toggleSidebar':
        return useStore.getState().toggleSidebar();
      case 'goToFile':
        return Editor().openQuickOpen();
      case 'goToSymbol':
        return openSymbolPalette();
      case 'save':
        return Editor().save();
      case 'closeTab':
        return lay.closeActive();
      case 'moveTab':
        return lay.moveActive(arg);
      case 'togglePaneZoom':
        return lay.toggleZoom();
      case 'pickPane':
        return lay.pickPane();
      case 'cycleTab':
        return lay.cycleTab(arg);
      case 'newPage':
        return lay.newPage();
      case 'cyclePage':
        return lay.cyclePage(arg);
      case 'focusEditor':
        return lay.focusEditor() || Editor().openQuickOpen();
      case 'toggleTree':
        return toggleTree();
      case 'showChanges':
        return showView('changes');
      case 'findInFiles':
        return paletteBridge.inTextMode() ? paletteBridge.toSidebar() : openFindPalette();
    }
  });

  const s = await H.state();
  window.harborTheme.sync(s.settings.theme);
  useStore.getState().setSidebarSide(s.ui.sidebarSide === 'right' ? 'right' : 'left');
  window.harborLayout.init(s.ui);
  initTree(s.ui);
  window.harborEditor.init(s);
  useStore.getState().setLegacyReady();
  applyState(s);
}
