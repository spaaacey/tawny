import type { Chat, ChatStatus } from '../main/acp';
import type { configs, Dap } from '../main/dap';
import type * as F from '../main/files';
import type { Lsp } from '../main/lsp';
import type { Edit, Match, SearchOpts } from '../main/search';
import type { FormAnswer } from './chat-model';
import type {
  AppState,
  LocalReviewFiles,
  LocalReviewState,
  LrItemEdit,
  LrNewItem,
  LrStarted,
  PortsSnapshot,
  PrCommit,
  PrEdit,
  PrFiles,
  PrFinding,
  PrInfo,
  PrReviewAction,
  PrSnapshot,
  PrVerdict,
  ResourceSample,
  ReviewItem,
} from './types';

type Unsub = () => void;
type Ret<T extends (...a: never[]) => unknown> = Awaited<ReturnType<T>>;
export type SearchResult =
  | { cancelled: true }
  | { files: { path: string; matches: Match[] }[]; total: number; truncated: boolean };
// Calls whose payloads the renderer does not model yet stay loose; tighten as each area is ported.
// biome-ignore lint/suspicious/noExplicitAny: legacy payloads
type Loose = any;

export type LspOpenResult = Ret<Lsp['open']>;
export type DapStartResult = ReturnType<Dap['start']>;
export type DapBreakpoint = Parameters<Dap['setBreakpoints']>[2][number];
export type DapBreakpoints = Parameters<Dap['start']>[3];
export type DapConfig = Parameters<Dap['start']>[1];
export type DapEvent = { sid?: number; cid: number; event: string; body: Loose };
export type ChatHistory = ReturnType<Chat['history']>;
export type ChatSession = { sessionId: string; title: string | null; updatedAt: string | null };
export type ChatUpdate = { seq: number; sessionId?: string; update: Loose };
export type ChatPermissionRequest = { reqId: number; toolCall: Loose; options: Loose };
export type ChatStatusEvent = { status: ChatStatus; error: string | null; auth: ReturnType<Chat['authList']> };
export type ChatReadFileRequest = { reqId: number; path: string };
export type LspDiagnostics = { uri: string; diagnostics: Loose[] };

export interface NewWorktreeOpts {
  repo: string;
  branch: string;
  base: string;
  startAgent: boolean;
}

export interface MenuItemRun {
  label?: string;
  type?: string;
}

/** The `window.tawny` bridge, implemented in src/preload/index.ts. */
export interface TawnyApi {
  platform: string;
  dev: boolean;
  devPort: string;
  state(): Promise<AppState>;
  pathFor(file: File): string;
  // workspaces
  addRepo(dir?: string): Promise<string>;
  addFolder(dir?: string): Promise<string>;
  addScratch(): Promise<string>;
  removeWorkspace(path: string): Promise<void>;
  renameWorkspace(path: string, name: string): Promise<void>;
  addMenu(): Promise<void>;
  removeRepo(repo: string): Promise<void>;
  currentBranch(repo: string): Promise<string>;
  createWorktree(opts: NewWorktreeOpts): Promise<string>;
  /** The agent instructions template the PR dialog starts with (last edit, else the default). */
  prInstructions(): Promise<string>;
  /** Create (or find) the review worktree for a PR URL or #N. Doesn't activate it. */
  openPr(ref: string, instructions?: string): Promise<{ path: string; pr: PrInfo; created: boolean }>;
  /** Last fetched snapshot of the PR reviewed in worktree `path` (fetches when none is stored). */
  prFetch(path: string): Promise<PrSnapshot>;
  prFiles(path: string): Promise<PrFiles>;
  prCommits(path: string): Promise<PrCommit[]>;
  prFindings(path: string): Promise<PrFinding[]>;
  prFindingStatus(path: string, id: string, status: PrFinding['status']): Promise<void>;
  /** Draft a finding into the GitHub pending review (optionally with an edited body / suggestion). Returns the refreshed snapshot. */
  prFindingAdd(path: string, id: string, edit?: { body?: string; suggestion?: string }): Promise<PrSnapshot>;
  /** Draft / reply / edit / delete in the pending review, or resolve a thread. Returns the refreshed snapshot. */
  prReview(path: string, action: PrReviewAction): Promise<PrSnapshot>;
  /** Post a conversation comment on the PR right away. Returns the refreshed snapshot. */
  prComment(path: string, body: string): Promise<PrSnapshot>;
  /** Submit the pending review (every draft stays its own inline comment) with a verdict and optional summary. Returns the refreshed snapshot. */
  prSubmit(path: string, verdict: PrVerdict, body: string): Promise<PrSnapshot>;
  // local review of worktree `path`'s own branch (docs/local-review-plan.md); onLrChanged fires when its items / base / runs change
  /** Base, merge-base, items (remapped to the current files) and runs. */
  lrState(path: string): Promise<LocalReviewState>;
  /** Branch or commit to diff against; '' resets to the default (main, else the repo's default branch). Returns the new state. */
  lrSetBase(path: string, ref: string): Promise<LocalReviewState>;
  /** merge-base..working tree name-status plus untracked files ('?'). */
  lrFiles(path: string): Promise<LocalReviewFiles>;
  /** The user's own comment (source 'user', RIGHT side). Throws if an open item with the same text is on that line. */
  lrAddItem(path: string, item: LrNewItem): Promise<ReviewItem>;
  lrEditItem(path: string, id: string, edit: LrItemEdit): Promise<ReviewItem>;
  /** Reopen ('open'), dismiss, or set any status. */
  lrSetStatus(path: string, id: string, status: ReviewItem['status']): Promise<ReviewItem>;
  /** After "Send to agent" inserted the prompt (buildFixPrompt, src/shared/local-review.ts): open items -> sent. */
  lrMarkSent(path: string, ids: string[]): Promise<void>;
  /** Drop fixed and dismissed items. */
  lrClearResolved(path: string): Promise<void>;
  /** Create a review chat, then send it `/code-review <effort> <base> <instructions>` once ready. Reveal the returned chat. */
  lrStartReview(path: string, opts: { effort?: string; instructions?: string }): Promise<LrStarted>;
  /** Edit title / description / base branch of a PR you authored. Returns the refreshed snapshot. */
  prEdit(path: string, edit: PrEdit): Promise<PrSnapshot>;
  /** Hide the "N new commits" banner. */
  prDismissMoved(path: string): Promise<PrSnapshot>;
  /** A `tawny` CLI call that needs UI state (src/main/cli/bridge.ts); answer with cliReply */
  onCliRequest(fn: (req: { id: number; method: string; params: unknown }) => void): Unsub;
  cliReply(r: { id: number; result?: unknown; error?: string }): void;
  onPrFindings(fn: (path: string) => void): Unsub;
  /** worktree `path`'s local review changed: refetch lrState */
  onLrChanged(fn: (path: string) => void): Unsub;
  /** Re-fetch from GitHub, store it, update the sidebar badge. */
  prRefresh(path: string): Promise<PrSnapshot>;
  deleteWorktree(opts: { path: string; force?: boolean }): Promise<void>;
  activate(path: string): Promise<void>;
  openDesktop(path?: string): Promise<void>;
  // files
  list(dir: string): Promise<Ret<typeof F.list>>;
  read(file: string): Promise<Ret<typeof F.read>>;
  resolveFile(cwd: string, p: string): Promise<string | null>;
  write(file: string, text: string): Promise<number>;
  create(file: string, kind: 'file' | 'dir'): Promise<void>;
  permalink(path: string, lines?: string): Promise<string | null>;
  renameFile(from: string, to: string): Promise<void>;
  trashFile(path: string): Promise<void>;
  pasteFiles(dir: string): Promise<string[]>;
  copyFiles(paths: string[]): Promise<void>;
  fileIndex(root: string): Promise<string[]>;
  search(root: string, opts: SearchOpts, id: number): Promise<SearchResult>;
  replaceInFile(file: string, opts: SearchOpts, repl: string, positions?: [number, number][]): Promise<Edit[]>;
  replaceEdits(text: string, opts: SearchOpts, repl: string, positions?: [number, number][]): Promise<Edit[]>;
  applyEditsToDisk(file: string, edits: Loose): Promise<Loose>;
  gitIsRepo(root: string): Promise<boolean>;
  gitStatus(root: string): Promise<Ret<typeof F.gitStatus>>;
  gitChanges(root: string): Promise<Ret<typeof F.gitChanges>>;
  gitAheadBehind(root: string): Promise<Ret<typeof F.gitAheadBehind>>;
  gitDiffStat(root: string): Promise<Ret<typeof F.gitDiffStat>>;
  gitCommit(root: string, message: string): Promise<Loose>;
  gitUndoCommit(root: string): Promise<string>;
  gitStage(root: string, paths: string[]): Promise<Loose>;
  gitUnstage(root: string, paths: string[]): Promise<Loose>;
  gitDiscard(root: string, paths: string[]): Promise<Loose>;
  gitLog(root: string): Promise<Ret<typeof F.gitLog>>;
  gitCommitFiles(root: string, sha: string): Promise<Ret<typeof F.gitCommitFiles>>;
  gitShow(root: string, rel: string, ref: string): Promise<Ret<typeof F.gitShow>>;
  gitBlame(root: string, rel: string, text: string): Promise<Ret<typeof F.gitBlame>>;
  gitCommitMessage(root: string, sha: string): Promise<string>;
  gitCommitPr(root: string, sha: string): Promise<Ret<typeof F.gitCommitPr>>;
  gitBranches(root: string): Promise<Ret<typeof F.gitBranches>>;
  gitSwitch(root: string, branch: string, stash: boolean): Promise<boolean>;
  reveal(path: string): Promise<void>;
  // language servers
  lspOpen(root: string, file: string, text: string): Promise<LspOpenResult>;
  lspRequest(root: string, kind: string, method: string, params: unknown): Promise<Loose>;
  lspFormat(
    root: string,
    file: string,
    text: string,
    changesOnly: boolean,
    options: unknown,
  ): Promise<Ret<Lsp['format']>>;
  lspRestart(root: string, kind: string): Promise<void>;
  lspStop(root: string, kind: string): Promise<void>;
  lspInstallRuby(root: string): Promise<void>;
  lspChange(root: string, kind: string, uri: string, version: number, changes: unknown): void;
  lspSave(root: string, kind: string, uri: string, text: string): void;
  lspClose(root: string, kind: string, uri: string): void;
  // debugger
  dapConfigs(root: string, file?: string): Promise<Ret<typeof configs>>;
  dapStart(
    root: string,
    config: DapConfig,
    ctx: { file?: string } | undefined,
    breakpoints?: DapBreakpoints,
  ): Promise<DapStartResult>;
  dapRequest(sid: number, cid: number, command: string, args?: unknown): Promise<Loose>;
  dapBreakpoints(sid: number, file: string, list: DapBreakpoint[]): Promise<Ret<Dap['setBreakpoints']>>;
  dapStop(sid: number): Promise<void>;
  // agents
  createAgent(
    path: string,
    kind?: string,
    opts?: { agent?: string; sessionId?: string; title?: string },
  ): Promise<string>;
  killAgent(id: string): Promise<void>;
  renameAgent(id: string, title: string): Promise<void>;
  agentBuffer(id: string): Promise<string>;
  writeAgent(id: string, data: string): void;
  resizeAgent(id: string, cols: number, rows: number): void;
  /** the agent tab in front (null: none), so main can tell finished-but-unread from finished-in-view */
  setFocusedAgent(id: string | null): void;
  // chat tabs (ACP)
  chatSaveTemp(name: string, bytes: Uint8Array): Promise<string>;
  chatPrompt(id: string, blocks: Loose[]): Promise<string>;
  chatClear(id: string): Promise<void>;
  chatCancel(id: string): Promise<void>;
  chatAnswer(id: string, reqId: number, answer: string | FormAnswer | null): Promise<void>;
  chatSetConfig(id: string, configId: string, value: unknown): Promise<void>;
  chatHistory(id: string): Promise<ChatHistory>;
  chatReconnect(id: string): Promise<void>;
  chatAuth(id: string, methodId?: string): Promise<string | null>;
  chatSessions(path: string): Promise<ChatSession[]>;
  chatFileReply(id: string, reqId: number, text: string | null): void;
  // misc
  openSettings(): Promise<void>;
  saveUi(ui: Record<string, unknown>): Promise<void>;
  runMenu(id: string): Promise<void>;
  refresh(): Promise<void>;
  resources(): Promise<ResourceSample>;
  ports(): Promise<PortsSnapshot>;
  killPort(pid: number, port: number): Promise<void>;
  // events
  onState(fn: (s: AppState) => void): Unsub;
  onAgentData(fn: (id: string, data: string) => void): Unsub;
  onAgentExit(fn: (id: string) => void): Unsub;
  onChatUpdate(fn: (id: string, e: ChatUpdate) => void): Unsub;
  onChatPermission(fn: (id: string, req: ChatPermissionRequest) => void): Unsub;
  onChatPermissionDone(fn: (id: string, reqId: number) => void): Unsub;
  onChatStatus(fn: (id: string, st: ChatStatusEvent) => void): Unsub;
  onChatReadFile(fn: (id: string, req: ChatReadFileRequest) => void): Unsub;
  onMenu(fn: (cmd: string, arg?: number | string) => void): Unsub;
  onDiagnostics(fn: (root: string, p: LspDiagnostics) => void): Unsub;
  onApplyEdit(fn: (root: string, edit: Loose) => void): Unsub;
  onDapEvent(fn: (e: DapEvent) => void): Unsub;
  onLspRestarted(fn: (root: string, kind: string) => void): Unsub;
  onFsChanged(fn: (root: string, paths: string[], gitChanged: boolean) => void): Unsub;
  onToast(fn: (msg: string) => void): Unsub;
  onResources(fn: (r: ResourceSample) => void): Unsub;
  onPorts(fn: (p: PortsSnapshot) => void): Unsub;
}
