import { init as initEditor, openDiffFile, openFile } from './components/editor/api';
import { toggleRich } from './components/editor/host';
import { initTree, showView, toggleTree } from './components/tree/store';
import {
  closeActive,
  cyclePage,
  cycleTab,
  focusEditor,
  initFromUi,
  moveActive,
  newPage,
  newTab,
  splitFocused,
  toggleZoom,
} from './components/workspace/layoutStore';
import { pickPane } from './components/workspace/panes';
import {
  activate,
  addFolder,
  addRepo,
  applyState,
  cycleAttention,
  cycleWorkspace,
  focusAgent,
  newAgent,
  newScratch,
  newSplitTerminal,
  openNewWorktree,
  openPalette,
  toast,
  toggleSidebar,
} from './lib/actions';
import { openFindPalette, openSymbolPalette } from './lib/commands';
import { openQuickOpen } from './lib/editor/fileIndex';
import { paletteBridge } from './lib/palette-bridge';
import { allWorkspaces } from './lib/selectors';
import { H } from './lib/tawny';
import { listenTerminals, retheme } from './lib/terminals';
import { theme } from './lib/theme';
import { revert as revertActive, save as saveActive } from './lsp/models';
import { getApp, useStore } from './store';

// Classic scripts the editor needs as globals (Monaco's AMD loader, the file icon map).
const SCRIPTS = ['monaco/vs/loader.js', 'fileicons/map.js'];

/** Appends every script at once with async=false: downloads run in parallel, execution stays in order. */
function loadScripts(srcs: string[]): Promise<void> {
  return Promise.all(
    srcs.map(
      (src) =>
        new Promise<void>((resolve, reject) => {
          const el = document.createElement('script');
          el.src = src;
          el.async = false;
          el.onload = () => resolve();
          el.onerror = () => reject(new Error(`failed to load ${src}`));
          document.body.appendChild(el);
        }),
    ),
  ).then(() => undefined);
}

// Survives HMR re-evaluation of this module (it self-accepts, and Fast Refresh re-runs App's effect): the classic
// scripts and the IPC listeners must be set up once per page.
let booting: Promise<void> | null = import.meta.hot?.data.booting ?? null;
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose((data) => {
    data.booting = booting;
  });
}

/** Loads the classic scripts and wires the app together, once per page (StrictMode runs the caller twice). */
export function boot() {
  booting ??= loadScripts(SCRIPTS.map((s) => `./${s}`))
    .then(startBridge)
    .catch((e) => console.error(e));
  return booting;
}

async function startBridge() {
  listenTerminals();
  H.onToast((m) => toast(m, 6000));
  H.onState((s) => applyState(s, { fromPush: true }));
  theme.onChange(retheme);
  H.onMenu((cmd, rawArg) => {
    // Menu args are a number (cycle/jump/move) or a side name, depending on the command.
    const arg = rawArg as never;
    const list = allWorkspaces(getApp());
    switch (cmd) {
      case 'addRepo':
        return addRepo();
      case 'newScratch':
        return newScratch();
      case 'addFolder':
        return addFolder();
      case 'newWorktree':
        return openNewWorktree();
      case 'openSettings':
        return openFile(rawArg as string, { pin: true });
      case 'palette':
        return openPalette();
      case 'quickSwitch':
        return useStore.getState().openOverlay('quick');
      case 'quickSessions':
        return useStore.getState().openOverlay('sessions');
      case 'cycle':
        return cycleWorkspace(arg);
      case 'cycleAttention':
        return cycleAttention(arg);
      case 'jump':
        if (list[arg]) activate(list[arg].path);
        return;
      case 'focusAgent':
        return focusAgent();
      case 'newAgent':
        return newAgent();
      case 'newTab':
        return newTab();
      case 'newSplitTerminal':
        return newSplitTerminal();
      case 'newSplitTab':
        return splitFocused(arg || 'right');
      case 'toggleRich':
        return toggleRich();
      case 'toggleSidebar':
        return toggleSidebar();
      case 'goToFile':
        return openQuickOpen();
      case 'goToSymbol':
        return openSymbolPalette();
      case 'save':
        return saveActive();
      case 'revert':
        return revertActive();
      case 'openDiffFile':
        return openDiffFile();
      case 'closeTab':
        return closeActive();
      case 'moveTab':
        return moveActive(arg);
      case 'togglePaneZoom':
        return toggleZoom();
      case 'pickPane':
        return pickPane();
      case 'cycleTab':
        return cycleTab(arg);
      case 'newPage':
        return newPage();
      case 'cyclePage':
        return cyclePage(arg);
      case 'focusEditor':
        return focusEditor() || openQuickOpen();
      case 'toggleTree':
        return toggleTree();
      case 'showChanges':
        return showView('changes');
      case 'findInFiles':
        return paletteBridge.inTextMode() ? paletteBridge.toSidebar() : openFindPalette();
    }
  });

  const s = await H.state();
  theme.sync(s.settings.theme);
  useStore.getState().setSidebarSide(s.ui.sidebarSide === 'right' ? 'right' : 'left');
  if (typeof s.ui.sidebarWidth === 'string') useStore.getState().setSidebarWidth(s.ui.sidebarWidth);
  initFromUi(s.ui);
  initTree(s.ui);
  initEditor(s);
  useStore.getState().setBooted();
  applyState(s);
}
