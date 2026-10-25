'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, Notification, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { loadShellEnv } = require('./shellenv');
loadShellEnv();

const G = require('./git');
const { Store } = require('./store');
const { Agents } = require('./agents');
const { Lsp } = require('./lsp');
const F = require('./files');
const { findCode } = require('./desktop');

const IS_DEV = !!process.env.HARBOR_DEV;
const LOGO = path.join(__dirname, '..', '..', 'assets', 'logo.png');
const DEV_LOGO = IS_DEV ? require('./devicon').devIcon(path.join(__dirname, '..', '..', 'assets', 'logo-512.png')) : null;
const DEV_BANNER_H = 18; // keep in sync with --dev-banner-h in style.css

app.setName(process.env.HARBOR_USER_DATA ? 'Harbor Dev' : 'Harbor');
if (process.env.HARBOR_USER_DATA) app.setPath('userData', process.env.HARBOR_USER_DATA);

// node-pty's macOS helper ships without the executable bit in some installs, which makes every
// agent fail with "posix_spawnp failed". Fix it up before spawning anything.
function fixPtyHelper() {
  try {
    const base = path.dirname(require.resolve('node-pty/package.json')).replace('app.asar', 'app.asar.unpacked');
    for (const dir of ['prebuilds', 'build/Release']) {
      const root = path.join(base, dir);
      if (!fs.existsSync(root)) continue;
      for (const sub of [root, ...fs.readdirSync(root).map(n => path.join(root, n))]) {
        const helper = path.join(sub, 'spawn-helper');
        if (fs.existsSync(helper)) { try { fs.chmodSync(helper, 0o755); } catch { /* read-only bundle */ } }
      }
    }
  } catch { /* not installed */ }
}
fixPtyHelper();

let win, store, agents, lsp, watcher;
const norm = p => path.resolve(p).replace(/[\\/]+$/, '');
const model = { repos: [] };
const send = (ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); };

// ------------------------------------------------------------------ workspaces

async function refreshWorktrees() {
  const repos = [];
  for (const repo of store.data.repos) {
    try {
      const wts = await G.listWorktrees(repo);
      await Promise.all(wts.map(async w => {
        w.path = norm(w.path);
        w.prefix = G.sessionPrefix(w.path);
        w.dirty = w.prunable ? -1 : await G.dirtyCount(w.path);
      }));
      repos.push({ path: repo, name: path.basename(repo), worktrees: wts });
    } catch (e) {
      repos.push({ path: repo, name: path.basename(repo), worktrees: [], error: e.message });
    }
  }
  model.repos = repos;
  const alive = new Set(repos.flatMap(r => r.worktrees.map(w => w.path)));
  if (store.data.active && !alive.has(store.data.active) && repos.length) store.set('active', null);
  pushState();
}

const allWorktrees = () => model.repos.flatMap(r => r.worktrees);
const findWorktree = p => allWorktrees().find(w => w.path === norm(p));

function snapshot() {
  return {
    repos: model.repos,
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

let pushTimer;
function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { send('state', snapshot()); updateBadge(); }, 30);
}

function updateBadge() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const n = agents.list().filter(s => s.working).length;
  app.dock.setBadge(n ? String(n) : '');
}

async function addRepo(dir) {
  const root = norm(await G.repoRootFor(dir));
  if (!store.data.repos.includes(root)) store.set('repos', [...store.data.repos, root]);
  await refreshWorktrees();
  return root;
}

function activate(p) {
  p = norm(p);
  store.set('active', p);
  watcher.keepOnly([p]);
  watcher.watch(p);
  pushState();
  return p;
}

// ------------------------------------------------------------------ menu

const menu = (cmd, arg) => send('menu', cmd, arg);

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'Harbor',
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => openSettings() },
        { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Go to File…', accelerator: 'CmdOrCtrl+P', click: () => menu('goToFile') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => menu('save') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => menu('closeTab') },
        { type: 'separator' },
        { label: 'Add Repository…', click: () => menu('addRepo') },
        { label: 'New Worktree…', accelerator: 'CmdOrCtrl+Alt+N', click: () => menu('newWorktree') },
        { type: 'separator' },
        { label: 'Open Worktree in VS Code', accelerator: 'CmdOrCtrl+Alt+O', click: () => openInDesktop(store.data.active) },
        { label: 'Reveal Worktree in Finder', click: () => store.data.active && shell.openPath(store.data.active) },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'Settings…', click: () => openSettings() }, { role: 'quit' }]),
      ],
    },
    // Clipboard via roles; undo/redo/select-all are handled by the editor/terminal themselves.
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    {
      label: 'Go',
      submenu: [
        { label: 'Switch Worktree…', accelerator: 'CmdOrCtrl+Alt+P', click: () => menu('quickSwitch') },
        { label: 'Previous Worktree', accelerator: 'CmdOrCtrl+Alt+Up', click: () => menu('cycle', -1) },
        { label: 'Next Worktree', accelerator: 'CmdOrCtrl+Alt+Down', click: () => menu('cycle', 1) },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({ label: `Worktree ${i + 1}`, accelerator: `CmdOrCtrl+Alt+${i + 1}`, click: () => menu('jump', i) })),
        { type: 'separator' },
        { label: 'Focus Editor', accelerator: 'CmdOrCtrl+Alt+E', click: () => menu('focusEditor') },
        { label: 'Focus Agent', accelerator: 'CmdOrCtrl+Alt+A', click: () => menu('focusAgent') },
        { label: 'New Agent', accelerator: 'CmdOrCtrl+Alt+T', click: () => menu('newAgent') },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Alt+Left', click: () => menu('cycleTab', -1) },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Alt+Right', click: () => menu('cycleTab', 1) },
        { type: 'separator' },
        { label: 'Move Tab to Previous Pane', accelerator: 'CmdOrCtrl+Alt+Shift+Left', click: () => menu('moveTab', -1) },
        { label: 'Move Tab to Next Pane', accelerator: 'CmdOrCtrl+Alt+Shift+Right', click: () => menu('moveTab', 1) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Workspaces Sidebar', accelerator: 'CmdOrCtrl+B', click: () => menu('toggleSidebar') },
        { label: 'Toggle File Tree', accelerator: 'CmdOrCtrl+Alt+B', click: () => menu('toggleTree') },
        { type: 'separator' },
        { label: 'Restart Language Servers', click: () => { if (store.data.active) { lsp.restart(store.data.active, 'ts'); lsp.restart(store.data.active, 'ruby'); } } },
        { label: 'Reload Window', accelerator: 'CmdOrCtrl+Shift+R', click: () => win.webContents.reload() },
        { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Alt+I', click: () => win.webContents.openDevTools({ mode: 'detach' }) },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => setZoom(0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => setZoom((store.data.ui?.zoom || 0) + 0.5) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => setZoom((store.data.ui?.zoom || 0) + 0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => setZoom((store.data.ui?.zoom || 0) - 0.5) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setZoom(level) {
  level = Math.max(-3, Math.min(5, level));
  store.set('ui', { ...(store.data.ui || {}), zoom: level });
  if (win) win.webContents.setZoomLevel(level);
}

// settings.theme: 'system' | 'mocha' | 'latte'; keeps native chrome (menus, scrollbars) in step
function applyNativeTheme() {
  const t = store.settings.theme;
  nativeTheme.themeSource = t === 'mocha' ? 'dark' : t === 'latte' ? 'light' : 'system';
}

function openSettings() { store.save(); shell.openPath(store.file); }

function openInDesktop(p) {
  if (!p) return;
  const code = findCode(store.settings.codeCommand);
  if (code) spawn(code, [p], { detached: true, stdio: 'ignore' }).unref();
  else shell.openPath(p);
}

/** Apply LSP TextEdits to a file that isn't open in the editor (e.g. rename across files). */
async function applyEditsToDisk(file, edits) {
  const text = fs.readFileSync(file, 'utf8');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const off = p => Math.min(text.length, (starts[p.line] ?? text.length) + p.character);
  const sorted = [...edits].sort((a, b) => off(b.range.start) - off(a.range.start));
  let out = text;
  for (const e of sorted) out = out.slice(0, off(e.range.start)) + e.newText + out.slice(off(e.range.end));
  fs.writeFileSync(file, out, 'utf8');
}

// ------------------------------------------------------------------ ipc

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => {
    try { return { ok: true, value: await fn(...a) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  h('state', () => snapshot());
  h('repo:add', async dir => {
    if (!dir) {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], buttonLabel: 'Add Repository' });
      if (r.canceled || !r.filePaths[0]) return null;
      dir = r.filePaths[0];
    }
    const root = await addRepo(dir);
    if (!store.data.active) {
      const w = model.repos.find(x => x.path === root)?.worktrees[0];
      if (w) activate(w.path);
    }
    return root;
  });
  h('repo:remove', async repo => { store.set('repos', store.data.repos.filter(r => r !== repo)); await refreshWorktrees(); });
  h('repo:currentBranch', repo => G.currentBranch(repo));
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
    if (w.main) throw new Error('Can\'t delete the main worktree');
    await agents.killPrefix(w.prefix);
    agents.forget(w.prefix);
    lsp.stopRoot(w.path);
    watcher.unwatch(w.path);
    await G.removeWorktree(w.repo, w.path, !!force);
    if (store.data.active === w.path) {
      const main = model.repos.find(r => r.path === w.repo)?.worktrees[0];
      store.set('active', null);
      if (main) activate(main.path);
    }
    await refreshWorktrees();
  });
  h('ws:activate', p => activate(p));
  h('editor:desktop', p => openInDesktop(p || store.data.active));

  // files
  h('fs:list', dir => F.list(dir));
  h('fs:read', file => F.read(file));
  h('fs:write', (file, text) => F.write(file, text));
  h('fs:index', root => F.fileIndex(root));
  h('fs:applyEdits', (file, edits) => applyEditsToDisk(file, edits));
  h('git:status', root => F.gitStatus(root));
  h('reveal', p => shell.showItemInFolder(p));

  // language servers
  h('lsp:open', (root, file, text) => lsp.open(root, file, text));
  h('lsp:request', (root, kind, method, params) => lsp.request(root, kind, method, params));
  h('lsp:restart', (root, kind) => lsp.restart(root, kind));
  h('lsp:installRuby', async root => { await lsp.installRubyLsp(root); lsp.restart(root, 'ruby'); });
  ipcMain.on('lsp:change', (_e, root, kind, uri, version, changes) => lsp.change(root, kind, uri, version, changes));
  ipcMain.on('lsp:save', (_e, root, kind, uri, text) => lsp.save(root, kind, uri, text));
  ipcMain.on('lsp:close', (_e, root, kind, uri) => lsp.close(root, kind, uri));

  // agents
  h('agent:create', (p, kind) => agents.create(norm(p), { kind }).then(s => s.id));
  h('agent:kill', id => agents.kill(id));
  h('agent:rename', (id, title) => agents.rename(id, title));
  h('agent:buffer', id => agents.buffer(id));
  ipcMain.on('agent:write', (_e, id, data) => agents.write(id, data));
  ipcMain.on('agent:resize', (_e, id, cols, rows) => agents.resize(id, cols, rows));

  h('settings:open', () => openSettings());
  h('ui:save', ui => store.set('ui', { ...(store.data.ui || {}), ...ui }));
  h('refresh', () => refreshWorktrees());
}

// ------------------------------------------------------------------ app

async function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 900, minHeight: 560,
    title: 'Harbor',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e2e' : '#eff1f5',   // Catppuccin Mocha / Latte base
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 + (IS_DEV ? DEV_BANNER_H : 0) },
    icon: DEV_LOGO || LOGO,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false },
  });
  win.on('focus', () => {
    // harbor.json is hand-edited; pick up changes (e.g. theme) when coming back to the window
    const before = JSON.stringify(store.settings);
    store.reloadSettings();
    if (JSON.stringify(store.settings) !== before) { applyNativeTheme(); pushState(); }
    refreshWorktrees().catch(() => {});
  });
  win.on('closed', () => { win = null; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('did-finish-load', () => win?.webContents.setZoomLevel(store.data.ui?.zoom || 0));
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(DEV_LOGO || LOGO);
  store = new Store(app.getPath('userData'));
  applyNativeTheme();
  agents = new Agents(store);
  lsp = new Lsp(store);
  watcher = new F.Watcher();

  agents.on('changed', pushState);
  agents.on('data', (id, d) => send('agent:data', id, d));
  agents.on('exit', id => send('agent:exit', id));
  const notifyAgent = (id, title, body) => {
    if (!store.settings.notifyWhenAgentFinishes) return;
    const w = allWorktrees().find(x => id.startsWith(x.prefix + '_'));
    if (!w || (win && win.isFocused() && store.data.active === w.path) || !Notification.isSupported()) return;
    const n = new Notification({ title: `${title} · ${w.branch || path.basename(w.path)}`, body });
    n.on('click', () => { if (win) { win.show(); win.focus(); } activate(w.path); menu('focusAgent'); });
    n.show();
  };
  agents.on('finished', id => notifyAgent(id, 'Agent finished', 'Done, or waiting for your input.'));
  agents.on('waiting', id => notifyAgent(id, 'Agent needs input', 'Waiting for your approval or answer.'));
  lsp.on('status', pushState);
  lsp.on('diagnostics', (root, p) => send('lsp:diagnostics', root, p));
  lsp.on('applyEdit', (root, e) => send('lsp:applyEdit', root, e));
  lsp.on('restarted', (root, kind) => send('lsp:restarted', root, kind));
  lsp.on('message', m => send('toast', m));
  watcher.on('changed', (root, changes, gitChanged) => {
    if (changes.length) lsp.filesChanged(root, changes);
    send('fs:changed', root, changes.map(c => c.path), gitChanged);
    if (gitChanged || changes.length) {
      clearTimeout(watcher.refreshTimer);
      watcher.refreshTimer = setTimeout(() => refreshWorktrees().catch(() => {}), 800);
    }
  });

  registerIpc();
  buildMenu();
  await agents.init();

  if (!store.data.repos.length && process.env.HARBOR_REPO) { try { await addRepo(process.env.HARBOR_REPO); } catch { /* */ } }
  await refreshWorktrees();
  await createWindow();
  setInterval(() => refreshWorktrees().catch(() => {}), 30000);
  if (store.data.active && findWorktree(store.data.active)) activate(store.data.active);
  else if (allWorktrees()[0]) activate(allWorktrees()[0].path);
  if (process.env.HARBOR_DEV) {
    // hot reload: renderer edits reload the window (scripts/dev.js restarts the app for main-process edits)
    let t;
    fs.watch(path.join(__dirname, '..', 'renderer'), { recursive: true }, () => {
      clearTimeout(t);
      t = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache(); }, 120);
    });
  }
  if (process.env.HARBOR_TEST) require(process.env.HARBOR_TEST)({ win, store, agents, lsp, model, activate, refreshWorktrees });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  try { agents && agents.dispose(); } catch { /* */ }
  try { lsp && lsp.dispose(); } catch { /* */ }
  try { watcher && watcher.dispose(); } catch { /* */ }
});
