/** Shapes the main process sends to the renderer (see `snapshot()` in src/main/main.js). */

export interface Worktree {
  path: string;
  head: string;
  branch: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  main: boolean;
  repo: string;
  prefix: string;
  /** uncommitted file count, -1 when unknown */
  dirty: number;
}

export interface Repo {
  path: string;
  name: string;
  worktrees: Worktree[];
  error?: string;
}

/** A folder (or scratch dir) with no repo behind it. */
export interface PlainWorkspace {
  path: string;
  name: string;
  scratch: boolean;
  plain: true;
  prefix: string;
  missing: boolean;
}

export type SessionKind = 'agent' | 'terminal' | 'chat';

export interface Session {
  id: string;
  prefix: string;
  index: number;
  name: string | null;
  title: string | null;
  proc: string | null;
  summary: string | null;
  working: boolean;
  waiting: boolean;
  kind: SessionKind;
}

export interface LspInfo {
  root: string;
  kind: string;
  state: string;
  error?: string;
  name: string;
  installable?: boolean;
  progress?: string;
}

export interface Settings {
  agentCommand: string;
  resumeCommand: string;
  codeCommand: string;
  rubyLspCommand: string;
  theme: 'system' | 'latte' | 'mocha';
  editorFontSize: number;
  editorFontFamily: string;
  uiFontSize: number;
  uiFontFamily: string;
  chatFontSize: number;
  chatFontFamily: string;
  smoothScrolling: boolean;
  stickyScrollMaxLines: number;
  highlightActiveBlock: boolean;
  blameInline: boolean;
  blameGutter: boolean;
  blameInlineFormat: string;
  blameGutterFormat: string;
  worktreeRoot: string;
  scratchRoot: string;
  copyOnCreate: string[];
  notifyWhenAgentFinishes: boolean;
  chatAgent: string;
  acpAgents: Record<string, unknown>;
  keybindings: Record<string, string>;
}

export interface UiState {
  sidebarSide?: 'left' | 'right';
  sidebarWidth?: string;
  treeSide?: 'left' | 'right';
  treeWidth?: string;
  treeView?: 'files' | 'changes' | 'find' | 'asks';
  treeHidden?: boolean;
  zoom?: number;
  dbgHeight?: string;
  expanded?: Record<string, string[]>;
  [key: string]: unknown;
}

export interface AppState {
  repos: Repo[];
  workspaces: PlainWorkspace[];
  active: string | null;
  sessions: Session[];
  agentError: string | null;
  lsp: LspInfo[];
  settings: Settings;
  platform: string;
  ui: UiState;
}

/** Any workspace row in the sidebar: a worktree (with its repo's name) or a plain workspace. */
export type AnyWorkspace =
  | (Worktree & { repoName: string; plain?: false; scratch?: false; name?: undefined; missing?: boolean })
  | (PlainWorkspace & {
      repoName: string;
      main?: false;
      branch?: undefined;
      detached?: undefined;
      head?: undefined;
      prunable?: undefined;
      repo?: undefined;
    });

export interface ResourceUsage {
  rss: number;
  cpu: number;
}

export interface ResourceRow extends ResourceUsage {
  id: string;
  /** set for language servers: their display name */
  lsp?: string;
}

export interface ResourceWorkspace extends ResourceUsage {
  prefix: string;
  /** recent cpu% samples, oldest first */
  history: number[];
  sessions: ResourceRow[];
}

export interface ResourceSample extends ResourceUsage {
  app: ResourceUsage;
  workspaces: ResourceWorkspace[];
}

export interface ListeningPort {
  pid: number;
  port: number;
  command: string;
  addr: string;
}

export interface PortsSnapshot {
  workspaces: { prefix: string; ports: ListeningPort[] }[];
  external: ListeningPort[];
}
