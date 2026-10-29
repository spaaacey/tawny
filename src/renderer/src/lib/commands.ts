import { tawnyDebug } from '../components/debug/session';
import { selectedText } from '../components/editor/api';
import { toggleRich } from '../components/editor/host';
import { showFind } from '../components/tree/find';
import { moveTreeSide, showView, toggleTree } from '../components/tree/store';
import {
  closeActive,
  cyclePage,
  cycleTab,
  focusEditor,
  moveActive,
  newPage,
  newTab,
  splitFocused,
  toggleZoom,
} from '../components/workspace/layoutStore';
import { closeCurrentPage, newMarkdown, pickPane, renameCurrentPage } from '../components/workspace/panes';
import { currentRoot, save as saveActive } from '../lsp/models';
import { getApp, useStore } from '../store';
import {
  addFolder,
  addRepo,
  cycleWorkspace,
  focusAgent,
  newAgent,
  newScratch,
  newSplitTerminal,
  openNewWorktree,
  openPalette,
  setSidebarSide,
  toggleSidebar,
} from './actions';
import { openQuickOpen } from './editor/fileIndex';
import { H } from './tawny';

export interface Command {
  cat: string;
  title: string;
  keys: string;
  run: () => unknown;
}

export const openSymbolPalette = () => {
  if (currentRoot()) openPalette('@');
};

/** cmd+option+f: the palette in '#' mode, seeded with the editor's (single-line) selection. */
export function openFindPalette() {
  const sel = selectedText() as string;
  openPalette(`#${sel && !/[\r\n]/.test(sel) ? sel : ''}`);
}

const dbg = () => tawnyDebug;

/** Command palette (cmd+shift+p): every menu / shortcut action, plus the ones that only exist here. */
export const COMMANDS: Command[] = (
  [
    ['File', 'New Tab', '⌘N', () => newTab()],
    ['File', 'New Tab in Split Pane', '⌘T', () => splitFocused('right')],
    ['File', 'New Terminal in Pane Below', '⌘J', () => newSplitTerminal()],
    ['File', 'New Terminal', '', () => newAgent(undefined, 'terminal')],
    ['File', 'New Markdown File…', '', () => newMarkdown()],
    ['File', 'Go to File…', '⌘P', () => openQuickOpen()],
    ['File', 'Go to Symbol in Workspace…', '⌥⌘⇧O', () => openSymbolPalette()],
    ['File', 'Save', '⌘S', () => saveActive()],
    ['File', 'Close Tab', '⌘W', () => closeActive()],
    ['File', 'New Scratch Workspace', '', () => newScratch()],
    ['File', 'Open Folder as Workspace…', '', () => addFolder()],
    ['File', 'Add Repository…', '', () => addRepo()],
    ['File', 'New Worktree…', '⌥⌘N', () => openNewWorktree()],
    ['File', 'Open Worktree in VS Code', '⌥⌘O', () => getApp().active && H.openDesktop(getApp().active as string)],
    ['File', 'Reveal Worktree in Finder', '', () => getApp().active && H.reveal(getApp().active as string)],
    ['File', 'Open Settings (tawny.json)', '⌘,', () => H.openSettings()],
    ['Go', 'Switch Worktree…', '⌥⌘P', () => useStore.getState().openOverlay('quick')],
    ['Go', 'Previous Worktree', '⌥⌘↑', () => cycleWorkspace(-1)],
    ['Go', 'Next Worktree', '⌥⌘↓', () => cycleWorkspace(1)],
    ['Go', 'Focus Editor', '⌥⌘E', () => focusEditor() || openQuickOpen()],
    ['Go', 'Focus Agent', '⌥⌘A', () => focusAgent()],
    ['Go', 'Focus Pane…', '⌘⇧J', () => pickPane()],
    ['Go', 'Previous Tab', '⌥⌘←', () => cycleTab(-1)],
    ['Go', 'Next Tab', '⌥⌘→', () => cycleTab(1)],
    ['Agent', 'New Agent', '⌥⌘T', () => newAgent()],
    ['Page', 'New Page', '⌥⇧⌘N', () => newPage()],
    ['Page', 'Close Page', '', () => closeCurrentPage()],
    ['Page', 'Rename Page', '', () => renameCurrentPage()],
    ['Page', 'Previous Page', '⌥⌘[', () => cyclePage(-1)],
    ['Page', 'Next Page', '⌥⌘]', () => cyclePage(1)],
    ['Pane', 'Split Pane Right', '', () => splitFocused('right')],
    ['Pane', 'Split Pane Down', '', () => splitFocused('bottom')],
    ['Pane', 'Move Tab to Previous Pane', '⌥⇧⌘←', () => moveActive(-1)],
    ['Pane', 'Move Tab to Next Pane', '⌥⇧⌘→', () => moveActive(1)],
    ['Pane', 'Move Tab to Pane Above', '⌥⇧⌘↑', () => moveActive('up')],
    ['Pane', 'Move Tab to Pane Below', '⌥⇧⌘↓', () => moveActive('down')],
    ['Pane', 'Toggle Pane Zoom', '⌥⌘↵', () => toggleZoom()],
    ['Debug', 'Start Debugging', 'F5', () => dbg().start()],
    ['Debug', 'Stop Debugging', '⇧F5', () => dbg().stop()],
    ['Debug', 'Continue', 'F5', () => dbg().cont()],
    ['Debug', 'Pause', '', () => dbg().pause()],
    ['Debug', 'Step Over', 'F10', () => dbg().step('next')],
    ['Debug', 'Step Into', 'F11', () => dbg().step('stepIn')],
    ['Debug', 'Step Out', '⇧F11', () => dbg().step('stepOut')],
    ['Debug', 'Toggle Breakpoint', 'F9', () => dbg().toggleBreakpoint()],
    ['Debug', 'Add Conditional Breakpoint…', '', () => dbg().condBreakpoint('condition')],
    ['Debug', 'Add Logpoint…', '', () => dbg().condBreakpoint('logMessage')],
    ['Debug', 'Remove All Breakpoints', '', () => dbg().removeAll()],
    ['Debug', 'Toggle Debug Panel', '', () => dbg().togglePanel()],
    ['View', 'Toggle Workspaces Sidebar', '⌘B', () => toggleSidebar()],
    [
      'View',
      'Move Workspaces Sidebar to Other Side',
      '',
      () => setSidebarSide(useStore.getState().sidebarSide === 'left' ? 'right' : 'left'),
    ],
    ['View', 'Minimize Secondary Sidebar (File Tree)', '⌥⌘B', () => toggleTree()],
    ['View', 'Show Files in Secondary Sidebar', '', () => showView('files')],
    ['View', 'Show Source Control in Secondary Sidebar', '^⇧G', () => showView('changes')],
    ['View', 'Find in Files', '⌥⌘F', () => openFindPalette()],
    ['View', 'Show Find in Secondary Sidebar', '', () => showFind()],
    ['View', 'Move Secondary Sidebar to Other Side', '', () => moveTreeSide()],
    ['View', 'Toggle Resource Manager', '', () => useStore.getState().toggleResources()],
    ['View', 'Toggle Rich Markdown', '⇧⌘M', () => toggleRich()],
    [
      'View',
      'Restart Language Servers',
      '',
      () => {
        for (const k of ['ts', 'ruby']) H.lspRestart(getApp().active as string, k).catch(() => {});
      },
    ],
    ['View', 'Reload Window', '⇧⌘R', () => H.runMenu('reload')],
    ['View', 'Developer Tools', '⌥⌘I', () => H.runMenu('devtools')],
    ['View', 'Zoom In', '⌘=', () => H.runMenu('zoomIn')],
    ['View', 'Zoom Out', '⌘-', () => H.runMenu('zoomOut')],
    ['View', 'Actual Size', '⌘0', () => H.runMenu('zoomReset')],
  ] as [string, string, string, () => unknown][]
).map(([cat, title, keys, run]) => ({ cat, title, keys, run }));
