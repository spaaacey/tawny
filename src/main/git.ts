// git worktree + tmux helpers (shared with the Tawny VS Code extension; same session naming).
import { type ExecFileOptions, execFile, execFileSync } from 'node:child_process';
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

// ---------- tmux ----------

const TMUX_PREFIX = 'tawny_';
const LEGACY_TMUX_PREFIX = 'harbor_'; // pre-rename sessions; still listed/attached so live agents aren't orphaned
const isOurSession = (name: string) => name.startsWith(TMUX_PREFIX) || name.startsWith(LEGACY_TMUX_PREFIX);

/** Legacy (`harbor_<base>_<hash>`) prefixes that still have live tmux sessions or stored history. */
const legacyPrefixes = new Set<string>();
let legacyScanned = false;
const prefixOfSession = (name: string) => name.slice(0, Math.max(0, name.lastIndexOf('_')));

/** Remember legacy prefixes from session/store names (`harbor_<base>_<hash>_<n>`). */
function noteLegacyNames(names: Iterable<string>) {
  for (const n of names) if (n.startsWith(LEGACY_TMUX_PREFIX)) legacyPrefixes.add(prefixOfSession(n));
}

function scanLegacySync() {
  legacyScanned = true;
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    noteLegacyNames(out.split('\n'));
  } catch {
    /* no tmux / no server */
  }
}

/**
 * Stable session-name prefix for a worktree path: `tawny_<base>_<hash>`, except when a pre-rename
 * `harbor_<base>_<hash>` session (live in tmux, or remembered in the store) exists: that one is reused.
 */
function sessionPrefix(dir: string) {
  const h = crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 6);
  const base = slug(path.basename(dir)).replace(/[.:]/g, '-').slice(0, 24);
  if (!legacyScanned) scanLegacySync();
  const legacy = `${LEGACY_TMUX_PREFIX}${base}_${h}`;
  return legacyPrefixes.has(legacy) ? legacy : `${TMUX_PREFIX}${base}_${h}`;
}

let tmuxOk: boolean | undefined;
async function hasTmux(): Promise<boolean> {
  if (tmuxOk === undefined) {
    try {
      await run('tmux', ['-V']);
      tmuxOk = true;
    } catch {
      tmuxOk = false;
    }
  }
  return !!tmuxOk;
}

/** All Tawny (and legacy harbor_) tmux panes: [{name, activity, cmd, cwd}] */
export interface TmuxPane {
  name: string;
  activity: number;
  cmd: string;
  cwd: string;
  attached: number;
}

async function listSessions(): Promise<TmuxPane[]> {
  try {
    const out = await run('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{session_name}|#{window_activity}|#{session_attached}|#{pane_current_command}|#{pane_current_path}',
    ]);
    const seen = new Map<string, TmuxPane>();
    for (const line of out.split('\n')) {
      // tmux mangles tabs in formats; '|' is safe because cwd (which may contain it) is last
      const [name, act, attached, cmd, ...rest] = line.split('|');
      const cwd = rest.join('|');
      if (!name || !isOurSession(name)) continue;
      const activity = Number(act) || 0;
      const prev = seen.get(name);
      if (!prev || activity > prev.activity)
        seen.set(name, { name, activity, cmd, cwd, attached: Number(attached) || 0 });
    }
    noteLegacyNames(seen.keys());
    return [...seen.values()];
  } catch {
    return [];
  } // no server running
}

/** Pane title per Tawny/legacy tmux session (tmux doesn't forward titles to our pty; Claude Code keeps its busy/idle glyph there). */
async function paneTitles(): Promise<Map<string, string>> {
  try {
    const out = await run('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_title}']);
    const titles = new Map<string, string>();
    for (const line of out.split('\n')) {
      const i = line.indexOf(' ');
      if (i > 0 && isOurSession(line)) titles.set(line.slice(0, i), line.slice(i + 1));
    }
    return titles;
  } catch {
    return new Map();
  }
}

const sessionIndex = (name: string) => Number(name.split('_').pop()) || 0;

async function createSession(name: string, cwd: string, command?: string) {
  const sh = process.env.SHELL || '/bin/sh';
  const cmd = command ? `${command}; exec ${sh} -l` : `exec ${sh} -l`;
  await run('tmux', ['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', cmd], {
    env: { ...process.env, TMUX: '' },
  });
  // per-session niceties; never touch the user's global tmux config
  for (const [k, v] of [
    ['mouse', 'on'],
    ['status', 'off'],
    ['window-size', 'latest'],
  ]) {
    try {
      await run('tmux', ['set-option', '-t', name, k, v]);
    } catch {
      /* old tmux */
    }
  }
}

async function killSession(name: string) {
  try {
    await run('tmux', ['kill-session', '-t', name]);
  } catch {
    /* gone */
  }
}

export {
  addWorktree,
  copyIntoWorktree,
  createSession,
  currentBranch,
  dirtyCount,
  git,
  hasTmux,
  killSession,
  listSessions,
  listWorktrees,
  noteLegacyNames,
  paneTitles,
  parseWorktrees,
  removeWorktree,
  repoRootFor,
  run,
  sessionIndex,
  sessionPrefix,
  slug,
};
