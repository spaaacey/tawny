// The agent side of PR review sessions: the system prompt a PR chat gets, the `tawny pr *` CLI methods the agent
// calls, and the findings list (from /code-review's ReportFindings and `tawny pr propose-comment`).
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as z from 'zod';
import { DEFAULT_PR_INSTRUCTIONS, renderPrInstructions } from '../shared/pr-instructions';
import type { PrFinding, PrInfo, PrSnapshot } from '../shared/types';
import type { ReviewChatCtx } from './acp';
import type { Registry } from './cli/registry';
import type { Pr } from './pr';
import { captureAnchor, type ParsedFinding, parseProposal, parseReportFindings, remap } from './review-core';
import type { Store } from './store';

/** A worktree file's text, or null if it can't be read (deleted, outside the worktree, a directory). */
function readText(dir: string, rel: string): string | null {
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(`${path.resolve(dir)}${path.sep}`)) return null;
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** System prompt text appended to the claude_code preset in a PR chat: the user's edited template, or the default. */
export function prompt(p: PrInfo, template?: string) {
  return renderPrInstructions(template || DEFAULT_PR_INSTRUCTIONS, {
    ...p,
    headSha: p.headSha.slice(0, 12),
    baseSha: p.baseSha.slice(0, 12),
  });
}

export class PrAgent extends EventEmitter {
  constructor(
    private store: Store,
    private pr: Pr,
  ) {
    super();
  }

  /** What a chat in worktree `dir` needs, or null if it isn't a PR worktree. */
  context(dir: string, _chatId: string): ReviewChatCtx | null {
    const info = this.pr.for(dir);
    if (!info) return null;
    return {
      append: prompt(info, this.store.data.prInstructions?.[dir]),
      onFindings: (toolCallId, list) => this.fromReport(dir, toolCallId, list),
    };
  }

  /** The `tawny pr *` methods. The PR is the caller's worktree (TAWNY_WORKTREE). */
  register(reg: Registry) {
    const dirOf = (worktree?: string) => {
      if (!worktree || !this.pr.for(worktree)) throw new Error('not in a PR review chat');
      return worktree;
    };
    reg.add({
      name: 'pr.propose_comment',
      summary:
        "Propose an inline review comment on the PR. It lands in the reviewer's findings list in Tawny; the reviewer decides whether it is added to their review. Nothing is posted to GitHub. `line` (and `start_line` for a range) refer to the file in the PR head for side RIGHT, or the base for side LEFT. `suggestion` is optional replacement text for the selected lines (RIGHT side only).",
      params: z.object({
        path: z.string().describe('File path relative to the repo root'),
        start_line: z.number().int().optional().describe('First line of a multi-line range'),
        line: z.number().int().describe('Line (last line of a range) the comment is on'),
        side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
        body: z.string().describe('The comment, in Markdown'),
        suggestion: z.string().optional().describe('Replacement for lines start_line..line'),
      }),
      handler: (p, ctx) => this.propose(dirOf(ctx.worktree), p),
    });
    reg.add({
      name: 'pr.get',
      summary: 'The PR under review (title, description, refs, head/base sha, state).',
      params: z.object({}),
      handler: async (_p, ctx) => {
        const dir = dirOf(ctx.worktree);
        const info = this.pr.for(dir);
        const snap = await this.pr.fetch(dir, false);
        return {
          url: info?.url,
          title: snap.title,
          body: snap.body,
          state: snap.state,
          isDraft: snap.isDraft,
          author: snap.author?.login,
          headRef: snap.headRef,
          baseRef: snap.baseRef,
          headSha: snap.headSha,
          baseSha: snap.baseSha,
        };
      },
    });
    reg.add({
      name: 'pr.threads',
      summary: 'Existing review threads on the PR (path, line, resolved, outdated, comments).',
      params: z.object({}),
      handler: async (_p, ctx) => {
        const snap = await this.pr.fetch(dirOf(ctx.worktree), false);
        return snap.threads.map((t) => ({
          path: t.path,
          line: t.line ?? t.originalLine,
          side: t.side,
          resolved: t.isResolved,
          outdated: t.isOutdated,
          comments: t.comments.map((c) => ({ author: c.author?.login, body: c.body })),
        }));
      },
    });
  }

  // ------------------------------------------------------------ findings

  private stored(dir: string): PrFinding[] {
    return this.store.data.prFindings?.[dir] ?? [];
  }

  /** The findings with RIGHT-side lines remapped to the worktree's current files (anchor gone => `outdated`, line kept). Copies; the store keeps the original lines. */
  list(dir: string): PrFinding[] {
    const files = new Map<string, string | null>();
    const text = (p: string) => {
      if (!files.has(p)) files.set(p, readText(dir, p));
      return files.get(p) ?? null;
    };
    return this.stored(dir).map((f) => {
      const t = f.side === 'RIGHT' && f.anchor ? text(f.path) : null;
      if (t == null) return f;
      const m = remap(f, t);
      const shift = m.line - f.line;
      return { ...f, line: m.line, startLine: f.startLine && f.startLine + shift, outdated: m.outdated || undefined };
    });
  }

  /** Store new findings (skipping known ids), with the head they were made against and their anchors in the worktree. */
  private add(dir: string, found: ParsedFinding[]) {
    const all = (this.store.data.prFindings ??= {});
    const list = (all[dir] ??= []);
    const headSha = this.pr.for(dir)?.headSha ?? '';
    let added = 0;
    for (const p of found) {
      if (list.some((x) => x.id === p.id)) continue;
      const t = p.side === 'RIGHT' ? readText(dir, p.path) : null;
      const anchor = t == null ? undefined : captureAnchor(t, p.line);
      list.push({ ...p, anchor, headSha, status: 'open', createdAt: Date.now() });
      added++;
    }
    if (!added) return;
    this.store.save();
    this.emit('changed', dir);
  }

  /** `tawny pr propose-comment` from the agent. Returns the finding id. */
  private propose(dir: string, a: Record<string, unknown>) {
    const f = parseProposal(a);
    this.add(dir, [f]);
    return { id: f.id, status: "added to the reviewer's findings list (not posted)" };
  }

  /** A ReportFindings tool call (/code-review), see parseReportFindings. */
  private fromReport(dir: string, toolCallId: string, list: unknown[]) {
    this.add(dir, parseReportFindings(dir, toolCallId, list));
  }

  /** "Add to review": draft the finding (at its remapped line) as a thread in the GitHub pending review (ReportFindings: single line, RIGHT, body = summary + failure scenario), then mark it accepted. `edit` overrides the body / suggestion. */
  async addToReview(dir: string, id: string, edit?: { body?: string; suggestion?: string }): Promise<PrSnapshot> {
    const f = this.list(dir).find((x) => x.id === id);
    if (!f) throw new Error('Unknown finding');
    const body = edit?.body ?? (f.detail ? `${f.body}\n\n${f.detail}` : f.body);
    const suggestion = f.side === 'RIGHT' ? (edit ? edit.suggestion : f.suggestion) : undefined;
    const snap = await this.pr.review(dir, {
      kind: 'thread',
      path: f.path,
      line: f.line,
      startLine: f.startLine,
      side: f.side,
      body,
      suggestion: suggestion?.trim() ? suggestion : undefined,
    });
    this.setStatus(dir, id, 'accepted');
    return snap;
  }

  setStatus(dir: string, id: string, status: PrFinding['status']) {
    const f = this.stored(dir).find((x) => x.id === id);
    if (!f) return;
    f.status = status;
    this.store.save();
    this.emit('changed', dir);
  }
}
