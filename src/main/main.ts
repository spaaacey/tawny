import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeTheme,
  shell,
} from 'electron';
import { loadShellEnv } from './shellenv';
import type { Any, TextEdit } from './types';

loadShellEnv();

import { Agents } from './agents';
import { Dap } from './dap';
import { findCode } from './desktop';
import * as F from './files';
import * as G from './git';
import { Lsp } from './lsp';
import { resolveUserData } from './migrate';
import { Resources } from './resources';
import * as S from './search';
import { Store } from './store';

const IS_DEV = !!process.env.TAWNY_DEV;
const LOGO = path.join(__dirname, '..', '..', 'assets', 'logo.png');
const DEV_LOGO = IS_DEV
  ? require('./devicon').devIcon(path.join(__dirname, '..', '..', 'assets', 'logo-512.png'), process.env.TAWNY_DEV_PORT)
  : null;
const DEV_BANNER_H = 18; // keep in sync with --dev-banner-h in style.css

app.setName(process.env.TAWNY_USER_DATA ? 'Tawny Dev' : 'Tawny');
if (process.env.TAWNY_USER_DATA) app.setPath('userData', process.env.TAWNY_USER_DATA);
else app.setPath('userData', resolveUserData(app.getPath('appData'))); // Tawny; migrates a legacy Harbor dir

// node-pty's macOS helper ships without the executable bit in some installs, which makes every
// agent fail with "posix_spawnp failed". Fix it up before spawning anything.
function fixPtyHelper() {
  try {
    const base = path.dirname(require.resolve('node-pty/package.json')).replace('app.asar', 'app.asar.unpacked');
    for (const dir of ['prebuilds', 'build/Release']) {
      const root = path.join(base, dir);
      if (!fs.existsSync(root)) continue;
      for (const sub of [root, ...fs.readdirSync(root).map((n) => path.join(root, n))]) {
        const helper = path.join(sub, 'spawn-helper');
        if (fs.existsSync(helper)) {
          try {
            fs.chmodSync(helper, 0o755);
          } catch {
            /* read-only bundle */
          }
        }
      }
    }
  } catch {
    /* not installed */
  }
}
fixPtyHelper();

interface Worktree extends G.RepoWorktree {
  prefix: string;
  dirty: number;
}
interface PlainWorkspace {
  path: string;
  name: string;
  scratch: boolean;
  plain: true;
  prefix: string;
  missing: boolean;
}
interface RepoEntry {
  path: string;
  name: string;
  worktrees: Worktree[];
  error?: string;
}
type Workspace = PlainWorkspace | Worktree;

let win: BrowserWindow | null = null;
let focusedAgent: string | null = null; // agent tab in front, reported by the renderer
let store: Store, agents: Agents, lsp: Lsp, dap: Dap, watcher: F.Watcher, resources: Resources;
const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
const model: { repos: RepoEntry[]; workspaces: PlainWorkspace[] } = { repos: [], workspaces: [] };
const send = (ch: string, ...a: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, ...a);
};

// ------------------------------------------------------------------ workspaces

async function refreshWorktrees() {
  const repos: RepoEntry[] = [];
  for (const repo of store.data.repos) {
    try {
      const wts: Worktree[] = await Promise.all(
        (await G.listWorktrees(repo)).map(async (w) => {
          const p = norm(w.path);
          return { ...w, path: p, prefix: G.sessionPrefix(p), dirty: w.prunable ? -1 : await G.dirtyCount(p) };
        }),
      );
      repos.push({ path: repo, name: path.basename(repo), worktrees: wts });
    } catch (e) {
      repos.push({ path: repo, name: path.basename(repo), worktrees: [], error: e.message });
    }
  }
  model.repos = repos;
  // plain workspaces: a folder (or scratch dir) with no repo behind it
  model.workspaces = (store.data.workspaces || []).map((w) => ({
    path: w.path,
    name: w.name,
    scratch: !!w.scratch,
    plain: true,
    prefix: G.sessionPrefix(w.path),
    missing: !fs.existsSync(w.path),
  }));
  const alive = new Set(allWorkspaces().map((w) => w.path));
  if (store.data.active && !alive.has(store.data.active) && alive.size) store.set('active', null);
  pushState();
}

const allWorktrees = () => model.repos.flatMap((r) => r.worktrees);
const allWorkspaces = (): Workspace[] => [...model.workspaces, ...allWorktrees()];
const findWorktree = (p: string) => allWorktrees().find((w) => w.path === norm(p));
const findWorkspace = (p: string) => allWorkspaces().find((w) => w.path === norm(p));

function snapshot() {
  return {
    repos: model.repos,
    workspaces: model.workspaces,
    active: store.data.active,
    sessions: agents.list(),
    agentError: agents.lastError || null,
    lsp: lsp.status(),
    settings: store.settings,
    tmux: agents.tmux,
    platform: process.platform,
    ui: store.data.ui || {},
  };
}

let pushTimer: NodeJS.Timeout | undefined;
function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    send('state', snapshot());
    updateBadge();
  }, 30);
}

function updateBadge() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const n = agents.list().filter((s) => s.working).length;
  app.dock.setBadge(n ? String(n) : '');
}

async function addRepo(dir: string) {
  const root = norm(await G.repoRootFor(dir));
  if (!store.data.repos.includes(root)) store.set('repos', [...store.data.repos, root]);
  await refreshWorktrees();
  return root;
}

async function addFolder(dir: string) {
  dir = norm(dir);
  if (!store.data.workspaces) store.data.workspaces = [];
  if (!store.data.workspaces.some((w) => w.path === dir))
    store.set('workspaces', [...store.data.workspaces, { path: dir, name: path.basename(dir) }]);
  await refreshWorktrees();
  return dir;
}

/** A scratch workspace: a named folder under settings.scratchRoot (default: Tawny's data dir) for terminals and notes that belong to no repo. */
async function addScratch() {
  const taken = new Set((store.data.workspaces || []).filter((w) => w.scratch).map((w) => w.name));
  let name = 'Scratch',
    i = 2;
  while (taken.has(name)) name = `Scratch ${i++}`;
  const root =
    (store.settings.scratchRoot || '').trim().replace(/^~(?=$|\/)/, os.homedir()) ||
    path.join(app.getPath('userData'), 'scratch');
  const dir = norm(path.join(path.resolve(root), G.slug(name)));
  fs.mkdirSync(dir, { recursive: true });
  store.set('workspaces', [...(store.data.workspaces || []), { path: dir, name, scratch: true }]);
  await refreshWorktrees();
  return dir;
}

/** Rename a plain workspace; empty resets to the folder name. The path (and so its tabs) is unchanged. */
async function renameWorkspace(p: string, name?: string) {
  const dir = norm(p);
  if (!(store.data.workspaces || []).some((w) => w.path === dir)) throw new Error('Unknown workspace');
  name =
    String(name || '')
      .trim()
      .slice(0, 60) || path.basename(dir);
  store.set(
    'workspaces',
    (store.data.workspaces ?? []).map((w) => (w.path === dir ? { ...w, name } : w)),
  );
  await refreshWorktrees();
}

async function removeWorkspace(p: string) {
  const w = model.workspaces.find((x) => x.path === norm(p));
  if (!w) throw new Error('Unknown workspace');
  await agents.killPrefix(w.prefix);
  agents.forget(w.prefix);
  lsp.stopRoot(w.path);
  dap.stopRoot(w.path);
  watcher.unwatch(w.path);
  store.set(
    'workspaces',
    (store.data.workspaces ?? []).filter((x) => x.path !== w.path),
  );
  if (w.scratch) {
    try {
      fs.rmdirSync(w.path);
    } catch {
      /* has files: keep them */
    }
  }
  if (store.data.active === w.path) store.set('active', null);
  await refreshWorktrees();
  const next = allWorkspaces()[0];
  if (!store.data.active && next) activate(next.path);
}

function activate(p: string) {
  p = norm(p);
  store.set('active', p);
  watcher.keepOnly([p]);
  watcher.watch(p);
  pushState();
  return p;
}

// ------------------------------------------------------------------ menu

const menu = (cmd: string, arg?: unknown) => send('menu', cmd, arg);

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: 'Tawny',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => openSettings() },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+N', click: () => menu('newTab') },
        { label: 'New Tab in Split Pane', accelerator: 'CmdOrCtrl+T', click: () => menu('newSplitTab') },
        { label: 'New Terminal in Pane Below', accelerator: 'CmdOrCtrl+J', click: () => menu('newSplitTerminal') },
        { type: 'separator' },
        { label: 'Go to File…', accelerator: 'CmdOrCtrl+P', click: () => menu('goToFile') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => menu('save') },
        { label: 'Revert File', accelerator: 'CmdOrCtrl+Alt+R', click: () => menu('revert') },
        { label: 'Open File from Diff', accelerator: 'CmdOrCtrl+Alt+D', click: () => menu('openDiffFile') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => menu('closeTab') },
        { type: 'separator' },
        { label: 'New Scratch Workspace', click: () => menu('newScratch') },
        { label: 'Open Folder as Workspace…', click: () => menu('addFolder') },
        { label: 'Add Repository…', click: () => menu('addRepo') },
        { label: 'New Worktree…', accelerator: 'CmdOrCtrl+Alt+N', click: () => menu('newWorktree') },
        { type: 'separator' },
        {
          label: 'Open Worktree in VS Code',
          accelerator: 'CmdOrCtrl+Alt+O',
          click: () => openInDesktop(store.data.active),
        },
        { label: 'Reveal Worktree in Finder', click: () => store.data.active && shell.openPath(store.data.active) },
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              { label: 'Settings…', click: () => openSettings() },
              { role: 'quit' },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    // Clipboard via roles; undo/redo/select-all are handled by the editor/terminal themselves.
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    {
      label: 'Go',
      submenu: [
        { label: 'Switch Worktree…', accelerator: 'CmdOrCtrl+Alt+Shift+P', click: () => menu('quickSwitch') },
        { label: 'Switch Session…', accelerator: 'CmdOrCtrl+Alt+P', click: () => menu('quickSessions') },
        { label: 'Previous Worktree', accelerator: 'CmdOrCtrl+Alt+Up', click: () => menu('cycle', -1) },
        { label: 'Next Worktree', accelerator: 'CmdOrCtrl+Alt+Down', click: () => menu('cycle', 1) },
        { label: 'Next Session', accelerator: 'CmdOrCtrl+`', click: () => menu('cycleSessions', 1) },
        { label: 'Previous Session', accelerator: 'CmdOrCtrl+Shift+`', click: () => menu('cycleSessions', -1) },
        { label: 'Next Needing Attention', click: () => menu('cycleAttention', 1) },
        { label: 'Previous Needing Attention', click: () => menu('cycleAttention', -1) },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Worktree ${i + 1}`,
          accelerator: `CmdOrCtrl+Alt+${i + 1}`,
          click: () => menu('jump', i),
        })),
        { type: 'separator' },
        { label: 'Focus Editor', accelerator: 'CmdOrCtrl+Alt+E', click: () => menu('focusEditor') },
        { label: 'Focus Agent', accelerator: 'CmdOrCtrl+Alt+A', click: () => menu('focusAgent') },
        { label: 'New Agent', accelerator: 'CmdOrCtrl+Alt+T', click: () => menu('newAgent') },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Alt+Left', click: () => menu('cycleTab', -1) },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Alt+Right', click: () => menu('cycleTab', 1) },
        { type: 'separator' },
        {
          label: 'Move Tab to Previous Pane',
          accelerator: 'CmdOrCtrl+Alt+Shift+Left',
          click: () => menu('moveTab', -1),
        },
        { label: 'Move Tab to Next Pane', accelerator: 'CmdOrCtrl+Alt+Shift+Right', click: () => menu('moveTab', 1) },
        { label: 'Move Tab to Pane Above', accelerator: 'CmdOrCtrl+Alt+Shift+Up', click: () => menu('moveTab', 'up') },
        {
          label: 'Move Tab to Pane Below',
          accelerator: 'CmdOrCtrl+Alt+Shift+Down',
          click: () => menu('moveTab', 'down'),
        },
        { type: 'separator' },
        { label: 'New Page', accelerator: 'CmdOrCtrl+Alt+Shift+N', click: () => menu('newPage') },
        { label: 'Previous Page', accelerator: 'CmdOrCtrl+Alt+[', click: () => menu('cyclePage', -1) },
        { label: 'Next Page', accelerator: 'CmdOrCtrl+Alt+]', click: () => menu('cyclePage', 1) },
        { type: 'separator' },
        { label: 'Focus Pane…', accelerator: 'CmdOrCtrl+Shift+J', click: () => menu('pickPane') },
        { label: 'Toggle Pane Zoom', accelerator: 'CmdOrCtrl+Alt+Enter', click: () => menu('togglePaneZoom') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => menu('palette') },
        { type: 'separator' },
        { label: 'Toggle Workspaces Sidebar', accelerator: 'CmdOrCtrl+Alt+B', click: () => menu('toggleSidebar') },
        { label: 'Toggle Rich Markdown', accelerator: 'CmdOrCtrl+Shift+M', click: () => menu('toggleRich') },
        { label: 'Minimize File Tree', accelerator: 'CmdOrCtrl+B', click: () => menu('toggleTree') },
        { label: 'Show Changes', accelerator: 'Ctrl+Shift+G', click: () => menu('showChanges') },
        { label: 'Find in Files', accelerator: 'CmdOrCtrl+Alt+F', click: () => menu('findInFiles') },
        { label: 'Go to Symbol in Workspace…', accelerator: 'CmdOrCtrl+Alt+Shift+O', click: () => menu('goToSymbol') },
        { type: 'separator' },
        {
          label: 'Restart Language Servers',
          click: () => {
            if (store.data.active) {
              lsp.restart(store.data.active, 'ts');
              lsp.restart(store.data.active, 'ruby');
            }
          },
        },
        {
          id: 'reload',
          label: 'Reload Window',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => win?.webContents.reload(),
        },
        {
          id: 'devtools',
          label: 'Developer Tools',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => win?.webContents.openDevTools({ mode: 'detach' }),
        },
        { type: 'separator' },
        { id: 'zoomReset', label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => setZoom(0) },
        {
          id: 'zoomIn',
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => setZoom((store.data.ui?.zoom || 0) + 0.5),
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          visible: false,
          click: () => setZoom((store.data.ui?.zoom || 0) + 0.5),
        },
        {
          id: 'zoomOut',
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => setZoom((store.data.ui?.zoom || 0) - 0.5),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  const binds = store.settings.keybindings || {};
  const remap = (items: MenuItemConstructorOptions[]) => {
    for (const it of items) {
      if (it.label && typeof binds[it.label] === 'string' && !it.role) it.accelerator = binds[it.label] || undefined;
      if (Array.isArray(it.submenu)) remap(it.submenu);
    }
  };
  remap(template);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setZoom(level: number) {
  level = Math.max(-3, Math.min(5, level));
  store.set('ui', { ...(store.data.ui || {}), zoom: level });
  if (win) win.webContents.setZoomLevel(level);
}

// settings.theme: 'system' | 'mocha' | 'latte'; keeps native chrome (menus, scrollbars) in step
function applyNativeTheme() {
  const t = store.settings.theme;
  nativeTheme.themeSource = t === 'mocha' ? 'dark' : t === 'latte' ? 'light' : 'system';
}

function openSettings() {
  store.save();
  menu('openSettings', store.file);
}

function openInDesktop(p?: string | null) {
  if (!p) return;
  const code = findCode(store.settings.codeCommand);
  if (code) spawn(code, [p], { detached: true, stdio: 'ignore' }).unref();
  else shell.openPath(p);
}

/** Apply LSP TextEdits to a file that isn't open in the editor (e.g. rename across files). */
async function applyEditsToDisk(file: string, edits: TextEdit[]) {
  const text = fs.readFileSync(file, 'utf8');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const off = (p: TextEdit['range']['start']) => Math.min(text.length, (starts[p.line] ?? text.length) + p.character);
  const sorted = [...edits].sort((a, b) => off(b.range.start) - off(a.range.start));
  let out = text;
  for (const e of sorted) out = out.slice(0, off(e.range.start)) + e.newText + out.slice(off(e.range.end));
  fs.writeFileSync(file, out, 'utf8');
}

// ------------------------------------------------------------------ ipc

function registerIpc() {
  // ipc args come from the renderer over structured clone; each handler narrows its own
  const h = (ch: string, fn: (...a: Any[]) => unknown) =>
    ipcMain.handle(ch, async (_e, ...a) => {
      try {
        return { ok: true, value: await fn(...a) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
  h('state', () => snapshot());
  h('repo:add', async (dir) => {
    if (!dir) {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], buttonLabel: 'Add Repository' });
      if (r.canceled || !r.filePaths[0]) return null;
      dir = r.filePaths[0];
    }
    const root = await addRepo(dir);
    if (!store.data.active) {
      const w = model.repos.find((x) => x.path === root)?.worktrees[0];
      if (w) activate(w.path);
    }
    return root;
  });
  h('ws:addFolder', async (dir) => {
    if (!dir) {
      const r = await dialog.showOpenDialog(win!, {
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Open as Workspace',
      });
      if (r.canceled || !r.filePaths[0]) return null;
      dir = r.filePaths[0];
    }
    dir = await addFolder(dir);
    activate(dir);
    return dir;
  });
  h('ws:addScratch', async () => {
    const dir = await addScratch();
    activate(dir);
    return dir;
  });
  h('ws:remove', (p) => removeWorkspace(p));
  h('ws:rename', (p, name) => renameWorkspace(p, name));
  h('ws:addMenu', () => {
    Menu.buildFromTemplate([
      { label: 'New Scratch Workspace', click: () => menu('newScratch') },
      { label: 'Open Folder as Workspace…', click: () => menu('addFolder') },
      { type: 'separator' },
      { label: 'Add Repository…', click: () => menu('addRepo') },
      { label: 'New Worktree…', click: () => menu('newWorktree') },
    ]).popup({ window: win ?? undefined });
  });
  h('repo:remove', async (repo) => {
    store.set(
      'repos',
      store.data.repos.filter((r) => r !== repo),
    );
    await refreshWorktrees();
  });
  h('repo:currentBranch', (repo) => G.currentBranch(repo));
  h('wt:create', async ({ repo, branch, base, startAgent }) => {
    const dir = norm(await G.addWorktree(repo, branch, base, store.settings.worktreeRoot));
    G.copyIntoWorktree(repo, dir, store.settings.copyOnCreate);
    await refreshWorktrees();
    activate(dir);
    if (startAgent) await agents.create(dir);
    return dir;
  });
  h('wt:delete', async ({ path: p, force }) => {
    const w = findWorktree(p);
    if (!w) throw new Error('Unknown worktree');
    if (w.main) throw new Error("Can't delete the main worktree");
    await agents.killPrefix(w.prefix);
    agents.forget(w.prefix);
    lsp.stopRoot(w.path);
    dap.stopRoot(w.path);
    watcher.unwatch(w.path);
    await G.removeWorktree(w.repo, w.path, !!force);
    if (store.data.active === w.path) {
      const main = model.repos.find((r) => r.path === w.repo)?.worktrees[0];
      store.set('active', null);
      if (main) activate(main.path);
    }
    await refreshWorktrees();
  });
  h('ws:activate', (p) => activate(p));
  h('editor:desktop', (p) => openInDesktop(p || store.data.active));

  // files
  h('fs:list', (dir) => F.list(dir));
  h('fs:read', (file) => F.read(file));
  h('fs:resolve', (cwd, p) => F.resolveFile(cwd, p));
  h('fs:write', (file, text) => F.write(file, text));
  h('fs:index', (root) => F.fileIndex(root));
  h('fs:search', (root, o, id) => S.search(root, o, id));
  h('fs:replace', (file, o, repl, positions) => S.replaceInFile(file, o, repl, positions));
  h('fs:replaceEdits', (text, o, repl, positions) => S.replaceEdits(text, o, repl, positions));
  h('fs:applyEdits', (file, edits) => applyEditsToDisk(file, edits));
  h('git:isRepo', (root) =>
    G.git(root, ['rev-parse', '--is-inside-work-tree']).then(
      () => true,
      () => false,
    ),
  );
  h('git:status', (root) => F.gitStatus(root));
  h('git:changes', (root) => F.gitChanges(root));
  h('git:aheadBehind', (root) => F.gitAheadBehind(root));
  h('git:diffStat', (root) => F.gitDiffStat(root));
  h('git:commit', (root, message) => F.gitCommit(root, message));
  h('git:undoCommit', (root) => F.gitUndoCommit(root));
  h('git:stage', (root, paths) => F.gitStage(root, paths));
  h('git:unstage', (root, paths) => F.gitUnstage(root, paths));
  h('git:discard', (root, paths) => F.gitDiscard(root, paths));
  h('git:log', (root) => F.gitLog(root));
  h('git:commitFiles', (root, sha) => F.gitCommitFiles(root, sha));
  h('git:show', (root, rel, ref) => F.gitShow(root, rel, ref));
  h('reveal', (p) => shell.showItemInFolder(p));

  // language servers
  h('lsp:open', (root, file, text) => lsp.open(root, file, text));
  h('lsp:request', (root, kind, method, params) => lsp.request(root, kind, method, params));
  h('lsp:restart', (root, kind) => lsp.restart(root, kind));
  h('lsp:installRuby', async (root) => {
    await lsp.installRubyLsp(root);
    lsp.restart(root, 'ruby');
  });
  ipcMain.on('lsp:change', (_e, root, kind, uri, version, changes) => lsp.change(root, kind, uri, version, changes));
  ipcMain.on('lsp:save', (_e, root, kind, uri, text) => lsp.save(root, kind, uri, text));
  ipcMain.on('lsp:close', (_e, root, kind, uri) => lsp.close(root, kind, uri));

  // debugger
  h('dap:configs', (root, file) => dap.configs(root, file));
  h('dap:start', (root, config, ctx, breakpoints) => dap.start(root, config, ctx, breakpoints));
  h('dap:request', (sid, cid, command, args) => dap.request(sid, cid, command, args));
  h('dap:breakpoints', (sid, file, list) => dap.setBreakpoints(sid, file, list));
  h('dap:stop', (sid) => dap.stop(sid));

  // agents
  h('agent:create', (p, kind, opts) =>
    agents
      .create(norm(p), {
        kind,
        agent: opts && typeof opts.agent === 'string' ? opts.agent : undefined,
        session:
          opts && typeof opts.sessionId === 'string'
            ? { sessionId: opts.sessionId, title: typeof opts.title === 'string' ? opts.title : null }
            : undefined,
      })
      .then((s) => s.id),
  );
  h('agent:kill', (id) => agents.kill(id));
  h('agent:rename', (id, title) => agents.rename(id, title));
  h('agent:buffer', (id) => agents.buffer(id));
  const chatOf = (id: string) =>
    agents.chat(id) ||
    (() => {
      throw new Error('No such chat');
    })();
  h('chat:saveTemp', (name: string, bytes: Uint8Array) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tawny-attach-'));
    const file = path.join(dir, path.basename(name) || 'video');
    fs.writeFileSync(file, bytes);
    return file;
  });
  h('chat:prompt', (id, blocks) => chatOf(id).prompt(blocks));
  h('chat:clear', (id) => chatOf(id).clear());
  h('chat:cancel', (id) => chatOf(id).cancel());
  h('chat:answer', (id, reqId, optionId) => chatOf(id).answer(reqId, optionId));
  h('chat:setConfig', (id, configId, value) => chatOf(id).setConfig(configId, value));
  h('chat:history', (id) => chatOf(id).history());
  h('chat:reconnect', (id) => chatOf(id).reconnect());
  h('chat:auth', (id, methodId) => agents.chatAuth(id, methodId));
  h('chat:toTerminal', (id) => agents.chatToTerminal(id).then((s) => s.id));
  h('chat:sessions', (p) => agents.chatHistory(norm(p)));
  ipcMain.on('chat:file-reply', (_e, id, reqId, text) => {
    const c = agents.chat(id);
    if (c) c.fileReply(reqId, text);
  });
  ipcMain.on('agent:write', (_e, id, data) => agents.write(id, data));
  ipcMain.on('agent:resize', (_e, id, cols, rows) => agents.resize(id, cols, rows));
  ipcMain.on('agent:focused', (_e, id) => {
    focusedAgent = id;
  });

  h('settings:open', () => openSettings());
  // command palette: run a main-process menu item by id (reload, devtools, zoom)
  h('menu:run', (id) => {
    Menu.getApplicationMenu()?.getMenuItemById(id)?.click();
  });
  h('ui:save', (ui) => store.set('ui', { ...(store.data.ui || {}), ...ui }));
  h('refresh', () => refreshWorktrees());
  h('resources:get', () => resources.sample());
  h('ports:get', () => resources.ports());
  h('ports:kill', (pid, port) => resources.killPort(pid, port));
}

// ------------------------------------------------------------------ app

async function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 560,
    title: 'Tawny',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e2e' : '#eff1f5', // Catppuccin Mocha / Latte base
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 8 + (IS_DEV ? DEV_BANNER_H : 0) },
    icon: DEV_LOGO || LOGO,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  win.on('focus', () => {
    // tawny.json is hand-edited; pick up changes (e.g. theme) when coming back to the window
    const before = JSON.stringify(store.settings);
    store.reloadSettings();
    if (JSON.stringify(store.settings) !== before) {
      applyNativeTheme();
      buildMenu();
      pushState();
    }
    refreshWorktrees().catch(() => {});
  });
  win.on('close', (e) => {
    if (!confirmQuit()) e.preventDefault();
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !url.startsWith(process.env.ELECTRON_RENDERER_URL || 'file:')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-start-loading', () => dap && dap.dispose()); // reload drops the debugger UI's state
  win.webContents.on('did-finish-load', () => win?.webContents.setZoomLevel(store.data.ui?.zoom || 0));
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(DEV_LOGO || LOGO);
  store = new Store(app.getPath('userData'));
  applyNativeTheme();
  agents = new Agents(store);
  lsp = new Lsp(store);
  resources = new Resources({ agents, lsp, worktrees: allWorkspaces, appMetrics: () => app.getAppMetrics() });
  dap = new Dap();
  watcher = new F.Watcher();

  agents.on('changed', pushState);
  agents.on('data', (id, d) => send('agent:data', id, d));
  agents.on('exit', (id) => send('agent:exit', id));
  agents.on('chat', (channel, ...a) => send(channel, ...a));
  const notifyAgent = (id: string, title: string, body: string, unread = false) => {
    if (!store.settings.notifyWhenAgentFinishes) return;
    const w = allWorkspaces().find((x) => id.startsWith(`${x.prefix}_`));
    const inView = win?.isFocused() && (unread ? focusedAgent === id : store.data.active === w?.path);
    if (!w || inView || !Notification.isSupported()) return;
    const n = new Notification({
      title: `${title} · ${('name' in w ? w.name : '') || ('branch' in w ? w.branch : '') || path.basename(w.path)}`,
      body,
    });
    n.on('click', () => {
      if (win) {
        win.show();
        win.focus();
      }
      activate(w.path);
      menu('focusAgent');
    });
    n.show();
  };
  agents.on('finished', (id) => notifyAgent(id, 'Agent finished', 'Done, or waiting for your input.', true));
  agents.on('waiting', (id) => notifyAgent(id, 'Agent waiting', 'Waiting for your approval or answer.'));
  lsp.on('status', pushState);
  lsp.on('diagnostics', (root, p) => send('lsp:diagnostics', root, p));
  lsp.on('applyEdit', (root, e) => send('lsp:applyEdit', root, e));
  lsp.on('restarted', (root, kind) => send('lsp:restarted', root, kind));
  lsp.on('message', (m) => send('toast', m));
  dap.on('event', (e) => send('dap:event', e));
  watcher.on('changed', (root: string, changes: { path: string; type: number }[], gitChanged: boolean) => {
    if (changes.length) lsp.filesChanged(root, changes);
    send(
      'fs:changed',
      root,
      changes.map((c) => c.path),
      gitChanged,
    );
    if (gitChanged || changes.length) {
      clearTimeout(watcher.refreshTimer);
      watcher.refreshTimer = setTimeout(() => refreshWorktrees().catch(() => {}), 800);
    }
  });

  registerIpc();
  buildMenu();
  await agents.init();

  if (!store.data.repos.length && process.env.TAWNY_REPO) {
    try {
      await addRepo(process.env.TAWNY_REPO);
    } catch {
      /* */
    }
  }
  await refreshWorktrees();
  await createWindow();
  setInterval(() => refreshWorktrees().catch(() => {}), 30000);
  setInterval(
    () =>
      resources.sample().then(
        (r) => send('resources', r),
        () => {},
      ),
    2000,
  );
  setInterval(
    () =>
      resources.ports().then(
        (r) => send('ports', r),
        () => {},
      ),
    5000,
  );
  if (store.data.active && findWorkspace(store.data.active)) activate(store.data.active);
  else if (allWorkspaces()[0]) activate(allWorkspaces()[0].path);
  if (process.env.TAWNY_TEST)
    require(process.env.TAWNY_TEST)({ win, store, agents, lsp, model, activate, refreshWorktrees });
});

// quitting kills the adapters (no tmux), so a running turn would be lost: ask first
let quitOk = false;
function confirmQuit() {
  if (quitOk) return true;
  const n = agents ? agents.busyChats() : 0;
  if (!n) return true;
  const opts: Electron.MessageBoxSyncOptions = {
    type: 'warning',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: n === 1 ? 'A chat is still working.' : `${n} chats are still working.`,
    detail: 'Quitting stops the running turn. The conversation is kept and comes back when you reopen Tawny.',
  };
  quitOk = (win && !win.isDestroyed() ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts)) === 0;
  return quitOk;
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (e) => {
  if (!confirmQuit()) return e.preventDefault();
  try {
    agents && agents.dispose();
  } catch {
    /* */
  }
  try {
    lsp && lsp.dispose();
  } catch {
    /* */
  }
  try {
    dap && dap.dispose();
  } catch {
    /* */
  }
  try {
    watcher && watcher.dispose();
  } catch {
    /* */
  }
});
