// Shared by PR review (pr-agent.ts) and local review: parsing agent findings (/code-review's ReportFindings and
// `propose-comment` calls) into review fields, and anchoring items to their lines so they follow edits.
// Pure (no electron, no fs) so it can be unit-tested: test/review-core.test.mjs.
import { randomBytes } from 'node:crypto';
import type { ReviewAnchor, ReviewFields } from '../shared/types';

/** A parsed finding: the shared fields plus where it came from and its side. Callers add status, createdAt etc. */
export type ParsedFinding = ReviewFields & { source: 'review' | 'propose'; side: 'LEFT' | 'RIGHT' };

/** Lines of context kept on each side of an anchored line. */
export const ANCHOR_CONTEXT = 2;

const str = (v: unknown, max = 20000) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const int = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);

/** Repo-relative path: findings may carry absolute paths inside the worktree, or a leading `./` / `/`. */
export function relPath(dir: string, file: string) {
  return file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file.replace(/^\.?\//, '');
}

/** A ReportFindings tool call (/code-review): `rawInput.findings[]` of {file, line, summary, failure_scenario, category?, short_summary?, verdict?}.
 *  Ids are `r-<toolCallId>-<index>` (stable, so a replayed tool call doesn't add duplicates). Entries without a file or summary are skipped. */
export function parseReportFindings(dir: string, toolCallId: string, list: unknown[]): ParsedFinding[] {
  const out: ParsedFinding[] = [];
  list.forEach((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const file = str(r.file, 1000);
    const summary = str(r.summary) ?? str(r.short_summary);
    if (!file || !summary) return;
    out.push({
      id: `r-${toolCallId || 'x'}-${i}`,
      source: 'review',
      path: relPath(dir, file),
      line: int(r.line) || 1, // `line` is optional in ReportFindings: anchor file-level findings to the first line
      side: 'RIGHT',
      body: summary,
      detail: str(r.failure_scenario),
      category: str(r.category, 100),
      verdict: str(r.verdict, 100),
    });
  });
  return out;
}

/** `propose-comment` args {path, line, start_line?, side?, body, suggestion?} -> a finding with a fresh `p-` id. Throws without path, line and body. */
export function parseProposal(a: Record<string, unknown>): ParsedFinding {
  const p = str(a.path, 1000);
  const line = int(a.line);
  const body = str(a.body);
  if (!p || !line || !body?.trim()) throw new Error('propose-comment needs path, line and body');
  const startLine = int(a.start_line);
  return {
    id: `p-${randomBytes(4).toString('hex')}`,
    source: 'propose',
    path: p.replace(/^\.?\//, ''),
    line,
    startLine: startLine && startLine < line ? startLine : undefined,
    side: a.side === 'LEFT' ? 'LEFT' : 'RIGHT',
    body,
    suggestion: str(a.suggestion),
  };
}

const linesOf = (text: string) => text.split(/\r?\n/);
const same = (a: string | undefined, b: string) => a !== undefined && a.trimEnd() === b.trimEnd();

/** The anchor of 1-based `line` in `fileText`: its text plus up to ANCHOR_CONTEXT lines each side. Undefined when the line is past the end. */
export function captureAnchor(fileText: string, line: number): ReviewAnchor | undefined {
  const lines = linesOf(fileText);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return undefined;
  const i = line - 1;
  return {
    text: lines[i],
    before: lines.slice(Math.max(0, i - ANCHOR_CONTEXT), i),
    after: lines.slice(i + 1, i + 1 + ANCHOR_CONTEXT),
  };
}

/** Where an item's line is now in `fileText`: the anchor block (context included) matched exactly, nearest the old line on a tie;
 *  else the anchor's line alone if it matches exactly once; else outdated at the old line. Without an anchor the line stays,
 *  outdated only when it's past the end of the file. Trailing whitespace is ignored. */
export function remap(
  item: { line: number; anchor?: ReviewAnchor },
  fileText: string,
): { line: number; outdated: boolean } {
  const lines = linesOf(fileText);
  const a = item.anchor;
  if (!a) return { line: item.line, outdated: item.line > lines.length };
  const textAt: number[] = [];
  const blockAt: number[] = [];
  lines.forEach((l, i) => {
    if (!same(l, a.text)) return;
    textAt.push(i);
    const before = a.before.every((b, k) => same(lines[i - a.before.length + k], b));
    const after = a.after.every((b, k) => same(lines[i + 1 + k], b));
    if (before && after) blockAt.push(i);
  });
  if (blockAt.length) {
    const old = item.line - 1;
    const best = blockAt.reduce((x, y) => (Math.abs(y - old) < Math.abs(x - old) ? y : x));
    return { line: best + 1, outdated: false };
  }
  if (textAt.length === 1) return { line: textAt[0] + 1, outdated: false };
  return { line: item.line, outdated: true };
}

/** A copy of `item` remapped to `fileText` (see remap): `line` moved, `startLine` shifted with it, `outdated` set when the anchor is gone. */
export function remapped<T extends { line: number; startLine?: number; anchor?: ReviewAnchor; outdated?: boolean }>(
  item: T,
  fileText: string,
): T {
  const m = remap(item, fileText);
  const shift = m.line - item.line;
  return {
    ...item,
    line: m.line,
    startLine: item.startLine && item.startLine + shift,
    outdated: m.outdated || undefined,
  };
}
