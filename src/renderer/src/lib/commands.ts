import { showFind } from '../components/tree/find';
import { moveTreeSide, showView, toggleTree } from '../components/tree/store';
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
} from './actions';
import { Editor, H, Layout } from './legacy';

export interface Command {
  cat: string;
  title: string;
  keys: string;
  run: () => unknown;
}

export const openSymbolPalette = () => {
  if (Editor().root) openPalette('@');
};

/** cmd+option+f: the palette in '#' mode, seeded with the editor's (single-line) selection. */
export function openFindPalette() {
  const sel = Editor().selectedText() as string;
  openPalette(`#${sel && !/[\r\n]/.test(sel) ? sel : ''}`);
}

const dbg = () => window.harborDebug;

/** Command palette (cmd+shift+p): every menu / shortcut action, plus the ones that only exist here. */
export const COMMANDS: Command[] = (
  [
    ['File', 'New Tab', '⌘N', () => Layout().newTab()],
    ['File', 'New Tab in Split Pane', '⌘T', () => Layout().splitFocused('right')],
    ['File', 'New Terminal in Pane Below', '⌘J', () => newSplitTerminal()],
    ['File', 'New Terminal', '', () => newAgent(undefined, 'terminal')],
    ['File', 'New Markdown File…', '', () => Layout().newMarkdown()],
    ['File', 'Go to File…', '⌘P', () => Editor().openQuickOpen()],
    ['File', 'Go to Symbol in Workspace…', '⌥⌘⇧O', () => openSymbolPalette()],
    ['File', 'Save', '⌘S', () => Editor().save()],
    ['File', 'Close Tab', '⌘W', () => Layout().closeActive()],
    ['File', 'New Scratch Workspace', '', () => newScratch()],
    ['File', 'Open Folder as Workspace…', '', () => addFolder()],
    ['File', 'Add Repository…', '', () => addRepo()],
    ['File', 'New Worktree…', '⌥⌘N', () => openNewWorktree()],
    ['File', 'Open Worktree in VS Code', '⌥⌘O', () => getApp().active && H.openDesktop(getApp().active as string)],
    ['File', 'Reveal Worktree in Finder', '', () => getApp().active && H.reveal(getApp().active as string)],
    ['File', 'Open Settings (harbor.json)', '⌘,', () => H.openSettings()],
    ['Go', 'Switch Worktree…', '⌥⌘P', () => useStore.getState().openOverlay('quick')],
    ['Go', 'Previous Worktree', '⌥⌘↑', () => cycleWorkspace(-1)],
    ['Go', 'Next Worktree', '⌥⌘↓', () => cycleWorkspace(1)],
    ['Go', 'Focus Editor', '⌥⌘E', () => Layout().focusEditor() || Editor().openQuickOpen()],
    ['Go', 'Focus Agent', '⌥⌘A', () => focusAgent()],
    ['Go', 'Focus Pane…', '⌘⇧J', () => Layout().pickPane()],
    ['Go', 'Previous Tab', '⌥⌘←', () => Layout().cycleTab(-1)],
    ['Go', 'Next Tab', '⌥⌘→', () => Layout().cycleTab(1)],
    ['Agent', 'New Agent', '⌥⌘T', () => newAgent()],
    ['Page', 'New Page', '⌥⇧⌘N', () => Layout().newPage()],
    ['Page', 'Close Page', '', () => Layout().closePage()],
    ['Page', 'Rename Page', '', () => Layout().renamePage()],
    ['Page', 'Previous Page', '⌥⌘[', () => Layout().cyclePage(-1)],
    ['Page', 'Next Page', '⌥⌘]', () => Layout().cyclePage(1)],
    ['Pane', 'Split Pane Right', '', () => Layout().splitFocused('right')],
    ['Pane', 'Split Pane Down', '', () => Layout().splitFocused('bottom')],
    ['Pane', 'Move Tab to Previous Pane', '⌥⇧⌘←', () => Layout().moveActive(-1)],
    ['Pane', 'Move Tab to Next Pane', '⌥⇧⌘→', () => Layout().moveActive(1)],
    ['Pane', 'Move Tab to Pane Above', '⌥⇧⌘↑', () => Layout().moveActive('up')],
    ['Pane', 'Move Tab to Pane Below', '⌥⇧⌘↓', () => Layout().moveActive('down')],
    ['Pane', 'Toggle Pane Zoom', '⌥⌘↵', () => Layout().toggleZoom()],
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
    ['View', 'Toggle Workspaces Sidebar', '⌘B', () => useStore.getState().toggleSidebar()],
    [
      'View',
      'Move Workspaces Sidebar to Other Side',
      '',
      () => setSidebarSide(useStore.getState().sidebarSide === 'left' ? 'right' : 'left'),
    ],
    ['View', 'Toggle Secondary Sidebar (File Tree)', '⌥⌘B', () => toggleTree()],
    ['View', 'Show Files in Secondary Sidebar', '', () => showView('files')],
    ['View', 'Show Source Control in Secondary Sidebar', '^⇧G', () => showView('changes')],
    ['View', 'Find in Files', '⌥⌘F', () => openFindPalette()],
    ['View', 'Show Find in Secondary Sidebar', '', () => showFind()],
    ['View', 'Move Secondary Sidebar to Other Side', '', () => moveTreeSide()],
    ['View', 'Toggle Resource Manager', '', () => useStore.getState().toggleResources()],
    ['View', 'Toggle Rich Markdown', '⇧⌘M', () => Editor().toggleRich()],
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
