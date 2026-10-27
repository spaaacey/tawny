// Minimal LSP client host: one language server per (worktree root, server kind), spoken over stdio.
// The renderer drives it (open/change/close + generic requests); diagnostics and progress are pushed back.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Store } from './store';

import type { RpcMessage } from './types';

interface Spec {
  cmd?: string;
  args?: string[];
  name: string;
  error?: string;
  installable?: boolean;
}

// ---------------------------------------------------------------- language routing

const EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.gemspec': 'ruby',
  '.ru': 'ruby',
  '.jbuilder': 'ruby',
  '.erb': 'erb',
};
const RUBY_FILES = new Set(['Gemfile', 'Rakefile', 'Guardfile', 'Capfile', 'Brewfile', 'Podfile', 'Fastfile']);

function languageIdFor(file: string): string | null {
  const base = path.basename(file);
  if (RUBY_FILES.has(base)) return 'ruby';
  return EXT[path.extname(file).toLowerCase()] || null;
}

function serverKindFor(languageId: string | null): 'ts' | 'ruby' | null {
  if (!languageId) return null;
  if (/^(typescript|javascript)/.test(languageId)) return 'ts';
  if (languageId === 'ruby' || languageId === 'erb') return 'ruby';
  return null;
}

function which(cmd: string) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** TypeScript 7 ships a native LSP (`tsc --lsp --stdio`). Prefer the project's own TS 7+, else the bundled one. */
function tsServerCommand(root: string): Spec {
  const tryPkg = (dir: string) => {
    try {
      const getExe = require(path.join(dir, 'node_modules/typescript/lib/getExePath.js'));
      const exe = (getExe.default || getExe.getExePath || getExe)();
      if (exe && fs.existsSync(exe)) return exe;
    } catch {
      /* not TS7 */
    }
    return null;
  };
  let exe = tryPkg(root);
  if (!exe) {
    exe = tryPkg(path.join(__dirname, '..', '..'));
    if (!exe)
      return { name: 'TypeScript', error: 'Bundled TypeScript 7 not found — run npm install in the Tawny folder.' };
  }
  exe = exe.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return { cmd: exe, args: ['--lsp', '--stdio'], name: 'TypeScript' };
}

function rubyServerCommand(_root: string, settings: Store['settings']): Spec {
  if (settings.rubyLspCommand) {
    const [cmd, ...args] = settings.rubyLspCommand.split(/\s+/);
    return { cmd, args, name: 'Ruby LSP' };
  }
  const lsp = which('ruby-lsp');
  if (lsp) return { cmd: lsp, args: [], name: 'Ruby LSP' };
  return {
    name: 'Ruby LSP',
    error: "ruby-lsp not found. Install it for this project's Ruby: gem install ruby-lsp",
    installable: true,
  };
}

// ---------------------------------------------------------------- one server

const CLIENT_CAPABILITIES: Record<string, unknown> = {
  general: { positionEncodings: ['utf-16'] },
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        insertReplaceSupport: false,
        labelDetailsSupport: true,
        deprecatedSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
      },
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: {
      signatureInformation: {
        documentationFormat: ['markdown', 'plaintext'],
        parameterInformation: { labelOffsetSupport: true },
      },
    },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentHighlight: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    formatting: {},
    rename: { prepareSupport: true },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'source', 'source.organizeImports'] },
      },
      resolveSupport: { properties: ['edit'] },
    },
    publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } },
  },
  workspace: {
    symbol: {},
    configuration: true,
    workspaceFolders: true,
    applyEdit: true,
    workspaceEdit: { documentChanges: true },
  },
  window: { workDoneProgress: true, showMessage: {} },
};

/** The server capabilities Tawny reads from the `initialize` result. */
interface ServerCapabilities {
  textDocumentSync?: number | { change?: number };
  diagnosticProvider?: { interFileDependencies?: boolean };
  completionProvider?: { triggerCharacters?: string[] };
  signatureHelpProvider?: { triggerCharacters?: string[] };
  [k: string]: unknown;
}
/** Params of the server->client requests/notifications handled in dispatch(). */
interface LspParams {
  items?: unknown[];
  edit?: unknown;
  type?: number;
  message?: string;
  token?: string | number;
  value?: { kind?: string; title?: string; message?: string };
  [k: string]: unknown;
}
type LspMessage = Omit<RpcMessage, 'params'> & { params?: LspParams };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class Server extends EventEmitter {
  nextId = 1;
  pending = new Map<number, Pending>();
  buf: Buffer = Buffer.alloc(0);
  docs = new Map<string, number>(); // uri -> version
  state: 'starting' | 'ready' | 'error' | 'stopped' = 'starting';
  error: string | null = null;
  log = '';
  progress = new Map<string | number, string>();
  proc?: ChildProcessWithoutNullStreams;
  ready?: Promise<Server>;
  capabilities: ServerCapabilities | null = null;
  failedAt = 0;
  pullTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    readonly root: string,
    readonly kind: string,
    readonly spec: Spec,
  ) {
    super();
  }

  start() {
    const { cmd, args } = this.spec as Required<Pick<Spec, 'cmd' | 'args'>>;
    const env = { ...process.env };
    if (this.kind === 'ruby') env.BUNDLE_GEMFILE = env.BUNDLE_GEMFILE || ''; // let ruby-lsp compose its own bundle
    if (!env.BUNDLE_GEMFILE) delete env.BUNDLE_GEMFILE;
    const proc = spawn(cmd, args, { cwd: this.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout.on('data', (d) => this.onData(d));
    proc.stderr.on('data', (d) => {
      this.log = (this.log + d).slice(-20000);
    });
    proc.on('error', (e) => this.fail(e.message));
    proc.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error('language server exited'));
      this.pending.clear();
      if (this.state !== 'stopped')
        this.fail(`${this.spec.name} exited (code ${code}).\n${this.log.trim().split('\n').slice(-12).join('\n')}`);
    });
    this.ready = this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'Tawny', version: '0.2' },
        rootUri: pathToFileURL(this.root).href,
        rootPath: this.root,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions:
          this.kind === 'ruby'
            ? { enabledFeatures: { semanticHighlighting: false }, experimentalFeaturesEnabled: false }
            : {},
      },
      120000,
    )
      .then((res) => {
        this.capabilities = (res as { capabilities?: ServerCapabilities }).capabilities || {};
        this.notify('initialized', {});
        this.state = 'ready';
        this.emit('status');
        return this;
      })
      .catch((e) => {
        this.fail(e.message);
        throw e;
      });
    return this.ready;
  }

  fail(msg: string) {
    if (this.state === 'error') return;
    this.state = 'error';
    this.error = msg;
    this.emit('status');
  }

  syncKind() {
    const s = this.capabilities && this.capabilities.textDocumentSync;
    if (typeof s === 'number') return s;
    return (s && s.change) || 1;
  }

  send(msg: Record<string, unknown>) {
    if (!this.proc || !this.proc.stdin.writable) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  request(method: string, params: unknown, timeout = 30000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.send({ method, params });
  }

  onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, sep).toString('ascii'));
      if (!m) {
        this.buf = this.buf.slice(sep + 4);
        continue;
      }
      const len = Number(m[1]);
      if (this.buf.length < sep + 4 + len) return;
      const body = this.buf.slice(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.slice(sep + 4 + len);
      let msg: LspMessage;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg: LspMessage) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id as number); // our request ids are numbers
      if (!p) return;
      this.pending.delete(msg.id as number);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    const reply = (result: unknown) => msg.id !== undefined && this.send({ id: msg.id, result });
    const params = msg.params ?? {};
    switch (msg.method) {
      case 'textDocument/publishDiagnostics':
        this.emit('diagnostics', msg.params);
        return;
      case 'workspace/configuration':
        return reply((params.items || []).map(() => null));
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
        return reply(null);
      case 'workspace/workspaceFolders':
        return reply([{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }]);
      case 'workspace/applyEdit':
        this.emit('applyEdit', params.edit);
        return reply({ applied: true });
      case 'window/showMessageRequest':
        return reply(null);
      case 'window/showMessage':
        if (params.type !== undefined && params.type <= 1) this.emit('message', params.message);
        return;
      case '$/progress': {
        const { token, value } = params;
        if (!value || token === undefined) return;
        if (value.kind === 'begin') this.progress.set(token, value.title || value.message || 'Working');
        else if (value.kind === 'report' && value.message)
          this.progress.set(token, `${`${this.progress.get(token) || ''}`.split(' — ')[0]} — ${value.message}`);
        else if (value.kind === 'end') this.progress.delete(token);
        this.emit('status');
        return;
      }
      default:
        if (msg.id !== undefined) this.send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }

  /** Pull-model diagnostics (TS 7 and ruby-lsp use textDocument/diagnostic instead of pushing). */
  schedulePull(uri: string, delay = 250) {
    if (!this.capabilities || !this.capabilities.diagnosticProvider) return;
    clearTimeout(this.pullTimers.get(uri));
    this.pullTimers.set(
      uri,
      setTimeout(() => this.pull(uri), delay),
    );
    if (this.capabilities.diagnosticProvider.interFileDependencies) {
      for (const other of this.docs.keys()) {
        if (other === uri) continue;
        clearTimeout(this.pullTimers.get(other));
        this.pullTimers.set(
          other,
          setTimeout(() => this.pull(other), delay + 900),
        );
      }
    }
  }

  async pull(uri: string) {
    if (!this.docs.has(uri) || this.state !== 'ready') return;
    const version = this.docs.get(uri);
    try {
      const r = (await this.request('textDocument/diagnostic', { textDocument: { uri } }, 60000)) as {
        kind?: string;
        items?: unknown[];
      } | null;
      if (!r || r.kind === 'unchanged' || this.docs.get(uri) !== version) return;
      this.emit('diagnostics', { uri, diagnostics: r.items || [] });
    } catch {
      /* server busy / doc closed */
    }
  }

  stop() {
    this.state = 'stopped';
    try {
      this.request('shutdown', null, 2000)
        .then(() => this.notify('exit'))
        .catch(() => {});
    } catch {
      /* */
    }
    setTimeout(() => {
      try {
        this.proc?.kill();
      } catch {
        /* */
      }
    }, 2500);
  }

  info() {
    return {
      root: this.root,
      kind: this.kind,
      name: this.spec.name,
      state: this.state,
      error: this.error,
      progress: [...this.progress.values()][0] || null,
      installable: !!this.spec.installable,
    };
  }
}

// ---------------------------------------------------------------- manager

class Lsp extends EventEmitter {
  servers = new Map<string, Server>(); // `${root}|${kind}` -> Server

  constructor(readonly store: Store) {
    super();
  }

  get(root: string, kind: string) {
    const key = `${root}|${kind}`;
    let s = this.servers.get(key);
    if (s && s.state !== 'error') return s;
    if (s && s.state === 'error' && Date.now() - (s.failedAt || 0) < 15000) return s;
    const spec = kind === 'ts' ? tsServerCommand(root) : rubyServerCommand(root, this.store.settings);
    s = new Server(root, kind, spec);
    this.servers.set(key, s);
    const srv = s;
    s.on('status', () => {
      if (srv.state === 'error') srv.failedAt = Date.now();
      this.emit('status');
    });
    s.on('diagnostics', (p: unknown) => this.emit('diagnostics', root, p));
    s.on('applyEdit', (e: unknown) => this.emit('applyEdit', root, e));
    s.on('message', (m: string) => this.emit('message', m));
    if (spec.error) {
      s.fail(spec.error);
      s.failedAt = Date.now();
      return s;
    }
    s.start().catch(() => {});
    this.emit('status');
    return s;
  }

  async open(root: string, file: string, text: string) {
    const languageId = languageIdFor(file);
    const kind = serverKindFor(languageId);
    if (!kind) return null;
    const s = this.get(root, kind);
    if (s.state === 'error') return { kind, error: s.error };
    await s.ready;
    const uri = pathToFileURL(file).href;
    if (s.docs.has(uri)) s.notify('textDocument/didClose', { textDocument: { uri } });
    s.docs.set(uri, 1);
    s.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    s.schedulePull(uri, 50);
    return { kind, uri, syncKind: s.syncKind(), triggers: this.triggers(s) };
  }

  triggers(s: Server) {
    const c = s.capabilities || {};
    return {
      completion: (c.completionProvider && c.completionProvider.triggerCharacters) || ['.'],
      signature: (c.signatureHelpProvider && c.signatureHelpProvider.triggerCharacters) || ['(', ','],
    };
  }

  change(root: string, kind: string, uri: string, version: number, changes: unknown) {
    const s = this.servers.get(`${root}|${kind}`);
    if (!s || s.state !== 'ready' || !s.docs.has(uri)) return;
    s.docs.set(uri, version);
    s.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: changes });
    s.schedulePull(uri);
  }

  save(root: string, kind: string, uri: string, text?: string) {
    const s = this.servers.get(`${root}|${kind}`);
    if (s && s.state === 'ready' && s.docs.has(uri)) {
      s.notify('textDocument/didSave', { textDocument: { uri }, text });
      s.schedulePull(uri, 100);
    }
  }

  close(root: string, kind: string, uri: string) {
    const s = this.servers.get(`${root}|${kind}`);
    if (s && s.state === 'ready' && s.docs.has(uri)) {
      s.docs.delete(uri);
      s.notify('textDocument/didClose', { textDocument: { uri } });
    }
  }

  async request(root: string, kind: string, method: string, params: unknown) {
    const s = this.servers.get(`${root}|${kind}`);
    if (!s || s.state === 'error' || !s.ready) return null;
    await s.ready;
    return s.request(method, params);
  }

  /** Tell servers about files changed on disk (e.g. by an agent). type: 1 created, 2 changed, 3 deleted. */
  filesChanged(root: string, changes: { path: string; type: number }[]) {
    for (const s of this.servers.values()) {
      if (s.root !== root || s.state !== 'ready') continue;
      const mine = changes.filter(
        (c) =>
          serverKindFor(languageIdFor(c.path)) === s.kind ||
          /(^|\/)(tsconfig|jsconfig|package)\.json$|Gemfile(\.lock)?$/.test(c.path),
      );
      if (!mine.length) continue;
      s.notify('workspace/didChangeWatchedFiles', {
        changes: mine.map((c) => ({ uri: pathToFileURL(c.path).href, type: c.type })),
      });
      for (const uri of s.docs.keys()) s.schedulePull(uri, 600);
    }
  }

  status() {
    return [...this.servers.values()].map((s) => s.info());
  }

  restart(root: string, kind: string) {
    const key = `${root}|${kind}`;
    const s = this.servers.get(key);
    if (s) {
      s.stop();
      this.servers.delete(key);
    }
    this.emit('status');
    this.emit('restarted', root, kind);
  }

  /** `gem install ruby-lsp` with the project's Ruby (asdf/rbenv shims respect cwd). */
  installRubyLsp(root: string) {
    return new Promise<string>((resolve, reject) => {
      execFile(
        'gem',
        ['install', 'ruby-lsp', '--no-document'],
        { cwd: root, env: process.env, timeout: 600000 },
        (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim())) : resolve(out)),
      );
    });
  }

  stopRoot(root: string) {
    for (const [k, s] of this.servers)
      if (s.root === root) {
        s.stop();
        this.servers.delete(k);
      }
    this.emit('status');
  }

  dispose() {
    for (const s of this.servers.values()) s.stop();
  }
}

export { Lsp, languageIdFor, serverKindFor };
