'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (ch, ...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const on = (ch, fn) => {
  const l = (_e, ...a) => fn(...a);
  ipcRenderer.on(ch, l);
  return () => ipcRenderer.removeListener(ch, l);
};

contextBridge.exposeInMainWorld('harbor', {
  platform: process.platform,
  dev: !!process.env.HARBOR_DEV,
  state: () => call('state'),
  pathFor: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  // workspaces
  addRepo: dir => call('repo:add', dir),
  removeRepo: repo => call('repo:remove', repo),
  currentBranch: repo => call('repo:currentBranch', repo),
  createWorktree: opts => call('wt:create', opts),
  deleteWorktree: opts => call('wt:delete', opts),
  activate: p => call('ws:activate', p),
  openDesktop: p => call('editor:desktop', p),
  // files
  list: dir => call('fs:list', dir),
  read: file => call('fs:read', file),
  resolveFile: (cwd, p) => call('fs:resolve', cwd, p),
  write: (file, text) => call('fs:write', file, text),
  fileIndex: root => call('fs:index', root),
  applyEditsToDisk: (file, edits) => call('fs:applyEdits', file, edits),
  gitStatus: root => call('git:status', root),
  gitChanges: root => call('git:changes', root),
  gitLog: root => call('git:log', root),
  gitCommitFiles: (root, sha) => call('git:commitFiles', root, sha),
  gitShow: (root, rel, ref) => call('git:show', root, rel, ref),
  reveal: p => call('reveal', p),
  // language servers
  lspOpen: (root, file, text) => call('lsp:open', root, file, text),
  lspRequest: (root, kind, method, params) => call('lsp:request', root, kind, method, params),
  lspRestart: (root, kind) => call('lsp:restart', root, kind),
  lspInstallRuby: root => call('lsp:installRuby', root),
  lspChange: (root, kind, uri, version, changes) => ipcRenderer.send('lsp:change', root, kind, uri, version, changes),
  lspSave: (root, kind, uri, text) => ipcRenderer.send('lsp:save', root, kind, uri, text),
  lspClose: (root, kind, uri) => ipcRenderer.send('lsp:close', root, kind, uri),
  // agents
  createAgent: (p, kind) => call('agent:create', p, kind),
  killAgent: id => call('agent:kill', id),
  renameAgent: (id, title) => call('agent:rename', id, title),
  agentBuffer: id => call('agent:buffer', id),
  writeAgent: (id, d) => ipcRenderer.send('agent:write', id, d),
  resizeAgent: (id, c, r) => ipcRenderer.send('agent:resize', id, c, r),
  // misc
  openSettings: () => call('settings:open'),
  saveUi: ui => call('ui:save', ui),
  refresh: () => call('refresh'),
  // events
  onState: fn => on('state', fn),
  onAgentData: fn => on('agent:data', fn),
  onAgentExit: fn => on('agent:exit', fn),
  onMenu: fn => on('menu', fn),
  onDiagnostics: fn => on('lsp:diagnostics', fn),
  onApplyEdit: fn => on('lsp:applyEdit', fn),
  onLspRestarted: fn => on('lsp:restarted', fn),
  onFsChanged: fn => on('fs:changed', fn),
  onToast: fn => on('toast', fn),
});
