// Workspace facade. The model lives in layoutStore.ts; the pane tree, tab bars, page bar,
// tab DnD and launcher are React (components/workspace). `harborLayout` is the window-global
// surface the rest of the app still calls until step 6 replaces it with direct imports.

import {
  agentLabel,
  dragFile,
  markFocused,
  newMarkdown,
  pickPane,
  renderTabs,
  useUiTick,
} from '../components/workspace/panes';
import {
  activeFile,
  activeKey,
  closeActive,
  closePage as closePageAt,
  currentAgent,
  cyclePage,
  cycleTab,
  diffKeys,
  expectAgent,
  filesOf,
  focusEditor,
  focusedGroup,
  forgetRoot,
  hasFile,
  hasKey,
  initFromUi,
  moveActive,
  newPage,
  newTab,
  openDiff,
  openFile,
  openKey,
  pages,
  removeFile,
  removeKey,
  revealAgent,
  setPage,
  setRoot,
  splitFocused,
  sync,
  toggleZoom,
  useLayoutStore,
  visibleAgents,
} from './layoutStore';

const L = () => useLayoutStore.getState();

// ------------------------------------------------------------------ facade

const init = initFromUi;

export const harborLayout = {
  init,
  setRoot,
  sync,
  renderTabs,
  agentLabel,
  openFile,
  removeFile,
  revealAgent,
  currentAgent,
  visibleAgents,
  activeFile,
  focusEditor,
  hasFile,
  hasKey,
  openKey,
  filesOf,
  diffKeys,
  forgetRoot,
  dragFile,
  openDiff,
  removeKey,
  activeKey,
  moveActive,
  cycleTab,
  toggleZoom,
  pickPane,
  splitFocused,
  newTab,
  newMarkdown,
  newPage,
  closePage: () => {
    const { root, workspaces } = L();
    const ws = root ? workspaces.get(root) : undefined;
    if (ws) closePageAt(ws.at);
  },
  renamePage: () => {
    const { root, workspaces } = L();
    const ws = root ? workspaces.get(root) : undefined;
    if (ws) useUiTick.setState({ renamePageAt: ws.at });
  },
  cyclePage,
  setPage,
  pages,
  focusGroup: markFocused,
  focusedGroup,
  expectAgent,
  closeActive,
};

window.harborLayout = harborLayout;
