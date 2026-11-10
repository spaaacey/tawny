// Entry point for branch diff tabs ('d:b:<abs path>': merge-base ↔ working tree, with local review zones).
import { sep } from '../../lsp/protocol';
import { revealReviewLine } from '../review/reveal';
import { openDiff } from './api';

/** Open (or activate) the branch diff of `absPath` in worktree `root`; with `line`, scroll to it (now, or once the diff has registered). */
export async function openBranchDiff(root: string, absPath: string, opts: { pin?: boolean; line?: number } = {}) {
  const rel = absPath.startsWith(root + sep) ? absPath.slice(root.length + 1) : absPath;
  if (opts.line) revealReviewLine('local', root, rel, opts.line);
  await openDiff('b', absPath, { pin: opts.pin });
}
