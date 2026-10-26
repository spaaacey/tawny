import type * as F from '../main/files';
import type { Edit, Match, SearchOpts } from '../main/search';
import type { AppState, PortsSnapshot, ResourceSample } from './types';

type Unsub = () => void;
type Ret<T extends (...a: never[]) => unknown> = Awaited<ReturnType<T>>;
export type SearchResult =
  | { cancelled: true }
  | { files: { path: string; matches: Match[] }[]; total: number; truncated: boolean };
// Calls whose payloads the renderer does not model yet stay loose; tighten as each area is ported.
// biome-ignore lint/suspicious/noExplicitAny: legacy payloads
type Loose = any;

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

/** The `window.harbor` bridge, implemented in src/preload/index.ts. */
export interface HarborApi {
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
  deleteWorktree(opts: { path: string; force?: boolean }): Promise<void>;
  activate(path: string): Promise<void>;
  openDesktop(path?: string): Promise<void>;
  // files
  list(dir: string): Promise<Ret<typeof F.list>>;
  read(file: string): Promise<Ret<typeof F.read>>;
  resolveFile(cwd: string, p: string): Promise<string | null>;
  write(file: string, text: string): Promise<number>;
  fileIndex(root: string): Promise<string[]>;
  search(root: string, opts: SearchOpts, id: number): Promise<SearchResult>;
  replaceInFile(file: string, opts: SearchOpts, repl: string, positions?: [number, number][]): Promise<Edit[]>;
  replaceEdits(text: string, opts: SearchOpts, repl: string, positions?: [number, number][]): Promise<Edit[]>;
  applyEditsToDisk(file: string, edits: Loose): Promise<Loose>;
  gitIsRepo(root: string): Promise<boolean>;
  gitStatus(root: string): Promise<Ret<typeof F.gitStatus>>;
  gitChanges(root: string): Promise<Ret<typeof F.gitChanges>>;
  gitDiffStat(root: string): Promise<Ret<typeof F.gitDiffStat>>;
  gitCommit(root: string, message: string): Promise<Loose>;
  gitStage(root: string, paths: string[]): Promise<Loose>;
  gitUnstage(root: string, paths: string[]): Promise<Loose>;
  gitDiscard(root: string, paths: string[]): Promise<Loose>;
  gitLog(root: string): Promise<Ret<typeof F.gitLog>>;
  gitCommitFiles(root: string, sha: string): Promise<Ret<typeof F.gitCommitFiles>>;
  gitShow(root: string, rel: string, ref: string): Promise<Ret<typeof F.gitShow>>;
  reveal(path: string): Promise<void>;
  // language servers
  lspOpen(root: string, file: string, text: string): Promise<Loose>;
  lspRequest(root: string, kind: string, method: string, params: unknown): Promise<Loose>;
  lspRestart(root: string, kind: string): Promise<void>;
  lspInstallRuby(root: string): Promise<void>;
  lspChange(root: string, kind: string, uri: string, version: number, changes: unknown): void;
  lspSave(root: string, kind: string, uri: string, text: string): void;
  lspClose(root: string, kind: string, uri: string): void;
  // debugger
  dapConfigs(root: string, file?: string): Promise<Loose>;
  dapStart(root: string, config: unknown, ctx: unknown, breakpoints: unknown): Promise<Loose>;
  dapRequest(sid: string, cid: number, command: string, args: unknown): Promise<Loose>;
  dapBreakpoints(sid: string, file: string, list: unknown): Promise<Loose>;
  dapStop(sid: string): Promise<void>;
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
  // chat tabs (ACP)
  chatPrompt(id: string, blocks: unknown): Promise<Loose>;
  chatClear(id: string): Promise<void>;
  chatCancel(id: string): Promise<void>;
  chatAnswer(id: string, reqId: string, optionId: string): Promise<void>;
  chatSetConfig(id: string, configId: string, value: unknown): Promise<Loose>;
  chatHistory(id: string): Promise<Loose>;
  chatReconnect(id: string): Promise<Loose>;
  chatAuth(id: string, methodId?: string): Promise<string | undefined>;
  chatToTerminal(id: string): Promise<string>;
  chatSessions(path: string): Promise<Loose>;
  chatFileReply(id: string, reqId: string, text: string | null): void;
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
  onChatUpdate(fn: (...a: Loose[]) => void): Unsub;
  onChatPermission(fn: (...a: Loose[]) => void): Unsub;
  onChatPermissionDone(fn: (...a: Loose[]) => void): Unsub;
  onChatStatus(fn: (...a: Loose[]) => void): Unsub;
  onChatReadFile(fn: (...a: Loose[]) => void): Unsub;
  onMenu(fn: (cmd: string, arg?: Loose) => void): Unsub;
  onDiagnostics(fn: (...a: Loose[]) => void): Unsub;
  onApplyEdit(fn: (...a: Loose[]) => void): Unsub;
  onDapEvent(fn: (...a: Loose[]) => void): Unsub;
  onLspRestarted(fn: (...a: Loose[]) => void): Unsub;
  onFsChanged(fn: (...a: Loose[]) => void): Unsub;
  onToast(fn: (msg: string) => void): Unsub;
  onResources(fn: (r: ResourceSample) => void): Unsub;
  onPorts(fn: (p: PortsSnapshot) => void): Unsub;
}
