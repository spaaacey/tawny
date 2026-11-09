// PR comments written from the ask bubble: a pending-review draft when the file is in the PR diff, else a local general
// draft (permalink header) posted as a conversation comment when the review is submitted.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PrInfo } from '../../../shared/types';
import { prReview } from '../components/workspace/PrDrafts';
import { getApp } from '../store';
import { toast } from './actions';
import { H } from './tawny';

export interface GeneralDraft {
  id: string;
  path: string; // repo-relative
  a: number;
  b: number;
  body: string; // permalink header + the user's text
}

/** Local general-comment drafts per PR worktree, until the review is submitted. */
export const usePrGeneral = create<{
  by: Record<string, GeneralDraft[]>;
  add: (dir: string, d: GeneralDraft) => void;
  remove: (dir: string, id: string) => void;
  clear: (dir: string) => void;
}>()(
  persist(
    (set) => ({
      by: {},
      add: (dir, d) => set((s) => ({ by: { ...s.by, [dir]: [...(s.by[dir] ?? []), d] } })),
      remove: (dir, id) => set((s) => ({ by: { ...s.by, [dir]: (s.by[dir] ?? []).filter((x) => x.id !== id) } })),
      clear: (dir) => set((s) => ({ by: { ...s.by, [dir]: [] } })),
    }),
    { name: 'tawny.prGeneral', version: 1 },
  ),
);

/** The PR review worktree containing absolute `path`, with `path` relative to it. */
export function prWorktreeOf(path: string): { dir: string; pr: PrInfo; rel: string } | null {
  for (const r of getApp().repos)
    for (const w of r.worktrees)
      if (w.pr && path.startsWith(`${w.path}/`)) return { dir: w.path, pr: w.pr, rel: path.slice(w.path.length + 1) };
  return null;
}

/** GitHub permalink of lines a..b of `rel` at commit `sha`. */
export const permalink = (pr: PrInfo, sha: string, rel: string, a: number, b: number) =>
  `https://${pr.host}/${pr.owner}/${pr.repo}/blob/${sha}/${rel.split('/').map(encodeURIComponent).join('/')}#L${a}${b > a ? `-L${b}` : ''}`;

/** Add `text` as a PR comment on lines a..b of absolute `path`. Resolves false (after a toast) on failure. */
export async function addPrComment(path: string, a: number, b: number, text: string): Promise<boolean> {
  const w = prWorktreeOf(path);
  if (!w) {
    toast('Not in a PR review worktree');
    return false;
  }
  try {
    const files = await H.prFiles(w.dir);
    if (files.files.some((f) => f.path === w.rel))
      return await prReview(w.dir, {
        kind: 'thread',
        path: w.rel,
        line: b,
        startLine: a < b ? a : undefined,
        side: 'RIGHT',
        body: text,
      });
    const snap = await H.prFetch(w.dir);
    const link = permalink(w.pr, snap.headSha, w.rel, a, b);
    usePrGeneral
      .getState()
      .add(w.dir, { id: `g${Date.now().toString(36)}`, path: w.rel, a, b, body: `${link}\n\n${text}` });
    toast('Added a general PR comment draft (posted when you submit the review)');
    return true;
  } catch (e) {
    toast((e as Error).message);
    return false;
  }
}
