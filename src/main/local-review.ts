// Local review (docs/local-review-plan.md): /code-review on the worktree's own branch changes, run in a dedicated
// review chat, with the findings kept per worktree as a fix list. Items go open -> sent (handed to a fix chat) ->
// fixed (the fix chat runs `tawny review resolve`), or dismissed.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as z from 'zod';
import { resolveCommand } from '../shared/local-review';
import type { LocalReviewFiles, LocalReviewRun, LocalReviewState, PrEffort, ReviewItem } from '../shared/types';
import type { ReviewChatCtx } from './acp';
import type { Registry } from './cli/registry';
import * as G from './git';
import { readText } from './pr-agent';
import { captureAnchor, type ParsedFinding, parseProposal, parseReportFindings, remapped } from './review-core';
import type { Store } from './store';

/** Stored per worktree dir (`store.data.localReview`). */
export interface LocalReviewEntry {
  /** absent: the default base (main, else the repo's default branch) */
  base?: string;
  runs: LocalReviewRun[];
  reviewChats: string[];
  items: ReviewItem[];
}

const EFFORTS: PrEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const WORKTREE_NOTE = 'Include uncommitted and untracked working-tree changes.';
/** How long a new review chat may take to become ready before its /code-review is dropped. */
const READY_TIMEOUT_MS = 5 * 60_000;

/** The chat side LocalReview needs (main wires it to Agents). */
export interface ReviewChats {
  /** Start a chat tab in `dir`; resolves with its id. Must call `reviewContext` synchronously (Agents.create does). */
  create(dir: string): Promise<string>;
  /** The chat's status now and a way to follow it; null once it's gone. */
  chat(id: string): {
    status: string;
    on(ev: 'status', fn: (st: { status: string }) => void): unknown;
    off(ev: 'status', fn: (st: { status: string }) => void): unknown;
    prompt(blocks: { type: 'text'; text: string }[]): Promise<unknown>;
  } | null;
}

const git = (dir: string, args: string[]) => G.git(dir, args).then((s: string) => s.trim());
const ok = (p: Promise<unknown>) =>
  p.then(
    () => true,
    () => false,
  );

/** System prompt text appended to the claude_code preset in a review chat. */
export function reviewPrompt(base: string, mergeBase: string) {
  return [
    "This chat reviews the current worktree's own branch changes (a local review, no GitHub PR).",
    `- Base: ${base}. Merge-base: ${mergeBase.slice(0, 12)}. The changes under review are ${mergeBase.slice(0, 12)}..working tree: the branch's commits plus uncommitted and untracked files.`,
    '- Review only: never edit, create or delete files, never commit or push. Report findings; the user chooses which ones another chat fixes.',
    '- To propose a comment on a line (optionally with replacement text for the lines), run:',
    "tawny review propose-comment --path <file> --line <n> [--start-line <n>] [--suggestion-file <file>] <<'EOF'",
    '<comment in Markdown>',
    'EOF',
  ].join('\n');
}

export class LocalReview extends EventEmitter {
  /** A review chat being created: the next reviewContext call for `dir` claims it (sets `chatId`). */
  private pending: { dir: string; chatId?: string } | null = null;

  constructor(
    private store: Store,
    private chats: ReviewChats,
    /** worktrees where local review is off (PR review sessions have their own review chat) */
    private disabled: (dir: string) => boolean = () => false,
  ) {
    super();
  }

  private entry(dir: string): LocalReviewEntry | undefined {
    return this.store.data.localReview?.[dir];
  }

  private ensure(dir: string): LocalReviewEntry {
    const all = (this.store.data.localReview ??= {});
    return (all[dir] ??= { runs: [], reviewChats: [], items: [] });
  }

  private changed(dir: string) {
    this.store.save();
    this.emit('changed', dir);
  }

  // ------------------------------------------------------------ base

  /** The base the review diffs against: the one the user set, else main, else the repo's default branch. */
  async base(dir: string): Promise<string> {
    const set = this.entry(dir)?.base;
    if (set) return set;
    if (await ok(git(dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']))) return 'main';
    const remote = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
    if (remote) {
      const local = remote.replace(/^origin\//, '');
      return (await ok(git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`]))) ? local : remote;
    }
    if (await ok(git(dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/master']))) return 'master';
    return 'main';
  }

  private async mergeBase(dir: string, base: string): Promise<string | null> {
    return git(dir, ['merge-base', base, 'HEAD']).catch(() => null);
  }

  /** Set the base (a branch or commit). Empty means back to the default. */
  async setBase(dir: string, ref: string) {
    const r = ref.trim();
    if (r) {
      if (r.startsWith('-')) throw new Error(`Not a branch or commit: ${r}`);
      if (!(await ok(git(dir, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]))))
        throw new Error(`Not a branch or commit: ${r}`);
    }
    const e = this.ensure(dir);
    if (r) e.base = r;
    else delete e.base;
    this.changed(dir);
    return this.state(dir);
  }

  // ------------------------------------------------------------ reads

  /** Base, merge-base, items remapped to the current files, runs and review chats. */
  async state(dir: string): Promise<LocalReviewState> {
    const base = await this.base(dir);
    const e = this.entry(dir);
    return {
      base,
      mergeBase: await this.mergeBase(dir, base),
      items: this.items(dir),
      runs: e?.runs ?? [],
      reviewChats: e?.reviewChats ?? [],
    };
  }

  /** The items with their lines remapped to the worktree's files (copies; the store keeps the last saved lines). */
  items(dir: string): ReviewItem[] {
    const files = new Map<string, string | null>();
    const text = (p: string) => {
      if (!files.has(p)) files.set(p, readText(dir, p));
      return files.get(p) ?? null;
    };
    return (this.entry(dir)?.items ?? []).map((it) => {
      const t = text(it.path);
      return t == null ? it : remapped(it, t);
    });
  }

  /** What the branch changes: name-status of merge-base..working tree, plus untracked files (status '?'). */
  async files(dir: string): Promise<LocalReviewFiles> {
    const base = await this.base(dir);
    const mergeBase = await this.mergeBase(dir, base);
    if (!mergeBase) throw new Error(`No merge-base with ${base}`);
    const out = await G.git(dir, ['diff', '--name-status', '-z', '-M', mergeBase]);
    const parts = out.split('\0');
    const files: LocalReviewFiles['files'] = [];
    for (let i = 0; i < parts.length; i++) {
      const st = parts[i];
      if (!st) continue;
      if (st[0] === 'R' || st[0] === 'C') {
        const orig = parts[++i];
        files.push({ path: parts[++i], status: st[0], orig });
      } else files.push({ path: parts[++i], status: st[0] });
    }
    const untracked = await G.git(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
    for (const p of untracked.split('\0')) if (p) files.push({ path: p, status: '?' });
    return { base, mergeBase, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  }

  // ------------------------------------------------------------ items

  /** Store new items, skipping known ids and repeats of an open item (same path, remapped line and body). */
  private add(dir: string, found: ParsedFinding[], runId?: string, source?: ReviewItem['source']): ReviewItem[] {
    const e = this.ensure(dir);
    const now = this.items(dir);
    const added: ReviewItem[] = [];
    for (const p of found) {
      if (e.items.some((x) => x.id === p.id)) continue;
      if (now.some((x) => x.status === 'open' && x.path === p.path && x.line === p.line && x.body === p.body)) continue;
      const t = readText(dir, p.path);
      const anchor = t == null ? undefined : captureAnchor(t, p.line);
      const item: ReviewItem = {
        ...p,
        source: source ?? p.source,
        side: 'RIGHT',
        anchor,
        status: 'open',
        runId,
        createdAt: Date.now(),
      };
      e.items.push(item);
      added.push(item);
    }
    if (added.length) this.changed(dir);
    return added;
  }

  /** The user's own comment from the gutter (RIGHT side, optional suggestion). */
  addUserItem(dir: string, a: { path: string; line: number; startLine?: number; body: string; suggestion?: string }) {
    const p = parseProposal({
      path: a.path,
      line: a.line,
      start_line: a.startLine,
      body: a.body,
      suggestion: a.suggestion,
    });
    const item = this.add(dir, [{ ...p, id: `u-${randomBytes(4).toString('hex')}` }], undefined, 'user')[0];
    if (!item) throw new Error('An open item with the same text is already on that line');
    return item;
  }

  private stored(dir: string, id: string) {
    const it = this.entry(dir)?.items.find((x) => x.id === id);
    if (!it) throw new Error(`Unknown review item ${id}`);
    return it;
  }

  /** Edit an item's body / suggestion ('' clears it), or move it (`line`, `startLine`): the anchor is re-captured from the file. */
  editItem(
    dir: string,
    id: string,
    e: { body?: string; detail?: string; suggestion?: string; line?: number; startLine?: number },
  ) {
    const it = this.stored(dir, id);
    if (e.body !== undefined) {
      if (!e.body.trim()) throw new Error('The item text is empty');
      it.body = e.body;
    }
    if (e.detail !== undefined) it.detail = e.detail.trim() ? e.detail : undefined;
    if (e.suggestion !== undefined) it.suggestion = e.suggestion.trim() ? e.suggestion : undefined;
    if (e.line !== undefined) {
      if (!Number.isInteger(e.line) || e.line < 1) throw new Error('Bad line');
      it.line = e.line;
      it.startLine = e.startLine && e.startLine < e.line ? e.startLine : undefined;
      const t = readText(dir, it.path);
      it.anchor = t == null ? it.anchor : captureAnchor(t, it.line);
    }
    this.changed(dir);
    return it;
  }

  setStatus(dir: string, id: string, status: ReviewItem['status'], note?: string) {
    const it = this.stored(dir, id);
    it.status = status;
    if (note !== undefined) it.note = note.trim() || undefined;
    this.changed(dir);
    return it;
  }

  /** "Send to agent" handed these items to a fix chat: open ones become sent. */
  markSent(dir: string, ids: string[]) {
    let n = 0;
    for (const it of this.entry(dir)?.items ?? [])
      if (ids.includes(it.id) && it.status === 'open') {
        it.status = 'sent';
        n++;
      }
    if (n) this.changed(dir);
  }

  /** Drop fixed and dismissed items. */
  clearResolved(dir: string) {
    const e = this.entry(dir);
    if (!e) return;
    const before = e.items.length;
    e.items = e.items.filter((x) => x.status !== 'fixed' && x.status !== 'dismissed');
    if (e.items.length !== before) this.changed(dir);
  }

  // ------------------------------------------------------------ review chats

  /** The review context of chat `chatId` in `dir`: only for review chats (and the one startReview is creating). */
  context(dir: string, chatId: string): ReviewChatCtx | null {
    if (this.pending?.dir === dir && !this.pending.chatId) {
      this.pending.chatId = chatId;
      const e = this.ensure(dir);
      if (!e.reviewChats.includes(chatId)) e.reviewChats.push(chatId);
      this.store.save();
    }
    const e = this.entry(dir);
    if (!e?.reviewChats.includes(chatId)) return null;
    const run = () => e.runs.filter((r) => r.chatId === chatId).at(-1);
    return {
      // the run is recorded right after the chat is created; the prompt is built when the session starts
      get append() {
        const r = run();
        return r ? reviewPrompt(r.base, r.mergeBase) : '';
      },
      onFindings: (toolCallId, list) => {
        this.add(dir, parseReportFindings(dir, toolCallId, list), run()?.id);
      },
    };
  }

  /** Create a review chat, record the run, and send `/code-review <effort> <base> <instructions>` once the chat is ready.
   *  Never --fix / --comment. Resolves as soon as the chat exists; the renderer reveals it. */
  async startReview(dir: string, o: { effort?: string; instructions?: string } = {}) {
    if (this.disabled(dir)) throw new Error('Local review is not available in a PR review worktree');
    const effort = EFFORTS.includes(o.effort as PrEffort) ? (o.effort as PrEffort) : 'medium';
    const base = await this.base(dir);
    const mergeBase = await this.mergeBase(dir, base);
    if (!mergeBase) throw new Error(`No merge-base with ${base}`);
    const runId = `run-${randomBytes(4).toString('hex')}`;
    let chatId: string;
    // the run must exist when the session starts (its system prompt names the base); chatId is filled in below
    const run: LocalReviewRun = { id: runId, chatId: '', base, mergeBase, at: Date.now() };
    this.pending = { dir };
    const e = this.ensure(dir);
    try {
      const p = this.chats.create(dir);
      // Agents.create resolves the review context synchronously, so the chat id is known now
      chatId = this.pending.chatId ?? '';
      if (!chatId) throw new Error('The review chat did not pick up its review context');
      run.chatId = chatId;
      e.runs.push(run);
      const created = await p.catch((err) => {
        e.runs = e.runs.filter((r) => r !== run);
        e.reviewChats = e.reviewChats.filter((x) => x !== chatId);
        throw err;
      });
      if (created !== chatId) throw new Error('The review chat did not pick up its review context');
    } finally {
      this.pending = null;
    }
    this.changed(dir);
    const instructions = (o.instructions ?? '')
      .replace(/(^|\s)--(fix|comment)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const text = `/code-review ${effort} ${base} ${[instructions, WORKTREE_NOTE].filter(Boolean).join(' ')}`;
    this.sendWhenReady(chatId, text);
    return { chatId, runId, prompt: text };
  }

  private sendWhenReady(id: string, text: string) {
    const c = this.chats.chat(id);
    if (!c) return;
    if (c.status === 'ready') {
      c.prompt([{ type: 'text', text }]).catch(() => {});
      return;
    }
    const timer = setTimeout(() => c.off('status', on), READY_TIMEOUT_MS);
    const on = (st: { status: string }) => {
      if (st.status !== 'ready') return;
      clearTimeout(timer);
      c.off('status', on);
      c.prompt([{ type: 'text', text }]).catch(() => {});
    };
    c.on('status', on);
  }

  /** A chat tab was closed: it's no review chat any more (its id may be reused by a later chat). */
  forgetChat(chatId: string) {
    for (const [dir, e] of Object.entries(this.store.data.localReview ?? {})) {
      if (!e.reviewChats.includes(chatId)) continue;
      e.reviewChats = e.reviewChats.filter((x) => x !== chatId);
      this.changed(dir);
    }
  }

  /** The worktree was removed. */
  forget(dir: string) {
    if (!this.store.data.localReview?.[dir]) return;
    delete this.store.data.localReview[dir];
    this.changed(dir);
  }

  // ------------------------------------------------------------ CLI

  /** The `tawny review *` methods. The worktree is the caller's (TAWNY_WORKTREE). */
  register(reg: Registry) {
    const dirOf = (worktree?: string) => {
      if (!worktree || !this.entry(worktree)) throw new Error('no local review in this worktree');
      return worktree;
    };
    reg.add({
      name: 'review.propose_comment',
      summary:
        "Propose a comment on a line of the branch changes (review chats only). It lands in the user's local review list in Tawny. `line` (and `start_line` for a range) refer to the file in the working tree. `suggestion` is optional replacement text for those lines.",
      params: z.object({
        path: z.string().describe('File path relative to the repo root'),
        start_line: z.number().int().optional().describe('First line of a multi-line range'),
        line: z.number().int().describe('Line (last line of a range) the comment is on'),
        body: z.string().describe('The comment, in Markdown'),
        suggestion: z.string().optional().describe('Replacement for lines start_line..line'),
      }),
      stdin: 'body',
      handler: (p, ctx) => {
        const dir = dirOf(ctx.worktree);
        if (!ctx.chatId || !this.entry(dir)?.reviewChats.includes(ctx.chatId))
          throw new Error('not in a local review chat');
        const f = parseProposal(p);
        const runId = this.entry(dir)
          ?.runs.filter((r) => r.chatId === ctx.chatId)
          .at(-1)?.id;
        const added = this.add(dir, [{ ...f, side: 'RIGHT' }], runId);
        return { id: f.id, status: added.length ? 'added to the local review list' : 'skipped: same as an open item' };
      },
    });
    reg.add({
      name: 'review.resolve',
      summary: `Mark a local review item fixed, with a note on what changed. Pass the note on stdin as a quoted heredoc: ${resolveCommand('<id>', '<note>').replace(/\n/g, ' ')}`,
      params: z.object({
        id: z.string().describe('The item id (from the fix request, or tawny review get)'),
        note: z.string().optional().describe('What changed (prefer stdin: a quoted heredoc)'),
      }),
      args: ['id'],
      stdin: 'note',
      handler: (p, ctx) => {
        const it = this.setStatus(dirOf(ctx.worktree), p.id, 'fixed', p.note ?? '');
        return { id: it.id, status: it.status, note: it.note ?? null };
      },
    });
    reg.add({
      name: 'review.get',
      summary: "The worktree's local review items: id, status, path:line, text and fix note.",
      params: z.object({}),
      handler: (_p, ctx) =>
        this.items(dirOf(ctx.worktree)).map((it) => ({
          id: it.id,
          status: it.status,
          path: it.path,
          line: it.line,
          startLine: it.startLine,
          outdated: !!it.outdated,
          body: it.body,
          suggestion: it.suggestion,
          note: it.note,
        })),
    });
  }
}
