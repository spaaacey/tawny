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
  devPort: process.env.HARBOR_DEV_PORT || '',
  state: () => call('state'),
  pathFor: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  // workspaces
  addRepo: dir => call('repo:add', dir),
  addFolder: dir => call('ws:addFolder', dir),
  addScratch: () => call('ws:addScratch'),
  removeWorkspace: p => call('ws:remove', p),
  renameWorkspace: (p, name) => call('ws:rename', p, name),
  addMenu: () => call('ws:addMenu'),
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
  search: (root, opts, id) => call('fs:search', root, opts, id),
  replaceInFile: (file, opts, repl, positions) => call('fs:replace', file, opts, repl, positions),
  replaceEdits: (text, opts, repl, positions) => call('fs:replaceEdits', text, opts, repl, positions),
  applyEditsToDisk: (file, edits) => call('fs:applyEdits', file, edits),
  gitIsRepo: root => call('git:isRepo', root),
  gitStatus: root => call('git:status', root),
  gitChanges: root => call('git:changes', root),
  gitDiffStat: root => call('git:diffStat', root),
  gitCommit: (root, message) => call('git:commit', root, message),
  gitStage: (root, paths) => call('git:stage', root, paths),
  gitUnstage: (root, paths) => call('git:unstage', root, paths),
  gitDiscard: (root, paths) => call('git:discard', root, paths),
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
  // debugger
  dapConfigs: (root, file) => call('dap:configs', root, file),
  dapStart: (root, config, ctx, breakpoints) => call('dap:start', root, config, ctx, breakpoints),
  dapRequest: (sid, cid, command, args) => call('dap:request', sid, cid, command, args),
  dapBreakpoints: (sid, file, list) => call('dap:breakpoints', sid, file, list),
  dapStop: sid => call('dap:stop', sid),
  // agents
  createAgent: (p, kind) => call('agent:create', p, kind),
  killAgent: id => call('agent:kill', id),
  renameAgent: (id, title) => call('agent:rename', id, title),
  agentBuffer: id => call('agent:buffer', id),
  writeAgent: (id, d) => ipcRenderer.send('agent:write', id, d),
  resizeAgent: (id, c, r) => ipcRenderer.send('agent:resize', id, c, r),
  // chat tabs (ACP)
  chatPrompt: (id, blocks) => call('chat:prompt', id, blocks),
  chatCancel: id => call('chat:cancel', id),
  chatAnswer: (id, reqId, optionId) => call('chat:answer', id, reqId, optionId),
  chatSetConfig: (id, configId, value) => call('chat:setConfig', id, configId, value),
  chatHistory: id => call('chat:history', id),
  chatFileReply: (id, reqId, text) => ipcRenderer.send('chat:file-reply', id, reqId, text),
  // misc
  openSettings: () => call('settings:open'),
  saveUi: ui => call('ui:save', ui),
  runMenu: id => call('menu:run', id),
  refresh: () => call('refresh'),
  resources: () => call('resources:get'),
  ports: () => call('ports:get'),
  killPort: (pid, port) => call('ports:kill', pid, port),
  // events
  onState: fn => on('state', fn),
  onAgentData: fn => on('agent:data', fn),
  onAgentExit: fn => on('agent:exit', fn),
  onChatUpdate: fn => on('chat:update', fn),
  onChatPermission: fn => on('chat:permission', fn),
  onChatPermissionDone: fn => on('chat:permission-done', fn),
  onChatStatus: fn => on('chat:status', fn),
  onChatReadFile: fn => on('chat:read-file', fn),
  onMenu: fn => on('menu', fn),
  onDiagnostics: fn => on('lsp:diagnostics', fn),
  onApplyEdit: fn => on('lsp:applyEdit', fn),
  onDapEvent: fn => on('dap:event', fn),
  onLspRestarted: fn => on('lsp:restarted', fn),
  onFsChanged: fn => on('fs:changed', fn),
  onToast: fn => on('toast', fn),
  onResources: fn => on('resources', fn),
  onPorts: fn => on('ports', fn),
});
