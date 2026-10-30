// git worktree helpers + session naming (shared with the Tawny VS Code extension).
import { type ExecFileOptions, execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** execFile failure; `stderr` is the trimmed-source of `message`. */
export type RunError = Error & { stderr: string };

function run(cmd: string, args: string[], opts: ExecFileOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const e = err as RunError;
        e.stderr = String(stderr || '');
        e.message = e.stderr.trim() || e.message;
        return reject(e);
      }
      resolve(String(stdout));
    });
  });
}

const git = (cwd: string, args: string[]) => run('git', ['-C', cwd, ...args]);

export interface ParsedWorktree {
  path: string;
  head: string;
  branch: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}
export type RepoWorktree = ParsedWorktree & { main: boolean; repo: string };

/** Parse `git worktree list --porcelain`. */
function parseWorktrees(out: string): ParsedWorktree[] {
  const list: ParsedWorktree[] = [];
  let cur: ParsedWorktree | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur);
      cur = { path: line.slice(9), head: '', branch: '', detached: false, bare: false, locked: false, prunable: false };
    } else if (!cur) {
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  if (cur) list.push(cur);
  return list.filter((w) => !w.bare);
}

async function listWorktrees(repo: string): Promise<RepoWorktree[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  return parseWorktrees(out).map((w, i) => ({ ...w, main: i === 0, repo }));
}

async function dirtyCount(dir: string) {
  try {
    const out = await git(dir, ['status', '--porcelain']);
    return out.split('\n').filter(Boolean).length;
  } catch {
    return -1;
  }
}

/** Main repo root (the main worktree) for any path inside a repo or a linked worktree. */
async function repoRootFor(dir: string) {
  const common = (await git(dir, ['rev-parse', '--git-common-dir'])).trim();
  const abs = path.resolve(dir, common);
  if (path.basename(abs) === '.git') return path.dirname(abs);
  // bare repo or unusual layout: ask git for the main worktree
  const wts = await listWorktrees(dir);
  return wts[0] ? wts[0].path : dir;
}

async function branchExists(repo: string, branch: string) {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function currentBranch(dir: string) {
  try {
    return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return 'HEAD';
  }
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wt';

async function addWorktree(repo: string, branch: string, base?: string, root?: string) {
  const repoName = path.basename(repo);
  const parent = root ? path.join(root, repoName) : `${repo}.worktrees`;
  let dir = path.join(parent, slug(branch));
  let i = 2;
  while (fs.existsSync(dir)) dir = path.join(parent, `${slug(branch)}-${i++}`);
  fs.mkdirSync(parent, { recursive: true });
  if (await branchExists(repo, branch)) await git(repo, ['worktree', 'add', dir, branch]);
  else await git(repo, ['worktree', 'add', '-b', branch, dir, base || 'HEAD']);
  return dir;
}

function copyIntoWorktree(repo: string, dir: string, files?: string[]) {
  const copied: string[] = [];
  for (const f of files || []) {
    const src = path.join(repo, f),
      dst = path.join(dir, f);
    try {
      if (fs.existsSync(src) && fs.statSync(src).isFile() && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        copied.push(f);
      }
    } catch {
      /* ignore */
    }
  }
  return copied;
}

async function removeWorktree(repo: string, dir: string, force?: boolean) {
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
}

// ---------- session names ----------

const SESSION_PREFIX = 'tawny_';
const LEGACY_PREFIX = 'harbor_'; // pre-rename names; kept so stored history (resume, names, transcripts) still matches

/** Legacy (`harbor_<base>_<hash>`) prefixes that still have stored history. */
const legacyPrefixes = new Set<string>();
const prefixOfSession = (name: string) => name.slice(0, Math.max(0, name.lastIndexOf('_')));

/** Remember legacy prefixes from stored names (`harbor_<base>_<hash>_<n>`). */
function noteLegacyNames(names: Iterable<string>) {
  for (const n of names) if (n.startsWith(LEGACY_PREFIX)) legacyPrefixes.add(prefixOfSession(n));
}

/**
 * Stable session-name prefix for a worktree path: `tawny_<base>_<hash>`, except when a pre-rename
 * `harbor_<base>_<hash>` session remembered in the store exists: that one is reused.
 */
function sessionPrefix(dir: string) {
  const h = crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 6);
  const base = slug(path.basename(dir)).replace(/[.:]/g, '-').slice(0, 24);
  const legacy = `${LEGACY_PREFIX}${base}_${h}`;
  return legacyPrefixes.has(legacy) ? legacy : `${SESSION_PREFIX}${base}_${h}`;
}

export {
  addWorktree,
  copyIntoWorktree,
  currentBranch,
  dirtyCount,
  git,
  listWorktrees,
  noteLegacyNames,
  parseWorktrees,
  removeWorktree,
  repoRootFor,
  run,
  sessionPrefix,
  slug,
};
