// Agent sessions. With tmux: each agent is a tmux session (survives quitting Tawny) and
// Tawny holds a pty attached to it. Without tmux: Tawny owns the shell pty directly.
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import type { PendingPermission, SessionUpdate } from '../shared/chat-model';
import { type AgentSpec, Chat, type ChatStatus, resolveAgent, type SavedChat } from './acp';
import * as G from './git';
import { HookServer } from './hooks';
import type { Store } from './store';
import type { HookPayload } from './types';

const WORKING_MS = 2500; // output within this window => working
const IDLE_MS = 7000; // quiet this long => idle
const NOTIFY_MIN_MS = 6000; // only notify if it worked at least this long
const RESIZE_QUIET_MS = 1500; // ignore redraw output right after a resize/attach
const BUSY_STALE_MS = 30000; // title says busy but nothing printed this long => stuck/waiting, not working
const SCROLLBACK = 400 * 1024;
// agent names: characters from Hacks
const NAMES = [
  'Deborah',
  'Ava',
  'Marcus',
  'Kayla',
  'Jimmy',
  'Damien',
  'Josh',
  'Weebes',
  'Kiki',
  'Randi',
  'Marty',
  'Junior',
  'Winnie',
  'Taylor',
  'Hannah',
  'Wilson',
];
const TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export interface CreateOpts {
  resume?: boolean;
  kind?: SessionKind;
  command?: string;
  session?: { sessionId: string; title?: string | null };
  agent?: string;
}

export type SessionKind = 'agent' | 'terminal' | 'chat';

/** One tab's process: a pty (agent/terminal) or an ACP chat. */
export interface Session {
  id: string;
  prefix: string;
  index: number;
  pty: pty.IPty | null;
  buf: string;
  lastOut: number;
  working: boolean;
  waiting?: boolean;
  workStart: number;
  quietUntil: number;
  cols: number;
  rows: number;
  tmux: boolean;
  kind: SessionKind;
  proc?: string | null;
  agentProc?: boolean;
  hooked?: boolean;
  killed?: boolean;
  tail?: string;
  titleState?: 'idle' | 'busy' | null;
  lastReattach?: number;
  acp?: Chat;
}

class Agents extends EventEmitter {
  creating = new Set<string>(); // ids being created (named, not registered yet)
  sessions = new Map<string, Session>();
  tmux = false;
  timer: ReturnType<typeof setInterval> | null = null;
  procTimer: ReturnType<typeof setInterval> | null = null;
  saveTimer: ReturnType<typeof setTimeout> | null = null;
  lastError: string | null = null;
  hooks: HookServer;

  constructor(readonly store: Store) {
    super();
    this.hooks = new HookServer(path.dirname(store.file));
  }

  async init() {
    this.tmux = this.store.settings.useTmux && process.platform !== 'win32' && (await G.hasTmux());
    try {
      await this.hooks.start();
      this.hooks.on('event', (id: string, _ev: string, state: string, payload: HookPayload) =>
        this.hookEvent(id, state, payload),
      );
    } catch {
      this.hooks.server = null; /* no hooks: heuristics only */
    }
    await this.discover();
    this.restoreChats();
    this.timer = setInterval(() => this.tick(), 1000);
    this.procTimer = setInterval(() => {
      this.pollProcs().catch(() => {});
      this.pollTitles().catch(() => {});
    }, 2000);
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      prefix: s.prefix,
      index: s.index,
      name: this.nameOf(s.id),
      title: (this.store.data.tabNames || {})[s.id] || null,
      proc: s.proc || null,
      summary: (s.acp && s.acp.model.title) || null,
      working: s.working,
      waiting: !!s.waiting,
      tmux: s.tmux,
      kind: s.kind === 'chat' ? 'chat' : this.isTerm(s) ? 'terminal' : 'agent',
    }));
  }

  /** A terminal tab counts as an agent while the agent CLI runs in the foreground (e.g. `claude` typed into a shell). */
  isTerm(s: Session) {
    return s.kind === 'terminal' && !s.agentProc;
  }

  /** Claude's binary is named after its version (2.1.310), so match that too. */
  isAgentProc(proc: string | null) {
    if (!proc) return false;
    const cmd = path.basename(String((this.store.settings.agentCommand || 'claude').trim().split(/\s+/)[0]));
    return proc === cmd || proc === 'claude' || /^\d+\.\d+\.\d+/.test(proc);
  }

  forPrefix(prefix: string) {
    return this.list()
      .filter((s) => s.prefix === prefix)
      .sort((a, b) => a.index - b.index);
  }

  /** Attach to every existing harbor tmux session (from earlier runs or the VS Code extension). */
  async discover() {
    if (!this.tmux) return;
    for (const s of await G.listSessions()) {
      if (this.sessions.has(s.name)) continue;
      const a = this.attachTmux(s.name, undefined, this.kindOf(s.name));
      if ((this.store.data.transcripts || {})[s.name]) a.hooked = true; // has sent hook events before
    }
  }

  nameOf(id: string) {
    return (this.store.data.agentNames || {})[id] || null;
  }

  /** Stable display name for an agent session, unique among all running agents (existing one kept). */
  assignName(id: string): string {
    const names = { ...(this.store.data.agentNames || {}) };
    if (names[id]) return names[id];
    const used = new Set(
      Object.keys(names)
        .filter((k) => this.sessions.has(k) || this.creating.has(k))
        .map((k) => names[k]),
    );
    let n = NAMES.find((x) => !used.has(x));
    for (let i = 2; !n; i++) n = NAMES.map((x) => `${x} ${i}`).find((x) => !used.has(x));
    names[id] = n;
    this.store.set('agentNames', names);
    return n;
  }

  dropNames(match: (id: string) => boolean) {
    for (const field of ['agentNames', 'tabNames'] as const) {
      const names = this.store.data[field] || {};
      const keep = Object.fromEntries(Object.entries(names).filter(([k]) => !match(k)));
      if (Object.keys(keep).length !== Object.keys(names).length) this.store.set(field, keep);
    }
  }

  /** User-chosen tab label; empty resets to the default (agent name / running command). */
  rename(id: string, title: unknown) {
    if (!this.sessions.has(id)) return;
    const names = { ...(this.store.data.tabNames || {}) };
    const label = String(title || '')
      .trim()
      .slice(0, 60);
    if (label) names[id] = label;
    else delete names[id];
    this.store.set('tabNames', names);
    this.emit('changed');
  }

  /** Foreground command of each terminal tab (shown as its tab label). */
  async pollProcs() {
    const terms = [...this.sessions.values()].filter((s) => s.kind === 'terminal');
    if (!terms.length) return;
    let live: Map<string, string> | undefined;
    if (this.tmux) {
      // our pty is just the tmux client; ask tmux what runs in the pane
      try {
        live = new Map((await G.listSessions()).map((t) => [t.name, t.cmd]));
      } catch {
        return;
      }
    }
    let changed = false;
    for (const s of terms) {
      const raw = this.tmux ? live?.get(s.id) : s.pty?.process;
      const proc = raw ? path.basename(String(raw)).replace(/^-/, '') : null;
      if (proc !== s.proc) {
        s.proc = proc;
        changed = true;
      }
      const agent = this.isAgentProc(proc);
      if (agent !== !!s.agentProc) {
        s.agentProc = agent;
        if (agent) this.assignName(s.id);
        else {
          s.working = false;
          s.waiting = false;
          s.titleState = null;
        }
        changed = true;
      }
    }
    if (changed) this.emit('changed');
  }

  /** tmux swallows title escapes, so unhooked agents (e.g. started before hooks) read Claude's busy/idle glyph from the pane title. */
  async pollTitles() {
    if (!this.tmux) return;
    const todo = [...this.sessions.values()].filter((s) => !this.isTerm(s) && !s.hooked);
    if (!todo.length) return;
    const titles = await G.paneTitles();
    for (const s of todo) if (titles.has(s.id)) this.trackTitle(s, `\x1b]0;${titles.get(s.id)}\x07`);
  }

  splitName(name: string) {
    const i = name.lastIndexOf('_');
    return { prefix: name.slice(0, i), index: Number(name.slice(i + 1)) || 1 };
  }

  spawnPty(file: string, args: string[], cwd?: string) {
    return pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: cwd || os.homedir(),
      // Tawny has its own editor: keep claude from auto-attaching to a VS Code window open on the same folder
      env: {
        CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
        ...(process.env as Record<string, string>),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TMUX: '',
      },
    });
  }

  register(id: string, p: pty.IPty | null, extra: Pick<Session, 'tmux' | 'kind'> & Partial<Session>): Session {
    const { prefix, index } = this.splitName(id);
    const s: Session = {
      id,
      prefix,
      index,
      pty: p,
      buf: '',
      lastOut: 0,
      working: false,
      workStart: 0,
      quietUntil: Date.now() + RESIZE_QUIET_MS,
      cols: 120,
      rows: 32,
      ...extra,
    };
    this.sessions.set(id, s);
    if (s.kind !== 'terminal') this.assignName(id);
    if (p) this.bind(s, p);
    this.emit('changed');
    return s;
  }

  bind(s: Session, p: pty.IPty) {
    s.pty = p;
    s.quietUntil = Date.now() + RESIZE_QUIET_MS;
    p.onData((d) => {
      this.trackTitle(s, d);
      s.buf += d;
      if (s.buf.length > SCROLLBACK) s.buf = s.buf.slice(s.buf.length - SCROLLBACK);
      if (Date.now() > s.quietUntil) s.lastOut = Date.now();
      this.emit('data', s.id, d);
    });
    p.onExit(() => this.onExit(s.id, p));
  }

  /** state: 'working' | 'waiting' (needs your input) | 'idle' */
  setState(s: Session, state: string) {
    const working = state === 'working',
      waiting = state === 'waiting';
    if (s.working === working && !!s.waiting === waiting) return;
    const wasWorking = s.working,
      now = Date.now();
    s.working = working;
    s.waiting = waiting;
    if (working && !wasWorking) s.workStart = now;
    else if (waiting) this.emit('waiting', s.id);
    else if (wasWorking && !working && now - s.workStart >= NOTIFY_MIN_MS) this.emit('finished', s.id);
    this.emit('changed');
  }

  /** Exact state from Claude Code hooks; once an agent has sent one, heuristics stop applying to it. */
  hookEvent(id: string, state: string, payload: HookPayload = {}) {
    const s = this.sessions.get(id);
    if (!s || s.kind === 'terminal' || s.kind === 'chat') return;
    s.hooked = true;
    this.trackTranscript(id, payload.transcript_path);
    this.setState(s, state);
  }

  /** Remember where Claude Code keeps this agent's conversation, so closing the tab can delete it. */
  trackTranscript(id: string, file: unknown) {
    const t = this.store.data.transcripts || {};
    if (typeof file !== 'string' || !file.endsWith('.jsonl') || t[id] === file) return;
    this.store.set('transcripts', { ...t, [id]: file });
  }

  /** Delete the Claude Code conversation (and its sidecar dir) of a closed agent. */
  dropTranscript(match: (id: string) => boolean) {
    const t = this.store.data.transcripts || {};
    const root = path.join(os.homedir(), '.claude', 'projects') + path.sep;
    for (const [id, file] of Object.entries(t)) {
      if (!match(id)) continue;
      if (path.resolve(file).startsWith(root)) {
        try {
          fs.rmSync(file, { force: true });
          fs.rmSync(file.slice(0, -'.jsonl'.length), { recursive: true, force: true });
        } catch {
          /* */
        }
      }
      delete t[id];
    }
    this.store.set('transcripts', { ...t });
  }

  /** Claude Code puts a state glyph in the terminal title: ✳ idle, spinner glyph (◐◑◒◓, braille) busy. */
  trackTitle(s: Session, d: string) {
    const text = (s.tail || '') + d;
    s.tail = text.slice(-128);
    let last: string | undefined;
    for (const m of text.matchAll(TITLE_RE)) last = m[1];
    if (last === undefined) return;
    if (last.startsWith('✳')) {
      if (s.hooked && s.titleState === 'busy' && s.working) this.setState(s, 'idle'); // Stop doesn't fire on interrupt
      s.titleState = 'idle';
    } else if (/^[◐◑◒◓\u2800-\u28ff]/u.test(last)) s.titleState = 'busy';
  }

  kindOf(name: string): SessionKind {
    if ((this.store.data.transcripts || {})[name]) return 'agent'; // hook events only come from agents; beats a stale terminal entry
    return (this.store.data.terminalSessions || []).includes(name) ? 'terminal' : 'agent';
  }

  /** Session names get reused (nextName), so a dead terminal must not leave its name marked as one. */
  dropTerminals(match: (id: string) => boolean) {
    const t = this.store.data.terminalSessions || [];
    if (t.some(match))
      this.store.set(
        'terminalSessions',
        t.filter((n) => !match(n)),
      );
  }

  attachTmux(name: string, cwd?: string, kind: SessionKind = 'agent') {
    if (this.tmux) {
      try {
        require('node:child_process').execFileSync('tmux', ['set-option', '-t', name, 'window-size', 'latest']);
      } catch {
        /* old tmux */
      }
    }
    const p = this.spawnPty('tmux', ['attach-session', '-t', name], cwd);
    return this.register(name, p, { tmux: true, kind });
  }

  async onExit(id: string, p: pty.IPty) {
    const s = this.sessions.get(id);
    if (!s || s.pty !== p) return;
    if (s.tmux && !s.killed) {
      // client died but the tmux session may still be alive -> reattach
      const alive = (await G.listSessions()).some((x) => x.name === id);
      const flapping = Date.now() - (s.lastReattach || 0) < 3000;
      if (alive && !flapping) {
        s.lastReattach = Date.now();
        const np = this.spawnPty('tmux', ['attach-session', '-t', id]);
        this.bind(s, np);
        try {
          np.resize(s.cols, s.rows);
        } catch {
          /* */
        }
        return;
      }
    }
    this.sessions.delete(id);
    this.dropNames((k) => k === id);
    this.dropTerminals((k) => k === id);
    this.emit('exit', id);
    this.emit('changed');
  }

  nextName(prefix: string) {
    const used = this.forPrefix(prefix).map((s) => s.index);
    return `${prefix}_${used.length ? Math.max(...used) + 1 : 1}`;
  }

  /** Start a new agent in a worktree. */
  async create(worktreePath: string, opts: CreateOpts = {}) {
    try {
      const s = await this._create(worktreePath, opts);
      if (this.lastError) {
        this.lastError = null;
        this.emit('changed');
      }
      return s;
    } catch (e) {
      this.lastError = /posix_spawn/i.test(e.message)
        ? `Couldn't start a terminal (${e.message}). Run: chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`
        : e.message;
      this.emit('changed');
      throw new Error(this.lastError ?? 'agent failed');
    }
  }

  async _create(worktreePath: string, { resume = false, kind = 'agent', command, session, agent }: CreateOpts = {}) {
    const st = this.store.settings;
    const terminal = kind === 'terminal';
    const prefix = G.sessionPrefix(worktreePath);
    const name = this.nextName(prefix);
    this.dropNames((k) => k === name); // stale name from a session that died while Tawny was closed
    this.creating.add(name);
    try {
      if (kind === 'chat')
        return await this._startChat(
          worktreePath,
          name,
          session && { sessionId: session.sessionId, title: session.title, started: true },
          resolveAgent(st, agent),
        );
      return await this._start(worktreePath, name, { resume, terminal, kind, command });
    } finally {
      this.creating.delete(name);
    }
  }

  /** A chat tab: an ACP session in an adapter subprocess instead of a pty. Working/waiting/idle come from the protocol.
   *  `saved`: a conversation to bring back ({sessionId, started, title, usage}), after a restart or from the history picker. */
  _startChat(worktreePath: string, name: string, saved: SavedChat | undefined, agent: AgentSpec) {
    if (
      saved &&
      saved.sessionId &&
      [...this.sessions.values()].some((x) => x.acp && x.acp.sessionId === saved.sessionId)
    )
      throw new Error('That chat is already open');
    this.assignName(name);
    this.dropTerminals((k) => k === name);
    const chat = new Chat({ id: name, cwd: worktreePath, dataDir: path.dirname(this.store.file), saved, agent });
    const s = this.register(name, null, { tmux: false, kind: 'chat', acp: chat, hooked: true });
    chat.on('state', (state: string) => this.setState(s, state));
    chat.on('status', () => this.emit('changed'));
    chat.on('persist', () => this.emit('changed')); // title/usage moved; the sidebar shows the title
    chat.on('update', (e: { seq: number; update: SessionUpdate }) => this.emit('chat', 'chat:update', name, e));
    chat.on('permission', (r: PendingPermission) => this.emit('chat', 'chat:permission', name, r));
    chat.on('permission-done', (reqId: number) => this.emit('chat', 'chat:permission-done', name, reqId));
    chat.on('status', (st: { status: ChatStatus; error: string | null; auth: unknown }) =>
      this.emit('chat', 'chat:status', name, st),
    );
    chat.on('file-request', (r: { reqId: number; path: string }) => this.emit('chat', 'chat:read-file', name, r));
    chat.on('persist', (d: SavedChat) => this.saveChat(name, d));
    chat.start(); // status events report the outcome
    return s;
  }

  /** What a chat needs to come back after a restart; written to disk a moment later (title/usage change often). */
  saveChat(id: string, d: SavedChat) {
    this.store.data.chatSessions = { ...(this.store.data.chatSessions || {}), [id]: d };
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.store.save(), 1500);
  }

  forgetChat(id: string) {
    const all = this.store.data.chatSessions || {};
    if (!(id in all)) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const { [id]: _gone, ...rest } = all;
    this.store.set('chatSessions', rest);
  }

  /** Chats survive a Tawny restart: respawn each adapter and `session/load` its conversation. */
  restoreChats() {
    for (const [id, d] of Object.entries((this.store.data.chatSessions || {}) as Record<string, SavedChat>)) {
      if (this.sessions.has(id)) continue;
      if (!d || !d.cwd || !fs.existsSync(d.cwd)) {
        this.forgetChat(id);
        continue;
      }
      let agent: AgentSpec;
      try {
        agent = resolveAgent(this.store.settings, d.agent || 'claude');
      } catch {
        this.forgetChat(id);
        continue;
      } // its acpAgents entry is gone
      this._startChat(d.cwd, id, d, agent);
    }
  }

  /** Chats that are mid-turn or waiting for an answer: quitting would lose that work. */
  busyChats() {
    return [...this.sessions.values()].filter((s) => s.acp && (s.working || s.waiting)).length;
  }

  /** The agent's saved conversations for a worktree that aren't open as tabs. */
  async chatHistory(worktreePath: string) {
    const open = new Set([...this.sessions.values()].flatMap((s) => (s.acp ? [s.acp.sessionId] : [])));
    return (await Chat.list(worktreePath, path.dirname(this.store.file), resolveAgent(this.store.settings)))
      .filter((x) => !open.has(x.sessionId))
      .slice(0, 50);
  }

  /** Close the chat tab (the conversation stays on disk) and continue the same conversation in a terminal agent tab. */
  async chatToTerminal(id: string) {
    const s = this.sessions.get(id);
    const chat = s && s.acp;
    if (!chat || !chat.spec.builtin) throw new Error('Only Claude chats can continue in a terminal');
    if (!chat.started || !/^[\w-]+$/.test(chat.sessionId || '')) throw new Error('Nothing to resume yet');
    if (s.working || s.waiting) throw new Error('Wait for the chat to finish first');
    const { cwd, sessionId } = chat;
    await chat.close({ keep: true });
    this.sessions.delete(id);
    this.forgetChat(id);
    this.dropNames((k) => k === id);
    this.emit('exit', id);
    this.emit('changed');
    return this.create(cwd, { command: `claude --resume ${sessionId}` });
  }

  /** Sign in to a chat's agent: a terminal method runs the agent's login command in a terminal tab (the chat stays; Retry afterwards); an agent method just calls `authenticate`. */
  async chatAuth(id: string, methodId: string) {
    const s = this.sessions.get(id);
    const chat = s && s.acp;
    if (!chat) throw new Error('No such chat');
    const m = chat.authList().find((x) => x.id === methodId);
    if (!m) throw new Error('No such sign-in method');
    if (!m.terminal) return chat.authenticate(methodId).then(() => null);
    const launch = chat.authLaunch(methodId);
    const { file, args } = launch;
    const env = launch.env as Record<string, string | undefined>;
    const q = (x: unknown) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const keys = Object.keys(env).filter((k) => env[k] !== process.env[k]);
    const command = `${keys.map((k) => `${k}=${q(env[k])} `).join('')}exec ${[file, ...args].map(q).join(' ')}`;
    return (await this.create(chat.cwd, { command })).id;
  }

  chat(id: string) {
    const s = this.sessions.get(id);
    return s && s.acp;
  }

  async _start(
    worktreePath: string,
    name: string,
    {
      resume,
      terminal,
      kind,
      command: given,
    }: { resume: boolean; terminal: boolean; kind: SessionKind; command?: string },
  ) {
    const st = this.store.settings;
    const command = terminal
      ? ''
      : this.hooks.wrap(given || (resume && st.resumeCommand) || st.agentCommand || '', name, this.assignName(name));
    const hooked = command.includes(`HARBOR_AGENT_ID=${name} `); // state comes from hooks only, never from output (typing echoes)
    if (terminal) this.store.set('terminalSessions', [...(this.store.data.terminalSessions || []), name].slice(-500));
    else {
      this.dropTerminals((k) => k === name);
      this.remember(name);
    }
    if (this.tmux) {
      await G.createSession(name, worktreePath, command);
      const s = this.attachTmux(name, worktreePath, kind);
      s.hooked = hooked;
      return s;
    }
    const shell =
      process.platform === 'win32' ? process.env.COMSPEC || 'powershell.exe' : process.env.SHELL || '/bin/zsh';
    const p = this.spawnPty(shell, process.platform === 'win32' ? [] : ['-l'], worktreePath);
    const s = this.register(name, p, { tmux: false, kind, hooked });
    if (command) setTimeout(() => p.write(`${command}\r`), 300);
    return s;
  }

  /** Open agents for a worktree: existing ones, or a new (resumed if it had agents before) one. */
  async ensure(worktreePath: string) {
    const prefix = G.sessionPrefix(worktreePath);
    const have = this.forPrefix(prefix);
    if (have.length) return have[0];
    const resume = (this.store.data.knownSessions || []).some((n) => n.startsWith(`${prefix}_`));
    return this.create(worktreePath, { resume });
  }

  remember(name: string) {
    const k = new Set(this.store.data.knownSessions || []);
    k.add(name);
    this.store.set('knownSessions', [...k].slice(-500));
  }

  forget(prefix: string) {
    this.store.set(
      'knownSessions',
      (this.store.data.knownSessions || []).filter((n) => !n.startsWith(`${prefix}_`)),
    );
  }

  write(id: string, data: string) {
    const s = this.sessions.get(id);
    if (s && s.pty) s.pty.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id);
    if (!s || !s.pty || !cols || !rows || (s.cols === cols && s.rows === rows)) return;
    s.cols = cols;
    s.rows = rows;
    s.quietUntil = Date.now() + RESIZE_QUIET_MS;
    try {
      s.pty.resize(cols, rows);
    } catch {
      /* exited */
    }
  }

  buffer(id: string) {
    const s = this.sessions.get(id);
    return s ? s.buf : '';
  }

  async kill(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.killed = true;
    if (s.acp) {
      await s.acp.close();
      this.forgetChat(id);
    }
    if (s.tmux) await G.killSession(id);
    try {
      s.pty && s.pty.kill();
    } catch {
      /* */
    }
    this.sessions.delete(id);
    this.dropNames((k) => k === id);
    this.dropTerminals((k) => k === id);
    this.dropTranscript((k) => k === id);
    this.emit('exit', id);
    this.emit('changed');
  }

  async killPrefix(prefix: string) {
    for (const s of this.forPrefix(prefix)) await this.kill(s.id);
    this.dropNames((k) => k.startsWith(`${prefix}_`));
    this.dropTerminals((k) => k.startsWith(`${prefix}_`));
    this.dropTranscript((k) => k.startsWith(`${prefix}_`));
    // also sessions not attached here
    if (this.tmux)
      for (const t of await G.listSessions()) if (t.name.startsWith(`${prefix}_`)) await G.killSession(t.name);
  }

  tick() {
    const now = Date.now();
    let changed = false;
    for (const s of this.sessions.values()) {
      if (this.isTerm(s) || s.kind === 'chat') continue; // plain shells: no working/finished tracking; chats report state themselves
      if (s.hooked) continue;
      const quiet = now - s.lastOut;
      if (s.titleState) {
        // title-aware agent: trust its own busy/idle signal, not raw output (status-line redraws, hints)
        const busy = s.titleState === 'busy' && quiet < BUSY_STALE_MS;
        if (busy && !s.working) {
          s.working = true;
          s.workStart = now;
          changed = true;
        } else if (!busy && s.working) {
          s.working = false;
          changed = true;
          if (now - s.workStart >= NOTIFY_MIN_MS) this.emit('finished', s.id);
        }
        continue;
      }
      if (!s.working && quiet < WORKING_MS) {
        s.working = true;
        s.workStart = now;
        changed = true;
      } else if (s.working && quiet > IDLE_MS) {
        s.working = false;
        changed = true;
        if (now - s.workStart - IDLE_MS >= NOTIFY_MIN_MS) this.emit('finished', s.id);
      }
    }
    if (changed) this.emit('changed');
  }

  /** Detach everything (tmux sessions keep running). */
  dispose() {
    if (this.timer) clearInterval(this.timer);
    if (this.procTimer) clearInterval(this.procTimer);
    this.hooks.dispose();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      try {
        this.store.save();
      } catch {
        /* */
      }
    }
    for (const s of this.sessions.values()) {
      s.killed = true;
      if (s.acp) s.acp.close({ keep: true }).catch(() => {});
      try {
        s.pty && s.pty.kill();
      } catch {
        /* */
      }
    }
  }
}

export { Agents };
