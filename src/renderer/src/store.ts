import { create } from 'zustand';
import type { AppState } from '../../shared/types';
import { showToast } from './components/Toasts';

export type Popover = 'resources' | 'ports' | null;

export type Overlay = 'worktree' | 'quick' | 'palette' | null;

export const EMPTY_STATE: AppState = {
  repos: [],
  workspaces: [],
  active: null,
  sessions: [],
  agentError: null,
  lsp: [],
  settings: {} as AppState['settings'],
  tmux: false,
  platform: '',
  ui: {},
};

interface Store {
  app: AppState;
  ready: boolean;
  /** the classic scripts (Monaco loader, ...) are loaded and the bridge is up */
  booted: boolean;
  setBooted(): void;
  setApp(app: AppState): void;
  /** repo paths folded shut in the sidebar */
  collapsed: Set<string>;
  toggleCollapsed(repo: string): void;
  sidebarSide: 'left' | 'right';
  sidebarHidden: boolean;
  setSidebarSide(side: 'left' | 'right'): void;
  toggleSidebar(): void;
  /** session id of the focused pane's tab (highlighted in the sidebar) */
  focusedSession: string | null;
  setFocusedSession(id: string | null): void;
  /** status bar popover (Resource Manager / Ports) */
  popover: Popover;
  setPopover(p: Popover): void;
  toggleResources(): void;
  overlay: Overlay;
  /** where focus goes back to when the overlay closes */
  restoreFocus: HTMLElement | null;
  openOverlay(o: Exclude<Overlay, null>): void;
  closeOverlay(restore?: boolean): void;
  pushToast(msg: string, ms?: number): void;
  /** repo the New worktree dialog opens on */
  worktreeRepo: string | null;
  setWorktreeRepo(repo: string | null): void;
  /** initial text of the palette (prefix picks the mode) */
  paletteInitial: string;
  setPaletteInitial(s: string): void;
}

export const useStore = create<Store>((set, get) => ({
  app: EMPTY_STATE,
  ready: false,
  booted: false,
  setBooted: () => set({ booted: true }),
  setApp: (app) => set({ app, ready: true }),
  collapsed: new Set(),
  toggleCollapsed: (repo) =>
    set((s) => {
      const collapsed = new Set(s.collapsed);
      if (!collapsed.delete(repo)) collapsed.add(repo);
      return { collapsed };
    }),
  sidebarSide: 'left',
  sidebarHidden: false,
  setSidebarSide: (sidebarSide) => set({ sidebarSide }),
  toggleSidebar: () => set((s) => ({ sidebarHidden: !s.sidebarHidden })),
  focusedSession: null,
  setFocusedSession: (focusedSession) => set({ focusedSession }),
  popover: null,
  setPopover: (popover) => set({ popover }),
  toggleResources: () => set((s) => ({ popover: s.popover === 'resources' ? null : 'resources' })),
  overlay: null,
  restoreFocus: null,
  openOverlay: (overlay) => {
    const active = document.activeElement;
    set({ overlay, restoreFocus: active instanceof HTMLElement ? active : null });
  },
  closeOverlay: (restore = true) => {
    const { restoreFocus } = get();
    set({ overlay: null, restoreFocus: null });
    if (restore && restoreFocus?.isConnected) restoreFocus.focus();
  },
  pushToast: (msg, ms = 4000) => showToast(msg, ms),
  worktreeRepo: null,
  setWorktreeRepo: (worktreeRepo) => set({ worktreeRepo }),
  paletteInitial: '>',
  setPaletteInitial: (paletteInitial) => set({ paletteInitial }),
}));

export const getApp = () => useStore.getState().app;
