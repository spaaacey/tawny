// The agent side of PR review sessions: the system prompt and `tawny-pr` MCP server config a PR chat gets, the socket
// the MCP script relays to, and the findings list (from /code-review's ReportFindings and the `propose_comment` tool).
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_PR_INSTRUCTIONS, renderPrInstructions } from '../shared/pr-instructions';
import type { PrFinding, PrInfo, PrSnapshot } from '../shared/types';
import type { PrChatCtx } from './acp';
import type { Pr } from './pr';
import type { Store } from './store';

// out/main/tawny-pr-mcp.js next to main.js; Electron runs it as Node (the agent spawns it, not us)
const MCP_SCRIPT = path
  .join(__dirname, 'tawny-pr-mcp.js')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const str = (v: unknown, max = 20000) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const int = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);

/** System prompt text appended to the claude_code preset in a PR chat: the user's edited template, or the default. */
export function prompt(p: PrInfo, template?: string) {
  return renderPrInstructions(template || DEFAULT_PR_INSTRUCTIONS, {
    ...p,
    headSha: p.headSha.slice(0, 12),
    baseSha: p.baseSha.slice(0, 12),
  });
}

export class PrAgent extends EventEmitter {
  private servers = new Map<string, { server: net.Server; sock: string }>();

  constructor(
    private store: Store,
    private pr: Pr,
  ) {
    super();
  }

  /** What a chat in worktree `dir` needs, or null if it isn't a PR worktree. Starts the chat's relay socket. */
  context(dir: string, chatId: string): PrChatCtx | null {
    const info = this.pr.for(dir);
    if (!info) return null;
    const sock = this.listen(dir, chatId);
    return {
      append: prompt(info, this.store.data.prInstructions?.[dir]),
      mcpServers: [
        {
          name: 'tawny-pr',
          command: process.execPath,
          args: [MCP_SCRIPT],
          env: [
            { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
            { name: 'TAWNY_PR_SOCKET', value: sock },
          ],
        },
      ],
      onFindings: (toolCallId, list) => this.fromReport(dir, toolCallId, list),
    };
  }

  private listen(dir: string, chatId: string) {
    this.closeChat(chatId);
    const sock = path.join(os.tmpdir(), `tawny-pr-${process.pid}-${randomBytes(3).toString('hex')}.sock`);
    const server = net.createServer((c) => {
      let buf = '';
      c.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = '';
        this.handle(dir, line).then(
          (result) => c.end(`${JSON.stringify({ result })}\n`),
          (e) => c.end(`${JSON.stringify({ error: (e as Error).message })}\n`),
        );
      });
      c.on('error', () => {});
    });
    server.on('error', () => {});
    try {
      fs.unlinkSync(sock);
    } catch {
      /* none */
    }
    server.listen(sock);
    this.servers.set(chatId, { server, sock });
    return sock;
  }

  closeChat(chatId: string) {
    const s = this.servers.get(chatId);
    if (!s) return;
    this.servers.delete(chatId);
    s.server.close();
    try {
      fs.unlinkSync(s.sock);
    } catch {
      /* gone */
    }
  }

  dispose() {
    for (const id of [...this.servers.keys()]) this.closeChat(id);
  }

  private async handle(dir: string, line: string): Promise<unknown> {
    const { method, params } = JSON.parse(line);
    const info = this.pr.for(dir);
    if (!info) throw new Error('Not a PR review worktree');
    if (method === 'propose_comment') return this.propose(dir, params);
    const snap = await this.pr.fetch(dir, false);
    if (method === 'get_pr')
      return {
        url: info.url,
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
    if (method === 'get_threads')
      return snap.threads.map((t) => ({
        path: t.path,
        line: t.line ?? t.originalLine,
        side: t.side,
        resolved: t.isResolved,
        outdated: t.isOutdated,
        comments: t.comments.map((c) => ({ author: c.author?.login, body: c.body })),
      }));
    throw new Error(`unknown method ${method}`);
  }

  // ------------------------------------------------------------ findings

  list(dir: string): PrFinding[] {
    return this.store.data.prFindings?.[dir] ?? [];
  }

  private add(dir: string, f: PrFinding) {
    const all = (this.store.data.prFindings ??= {});
    const list = (all[dir] ??= []);
    if (list.some((x) => x.id === f.id)) return false;
    list.push(f);
    this.store.save();
    this.emit('changed', dir);
    return true;
  }

  /** `propose_comment` from the agent. Returns the finding id. */
  private propose(dir: string, a: Record<string, unknown>) {
    const p = str(a.path, 1000);
    const line = int(a.line);
    const body = str(a.body);
    if (!p || !line || !body?.trim()) throw new Error('propose_comment needs path, line and body');
    const startLine = int(a.startLine);
    const f: PrFinding = {
      id: `p-${randomBytes(4).toString('hex')}`,
      source: 'propose',
      path: p.replace(/^\.?\//, ''),
      line,
      startLine: startLine && startLine < line ? startLine : undefined,
      side: a.side === 'LEFT' ? 'LEFT' : 'RIGHT',
      body,
      suggestion: str(a.suggestion),
      headSha: this.pr.for(dir)?.headSha ?? '',
      status: 'open',
      createdAt: Date.now(),
    };
    this.add(dir, f);
    return { id: f.id, status: "added to the reviewer's findings list (not posted)" };
  }

  /** A ReportFindings tool call (/code-review): `rawInput.findings[]` of {file, line, summary, failure_scenario, category?, short_summary?, verdict?}. */
  private fromReport(dir: string, toolCallId: string, list: unknown[]) {
    const head = this.pr.for(dir)?.headSha ?? '';
    list.forEach((raw, i) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const file = str(r.file, 1000);
      const line = int(r.line);
      const summary = str(r.summary) ?? str(r.short_summary);
      if (!file || !line || !summary) return;
      this.add(dir, {
        id: `r-${toolCallId || 'x'}-${i}`,
        source: 'review',
        // findings may carry absolute paths inside the worktree
        path: file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file.replace(/^\.?\//, ''),
        line,
        side: 'RIGHT',
        body: summary,
        detail: str(r.failure_scenario),
        category: str(r.category, 100),
        verdict: str(r.verdict, 100),
        headSha: head,
        status: 'open',
        createdAt: Date.now(),
      });
    });
  }

  /** "Add to review": draft the finding as a thread in the GitHub pending review (ReportFindings: single line, RIGHT, body = summary + failure scenario), then mark it accepted. `edit` overrides the body / suggestion. */
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
    const f = this.list(dir).find((x) => x.id === id);
    if (!f) return;
    f.status = status;
    this.store.save();
    this.emit('changed', dir);
  }
}
