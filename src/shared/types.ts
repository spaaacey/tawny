/** Shapes the main process sends to the renderer (see `snapshot()` in src/main/main.js). */

/** A PR review session's PR, stored on its worktree (store.data.prSessions[path]). */
export interface PrInfo {
  host: string;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  url: string;
  title: string;
  state: 'open' | 'draft' | 'approved' | 'merged' | 'closed';
}

export type PrEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** An agent finding on a PR (from /code-review's ReportFindings, or the `propose_comment` MCP tool), kept per PR session. */
export interface PrFinding {
  id: string;
  source: 'review' | 'propose';
  path: string;
  /** end line (the only line for ReportFindings) */
  line: number;
  startLine?: number;
  side: 'LEFT' | 'RIGHT';
  /** one-line summary / the proposed comment body */
  body: string;
  /** ReportFindings' failure_scenario */
  detail?: string;
  suggestion?: string;
  category?: string;
  verdict?: string;
  /** PR head the finding was made against; differs from the snapshot's head => outdated */
  headSha: string;
  /** open: waiting; dismissed: hidden; accepted: Add to review was pressed (phase 5 syncs it to the pending review) */
  status: 'open' | 'dismissed' | 'accepted';
  createdAt: number;
}

export interface PrUser {
  login: string;
  avatarUrl?: string;
}
export interface PrComment {
  id: string;
  author: PrUser | null;
  body: string;
  createdAt: string;
  url?: string;
}
/** A comment inside a review thread (or a pending review). */
export interface PrReviewComment extends PrComment {
  path: string;
  line: number | null;
  /** commit the comment was written against (`originalCommit`), survives force-pushes */
  originalCommit?: string;
  /** id of the review it belongs to */
  reviewId?: string;
}
/** An inline review thread; phase 3 draws these in the diff, phase 5 replies/resolves. */
export interface PrThread {
  id: string;
  path: string;
  /** current line in the head (null when outdated and unmappable) */
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  side: 'LEFT' | 'RIGHT';
  isOutdated: boolean;
  isResolved: boolean;
  comments: PrReviewComment[];
}
export type PrReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
export interface PrReview {
  id: string;
  author: PrUser | null;
  state: PrReviewState;
  body: string;
  createdAt: string;
  /** review's inline comments (always filled for the viewer's pending review) */
  comments: PrReviewComment[];
}
export type PrTimelineItem =
  | ({ kind: 'comment' } & PrComment)
  | ({ kind: 'review'; state: PrReviewState; threadCount: number } & PrComment);
/** Latest fetched state of a PR (GraphQL), persisted so the PR tab opens instantly. */
export interface PrSnapshot {
  fetchedAt: number;
  /** GraphQL node id of the PR (needed to start a pending review) */
  prId?: string;
  title: string;
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  reviewDecision: string | null;
  author: PrUser | null;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  createdAt: string;
  body: string;
  viewer: string;
  timeline: PrTimelineItem[];
  threads: PrThread[];
  /** the viewer's PENDING review on this PR, if any (phase 5 adopts it) */
  pendingReview: PrReview | null;
  /** set by Refresh when the PR head moved and the worktree was updated; kept until dismissed */
  moved?: PrMoved;
  /** Refresh could not update the worktree to the new head (e.g. uncommitted changes) */
  syncWarn?: string;
}

/** The PR head moved since the reviewer last looked: the worktree was fast-forwarded (or reset after a force-push). */
export interface PrMoved {
  /** worktree HEAD before the first unseen update, and now */
  from: string;
  to: string;
  /** commits in from..to (reachable from the new head only) */
  count: number;
  /** the old head was not an ancestor of the new one (force-push) */
  forced: boolean;
  /** files changed between `from` and `to` */
  files: { path: string; status: string; orig?: string }[];
  /** files changed by the latest update only (their "viewed" mark is cleared) */
  latest: string[];
}

export type PrVerdict = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/** A change to the viewer's GitHub pending review (drafts) or to a thread (resolve), applied by main through GraphQL. */
export type PrReviewAction =
  | {
      kind: 'thread';
      path: string;
      line: number;
      startLine?: number;
      side: 'LEFT' | 'RIGHT';
      body: string;
      /** replacement for the selected lines, posted as a ```suggestion block (RIGHT side only) */
      suggestion?: string;
    }
  | { kind: 'reply'; threadId: string; body: string }
  | { kind: 'edit'; commentId: string; body: string }
  | { kind: 'delete'; commentId: string }
  | { kind: 'resolve'; threadId: string; resolved: boolean };

export interface PrCommit {
  sha: string;
  short: string;
  subject: string;
  author: string;
}

/** Files a PR changes against its merge-base (what the "PR files" view lists). */
export interface PrFiles {
  /** merge-base commit the diffs start from */
  base: string;
  files: { path: string; status: string; orig?: string }[];
}

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
  /** set when this worktree is a PR review session */
  pr?: PrInfo;
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
  editorFontWeight: string;
  editorFontLigatures: boolean;
  uiFontSize: number;
  uiFontFamily: string;
  chatFontSize: number;
  chatFontFamily: string;
  richFontSize: number;
  richFontFamily: string;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalFontWeight: string;
  terminalFontLigatures: boolean;
  smoothScrolling: boolean;
  stickyScrollMaxLines: number;
  highlightActiveBlock: boolean;
  formatOnSave: 'none' | 'document' | 'changes';
  blameInline: boolean;
  blameInlineFormat: string;
  worktreeRoot: string;
  scratchRoot: string;
  copyOnCreate: string[];
  'prReview.instructions': string;
  'prReview.effort': PrEffort;
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
  treeView?: 'files' | 'changes' | 'find' | 'asks' | 'pr';
  treeHidden?: boolean;
  dbgHeight?: string;
  dbgDock?: 'side' | 'bottom';
  zoom?: number;
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
