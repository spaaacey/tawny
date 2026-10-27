import { emptyModel, fold, type SessionUpdate, type ChatModel as SharedModel } from '../../../../shared/chat-model';
import { Editor, H } from '../../lib/legacy';
import type { AgentMeta, AuthMethod, ChatEvent, ChatModel, Image, Msg, Pick } from './types';

/** Commands the app runs itself; agents (Claude Code's ACP adapter) don't advertise them. */
const LOCAL_COMMANDS = [{ name: 'clear', description: 'Clear the conversation and start a new one' }];

/**
 * Per-chat state: main keeps the authoritative transcript model; this folds live updates onto the history it fetched
 * (chat-model.ts is shared). React reads it through `useSyncExternalStore` on `version`.
 */
export class ChatController {
  model = emptyModel() as unknown as ChatModel;
  seq = 0;
  ready = false;
  buf: ChatEvent[] = [];
  doneReqs = new Set<number>();
  status = 'starting';
  error: string | null = null;
  state = 'idle';
  agent: AgentMeta = { name: 'claude', label: 'Claude', builtin: true };
  auth: AuthMethod[] = [];
  running = false;
  queue: Msg[] = [];
  open: Record<string, boolean> = {};
  note = '';
  text = '';
  /** where to put the caret after the next render (set when the text changes under the user) */
  caret: number | null = null;
  images: Image[] = [];
  mentions = new Map<string, string>();
  pick: Pick | null = null;
  stick = true;
  top = 0;
  focusTick = 0;
  version = 0;
  private raf = 0;
  private listeners = new Set<() => void>();

  constructor(readonly id: string) {
    H.chatHistory(id)
      .then((h) => {
        this.seq = h.seq;
        this.model = h.model as unknown as typeof this.model; // main-side ChatModel is looser than the UI view of it
        this.status = h.status;
        this.error = h.error;
        this.state = h.state;
        this.agent = h.agent;
        this.auth = h.auth || [];
        this.ready = true;
        for (const e of this.buf) this.applyEvent(e);
        this.buf = [];
        this.schedule();
      })
      .catch((e: Error) => {
        this.status = 'error';
        this.error = e.message;
        this.ready = true;
        this.schedule();
      });
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  /** Re-render now (user input) */
  emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** Re-render next frame (streamed updates coalesce) */
  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.emit();
    });
  }

  info() {
    return window.harborApp?.agentInfo(this.id) ?? null;
  }
  get busy() {
    const i = this.info();
    return this.running || this.state !== 'idle' || !!i?.working || !!i?.waiting;
  }

  // ---------------------------------------------------------------- events

  dispatch(e: ChatEvent) {
    if (this.ready) this.applyEvent(e);
    else this.buf.push(e);
  }

  private applyEvent(e: ChatEvent) {
    if (e.k === 'u') {
      if (e.seq <= this.seq) return;
      this.seq = e.seq;
      fold(this.model as unknown as SharedModel, e.update as SessionUpdate);
    } else if (e.k === 'p') {
      if (!this.doneReqs.has(e.req.reqId) && !this.model.pending.some((r) => r.reqId === e.req.reqId))
        this.model.pending.push(e.req);
    } else if (e.k === 'd') {
      this.doneReqs.add(e.reqId);
      this.model.pending = this.model.pending.filter((r) => r.reqId !== e.reqId);
    } else if (e.k === 's') {
      this.status = e.status;
      this.error = e.error;
      this.auth = e.auth || [];
    }
    this.schedule();
  }

  // ---------------------------------------------------------------- composer

  setText(text: string, caret?: number) {
    this.text = text;
    if (caret != null) this.caret = caret;
    this.emit();
  }

  /** Put `text` (e.g. an @file#L3-5 reference) in the composer. */
  insert(text: string) {
    const ref = /^@(\S+?)(#L\d+(-\d+)?)?\s*$/.exec(text.trim());
    if (ref) this.mentions.set(text.trim(), Editor().absPath(ref[1]));
    const sep = this.text && !/\s$/.test(this.text) ? ' ' : '';
    this.text += `${sep}${text}${/\s$/.test(text) ? '' : ' '}`;
    this.caret = this.text.length;
    this.emit();
  }

  /** Reference alone fills the composer, with a message it sends at once. */
  ask(ref: string, msg: string) {
    this.insert(ref);
    if (!msg) return;
    this.text += msg;
    this.send();
  }

  focus() {
    this.focusTick++;
    this.emit();
  }

  flash(msg: string) {
    this.note = msg;
    this.schedule();
  }

  send() {
    const text = this.text.trim();
    if ((!text && !this.images.length) || this.status !== 'ready') return;
    this.pick = null;
    if (text === '/clear') {
      this.text = '';
      this.queue = [];
      this.doneReqs.clear();
      H.chatClear(this.id).catch((e: Error) => this.flash(e.message));
      this.emit();
      return;
    }
    const msg = { text, blocks: this.promptBlocks(text) };
    this.note = '';
    this.text = '';
    this.images = [];
    this.mentions.clear();
    this.stick = true;
    if (this.busy) {
      this.queue.push(msg);
      this.emit();
      return;
    }
    this.run(msg);
  }

  /** Text with each known `@path` as a resource_link between the text parts, then the pasted images. */
  private promptBlocks(text: string) {
    const blocks: unknown[] = [];
    let last = 0;
    const flush = (to: number) => {
      if (to > last) blocks.push({ type: 'text', text: text.slice(last, to) });
    };
    for (const m of text.matchAll(/@\S+/g)) {
      const hit = this.mentions.has(m[0]) ? m[0] : m[0].replace(/[,.;:)!?]+$/, '');
      if (!this.mentions.has(hit)) continue;
      flush(m.index);
      const abs = this.mentions.get(hit) as string;
      blocks.push({ type: 'resource_link', name: hit.slice(1), uri: `file://${encodeURI(abs)}` });
      last = m.index + hit.length;
    }
    flush(text.length);
    for (const im of this.images) blocks.push({ type: 'image', data: im.data, mimeType: im.mimeType });
    return blocks;
  }

  private async run(msg: Msg) {
    this.running = true;
    this.emit();
    try {
      await H.chatPrompt(this.id, msg.blocks);
    } catch (e) {
      this.flash((e as Error).message);
    }
    this.running = false;
    const next = this.queue.shift();
    if (next && this.status === 'ready') this.run(next);
    else this.emit();
  }

  stop() {
    this.queue = [];
    H.chatCancel(this.id);
    this.emit();
  }

  answer(reqId: number, optionId: string | null) {
    this.model.pending = this.model.pending.filter((r) => r.reqId !== reqId);
    this.doneReqs.add(reqId);
    H.chatAnswer(this.id, reqId, optionId);
    this.focus();
  }

  /** Number keys pick the n-th option of the oldest pending permission. */
  answerKey(n: number) {
    const req = this.model.pending[0];
    const opt = req?.options[n - 1];
    if (!opt) return false;
    this.answer(req.reqId, opt.optionId);
    return true;
  }

  addImages(files: File[]) {
    for (const f of files) {
      const r = new FileReader();
      r.onload = () => {
        this.images.push({ mimeType: f.type, data: String(r.result).split(',')[1] });
        this.emit();
      };
      r.readAsDataURL(f);
    }
  }

  setConfig(cfgId: string, value: string) {
    H.chatSetConfig(this.id, cfgId, value).catch((err: Error) => this.flash(err.message));
  }

  // ---------------------------------------------------------------- mentions

  /** Recompute the `@file` / `/command` picker from the text before the caret. */
  updateMention(caret: number) {
    const head = this.text.slice(0, caret);
    const sl = /^\/([^\s/]*)$/.exec(head);
    if (sl) return this.updateCommands(sl[1], caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(head);
    if (!m) return this.closeMention();
    const E = Editor();
    const token = ++this.mentionTok;
    E.loadFileIndex().then(() => {
      if (token !== this.mentionTok) return;
      const q = m[2];
      const items = E.fileMatches(q).slice(0, 8);
      if (!items.length) return this.closeMention();
      this.pick = { kind: 'file', items, sel: 0, start: caret - q.length - 1, end: caret };
      this.emit();
    });
  }
  private mentionTok = 0;

  /** `/` at the start of the composer lists the agent's commands (available_commands_update): prefix matches first. */
  private updateCommands(q: string, end: number) {
    const lq = q.toLowerCase();
    const rank = (c: { name: string }) => {
      const n = c.name.toLowerCase();
      return n.startsWith(lq) ? 0 : n.includes(lq) ? 1 : 2;
    };
    const agentCmds = this.model.commands || [];
    const items = [...agentCmds, ...LOCAL_COMMANDS.filter((l) => !agentCmds.some((c) => c.name === l.name))]
      .filter((c) => rank(c) < 2)
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .slice(0, 8);
    if (!items.length) return this.closeMention();
    this.pick = { kind: 'cmd', items, sel: 0, start: 0, end };
    this.emit();
  }

  closeMention() {
    this.mentionTok++;
    if (!this.pick) return;
    this.pick = null;
    this.emit();
  }

  movePick(delta: number) {
    const p = this.pick;
    if (!p) return;
    p.sel = (p.sel + delta + p.items.length) % p.items.length;
    this.emit();
  }

  chooseMention(i: number) {
    const p = this.pick;
    if (!p) return;
    let ins: string;
    if (p.kind === 'cmd') {
      ins = `/${p.items[i].name} `;
    } else {
      const r = p.items[i];
      ins = `@${r.f} `;
      this.mentions.set(`@${r.f}`, Editor().absPath(r.f));
    }
    this.text = this.text.slice(0, p.start) + ins + this.text.slice(p.end);
    this.caret = p.start + ins.length;
    this.pick = null;
    this.mentionTok++;
    this.emit();
  }

  setOpen(id: string, open: boolean) {
    this.open[id] = open;
  }
}
