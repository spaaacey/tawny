// File access for the editor: directory listing, read/write, git status, file index for ⌘P, and
// a recursive watcher per worktree so agent edits show up live.
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';

const fsp = fs.promises;

import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import * as G from './git';

const HIDDEN = new Set(['.git', '.DS_Store', '.ruby-lsp']);
const WATCH_IGNORE =
  /(^|[\\/])(\.git|node_modules|\.ruby-lsp|tmp|log|\.next|dist|build|coverage|\.turbo|\.cache)([\\/]|$)/;
const MAX_FILE = 8 * 1024 * 1024;

export type GitCode = 'M' | 'A' | 'D' | '?' | 'R' | 'C' | 'U' | '•';
export interface GitChange {
  path: string;
  status: string;
  orig?: string;
}
export interface CommitInfo {
  sha: string;
  short: string;
  author: string;
  time: number;
  refs: string[];
  subject: string;
}

/** Subset of `names` (children of `dir`) that git ignores; empty outside a repo. */
function ignoredNames(dir: string, names: string[]): Promise<Set<string>> {
  return new Promise((resolve) => {
    if (!names.length) return resolve(new Set());
    const p = spawn('git', ['-C', dir, 'check-ignore', '--stdin', '-z'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(new Set()));
    p.on('close', () => resolve(new Set(out.split('\0').filter(Boolean))));
    p.stdin.on('error', () => {});
    p.stdin.end(names.join('\0'));
  });
}

async function list(dir: string) {
  const ents = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => !HIDDEN.has(e.name));
  const ignored = await ignoredNames(
    dir,
    ents.map((e) => e.name),
  );
  return ents
    .map((e) => {
      let type: 'dir' | 'file' = e.isDirectory() ? 'dir' : 'file';
      if (e.isSymbolicLink()) {
        try {
          type = fs.statSync(path.join(dir, e.name)).isDirectory() ? 'dir' : 'file';
        } catch {
          type = 'file';
        }
      }
      return { name: e.name, path: path.join(dir, e.name), type, ignored: ignored.has(e.name) };
    })
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1,
    );
}

async function read(file: string) {
  const st = await fsp.stat(file);
  if (st.size > MAX_FILE) throw new Error(`File is too large to open (${Math.round(st.size / 1048576)} MB)`);
  const buf = await fsp.readFile(file);
  // crude binary check: NUL byte in the first 8KB
  if (buf.subarray(0, 8192).includes(0)) return { binary: true, text: '', mtime: st.mtimeMs };
  return { binary: false, text: buf.toString('utf8'), mtime: st.mtimeMs };
}

/** Terminal link text (absolute, ~/ or relative to `cwd`) → absolute path of an existing file, else null. */
async function resolveFile(cwd: string | undefined, p: string) {
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  p = path.resolve(cwd || os.homedir(), p);
  try {
    return (await fsp.stat(p)).isFile() ? p : null;
  } catch {
    return null;
  }
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** Image file → data URL for the renderer (CSP only allows data: images); null if not an image or > 20 MB. */
async function imageUrl(file: string) {
  const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
  if (!mime) return null;
  try {
    if ((await fsp.stat(file)).size > 20 * 1048576) return null;
    return `data:${mime};base64,${(await fsp.readFile(file)).toString('base64')}`;
  } catch {
    return null;
  }
}

async function write(file: string, text: string) {
  await fsp.writeFile(file, text, 'utf8');
  return (await fsp.stat(file)).mtimeMs;
}

async function create(file: string, kind: 'file' | 'dir') {
  const name = path.basename(file);
  const exists = () => new Error(`A file or folder named "${name}" already exists`);
  if (kind === 'dir') {
    if (fs.existsSync(file)) throw exists();
    await fsp.mkdir(file, { recursive: true });
    return;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(file, '', { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw exists();
    throw e;
  }
}

/** Copy files/folders into `dir`, picking "name copy.ext" style names on collision. Returns new paths. */
async function copyInto(dir: string, srcs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const src of srcs) {
    const ext = path.extname(src);
    const base = path.basename(src, ext);
    let dst = path.join(dir, path.basename(src));
    for (let i = 1; fs.existsSync(dst); i++) dst = path.join(dir, `${base} copy${i > 1 ? ` ${i}` : ''}${ext}`);
    if (dst === src || dst.startsWith(`${src}${path.sep}`)) continue;
    await fsp.cp(src, dst, { recursive: true, errorOnExist: true });
    out.push(dst);
  }
  return out;
}

async function rename(from: string, to: string) {
  if (from === to) return;
  const name = path.basename(to);
  if (fs.existsSync(to) && from.toLowerCase() !== to.toLowerCase())
    throw new Error(`A file or folder named "${name}" already exists`);
  await fsp.rename(from, to);
}

/** git status → { relPath: 'M'|'A'|'D'|'?'|'R'|'U' } plus dirs that contain changes */
async function gitStatus(root: string): Promise<Record<string, GitCode>> {
  try {
    const out = await G.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const map: Record<string, GitCode> = {};
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const x = p[0],
        y = p[1];
      const rel = p.slice(3);
      if (x === 'R' || x === 'C') i++; // next entry is the source path
      const code: GitCode =
        x === '?'
          ? '?'
          : x === 'U' || y === 'U'
            ? 'U'
            : x === 'A'
              ? 'A'
              : x === 'D' || y === 'D'
                ? 'D'
                : x === 'R'
                  ? 'R'
                  : 'M';
      map[rel] = code;
      let d = path.dirname(rel);
      while (d && d !== '.' && !map[`${d}/`]) {
        map[`${d}/`] = '•';
        d = path.dirname(d);
      }
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * git status → { staged: [...], unstaged: [...] } with entries { path (relative), status, orig? }.
 * status: 'M' modified, 'A' added, 'D' deleted, 'R' renamed, 'C' copied, '?' untracked, 'U' conflict.
 */
async function gitChanges(root: string) {
  const staged: GitChange[] = [],
    unstaged: GitChange[] = [];
  try {
    const out = await G.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const x = p[0],
        y = p[1],
        rel = p.slice(3);
      let orig: string | undefined;
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') orig = parts[++i];
      const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
      if (x === '?') unstaged.push({ path: rel, status: '?' });
      else if (conflict) unstaged.push({ path: rel, status: 'U' });
      else {
        if (x !== ' ') staged.push({ path: rel, status: x, ...(orig ? { orig } : {}) });
        if (y !== ' ') unstaged.push({ path: rel, status: y });
      }
    }
  } catch {
    /* not a repo */
  }
  return { staged, unstaged };
}

/** Commit the index with `message`; when nothing is staged, stage everything first. Throws git's error text. */
async function gitCommit(root: string, message: string) {
  if (!String(message || '').trim()) throw new Error('Empty commit message');
  const { staged } = await gitChanges(root);
  if (!staged.length) await G.git(root, ['add', '-A']);
  await G.git(root, ['commit', '-m', message]);
}

/** Undo the last commit, keeping its changes staged. Returns its full message so the UI can restore it. */
async function gitUndoCommit(root: string): Promise<string> {
  const msg = (await G.git(root, ['log', '-1', '--format=%B'])).trim();
  const hasParent = await G.git(root, ['rev-parse', '--verify', '-q', 'HEAD~1']).then(
    () => true,
    () => false,
  );
  if (hasParent) await G.git(root, ['reset', '--soft', 'HEAD~1']);
  else await G.git(root, ['update-ref', '-d', 'HEAD']);
  return msg;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  /** path of the other worktree that has it checked out */
  worktree: string | null;
}

/** Local branches, most recently committed first, with the worktree each is checked out in. */
async function gitBranches(root: string): Promise<BranchInfo[]> {
  const [refs, wts] = await Promise.all([
    G.git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']),
    G.listWorktrees(root),
  ]);
  const at = new Map(wts.filter((w) => w.branch).map((w) => [w.branch, w.path] as const));
  const here = wts.find((w) => path.resolve(w.path) === path.resolve(root))?.branch;
  return refs
    .split('\n')
    .filter(Boolean)
    .map((name) => ({ name, current: name === here, worktree: name === here ? null : (at.get(name) ?? null) }));
}

/** `git switch` in this worktree; `stash` first stashes (incl. untracked) changes. Returns whether it stashed. */
async function gitSwitch(root: string, branch: string, stash: boolean): Promise<boolean> {
  let stashed = false;
  if (stash) {
    const cur = (await G.git(root, ['branch', '--show-current'])).trim() || 'detached HEAD';
    const out = await G.git(root, ['stash', 'push', '-u', '-m', `tawny: ${cur}`]);
    stashed = !/No local changes/i.test(out);
  }
  await G.git(root, ['switch', branch]);
  return stashed;
}

async function gitAheadBehind(root: string): Promise<{ upstream: string | null; ahead: number; behind: number }> {
  const count = async (base: string) => {
    const [ahead, behind] = (await G.git(root, ['rev-list', '--left-right', '--count', `HEAD...${base}`]))
      .trim()
      .split(/\s+/)
      .map(Number);
    return { upstream: base, ahead, behind };
  };
  try {
    return await count((await G.git(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim());
  } catch {
    /* no upstream (e.g. worktree branch): compare against the default branch */
  }
  const head = (await G.git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  for (const base of ['main', 'master']) {
    if (base === head) continue;
    try {
      return await count(base);
    } catch {
      /* try next */
    }
  }
  return { upstream: null, ahead: 0, behind: 0 };
}

/** Lines added/removed by all uncommitted changes (staged + unstaged vs HEAD, plus untracked files) → { add, del }. */
async function gitDiffStat(root: string) {
  let add = 0,
    del = 0;
  try {
    let out: string;
    try {
      out = await G.git(root, ['diff', 'HEAD', '--numstat', '-z']);
    } catch {
      out =
        (await G.git(root, ['diff', '--cached', '--numstat', '-z'])) + (await G.git(root, ['diff', '--numstat', '-z']));
    } // no HEAD yet
    // -z: "add\tdel\tpath\0", renames "add\tdel\t\0old\0new\0"
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]);
      if (!m) continue;
      if (m[3] === '') i += 2;
      if (m[1] !== '-') {
        add += +m[1];
        del += +m[2];
      }
    }
  } catch {
    /* not a repo */
  }
  try {
    const { unstaged } = await gitChanges(root);
    for (const f of unstaged) {
      if (f.status !== '?') continue;
      try {
        const buf = await fsp.readFile(path.join(root, f.path));
        if (buf.length > MAX_FILE || buf.subarray(0, 8192).includes(0)) continue;
        let n = 0;
        for (const b of buf) if (b === 10) n++;
        add += n + (buf.length && buf[buf.length - 1] !== 10 ? 1 : 0);
      } catch {
        /* vanished or unreadable */
      }
    }
  } catch {
    /* ignore */
  }
  return { add, del };
}

const literal = (paths: string[]) => paths.map((p) => `:(literal)${p}`);

/** Stage working-tree changes (including deletions) for repo-relative `paths`. */
async function gitStage(root: string, paths: string[]) {
  if (paths.length) await G.git(root, ['add', '-A', '--', ...literal(paths)]);
}

/** Unstage `paths`; works before the first commit too. */
async function gitUnstage(root: string, paths: string[]) {
  if (!paths.length) return;
  try {
    await G.git(root, ['restore', '--staged', '--', ...literal(paths)]);
  } catch {
    await G.git(root, ['rm', '-r', '--cached', '-q', '--', ...literal(paths)]);
  }
}

/** Throw away working-tree changes to `paths`: tracked files are restored from the index, untracked ones deleted. */
async function gitDiscard(root: string, paths: string[]) {
  const want = new Set(paths);
  const { unstaged } = await gitChanges(root);
  const tracked = unstaged.filter((f) => f.status !== '?' && want.has(f.path)).map((f) => f.path);
  const untracked = unstaged.filter((f) => f.status === '?' && want.has(f.path)).map((f) => f.path);
  if (tracked.length) await G.git(root, ['restore', '--worktree', '--', ...literal(tracked)]);
  if (untracked.length) await G.git(root, ['clean', '-f', '-q', '--', ...literal(untracked)]);
}

const REV = /^(?:HEAD|[0-9a-f]{7,40}(?:\^)?)$/;

/** Recent commits of HEAD for the Source pane's graph: { sha, short, author, time (unix), refs: [...], subject }. */
async function gitLog(root: string, limit = 50): Promise<CommitInfo[]> {
  try {
    const out = await G.git(root, [
      'log',
      `-n${limit}`,
      '--decorate=short',
      '--format=%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%s%x1e',
    ]);
    return out
      .split('\x1e')
      .map((r) => r.replace(/^\n/, ''))
      .filter(Boolean)
      .map((r) => {
        const [sha, short, author, time, refs, subject] = r.split('\x1f');
        return {
          sha,
          short,
          author,
          time: +time,
          refs: refs
            ? refs
                .split(', ')
                .map((x) => x.replace(/^HEAD -> /, ''))
                .filter((x) => x !== 'HEAD')
            : [],
          subject,
        };
      });
  } catch {
    return [];
  }
}

/** Files a commit changed (against its first parent): [{ path, status, orig? }]. */
async function gitCommitFiles(root: string, sha: string): Promise<GitChange[]> {
  if (!REV.test(sha)) return [];
  try {
    const out = await G.git(root, [
      'diff-tree',
      '--root',
      '-r',
      '-M',
      '--name-status',
      '-z',
      '--no-commit-id',
      '-m',
      '--first-parent',
      sha,
    ]);
    const parts = out.split('\0');
    const files: GitChange[] = [];
    for (let i = 0; i < parts.length; i++) {
      const st = parts[i];
      if (!st) continue;
      if (st[0] === 'R' || st[0] === 'C') {
        const orig = parts[++i];
        files.push({ path: parts[++i], status: st[0], orig });
      } else files.push({ path: parts[++i], status: st[0] });
    }
    return files;
  } catch {
    return [];
  }
}

/** File content at `ref` ('HEAD', 'index', a commit sha or `<sha>^`) for the diff viewer; { missing } when the path isn't there. */
async function gitShow(
  root: string,
  rel: string,
  ref: string,
): Promise<{ missing?: boolean; binary?: boolean; text: string }> {
  if (ref !== 'index' && !REV.test(ref)) return { missing: true, text: '' };
  try {
    const text = await G.git(root, ['show', `${ref === 'index' ? '' : ref}:./${rel}`]);
    if (text.slice(0, 8192).includes('\0')) return { binary: true, text: '' };
    return { text };
  } catch {
    return { missing: true, text: '' };
  }
}

/**
 * Line ranges (LSP, 0-based, end exclusive) of `text` that differ from the file at HEAD, via `git diff --no-index`.
 * null when HEAD has no version of the file (new / untracked): the whole file counts as changed.
 */
async function gitChangedRanges(root: string, file: string, text: string) {
  const head = await gitShow(root, path.relative(root, file), 'HEAD');
  if (head.missing || head.binary) return null;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tawny-diff-'));
  try {
    const headFile = path.join(dir, 'head');
    await fsp.writeFile(headFile, head.text);
    const out = await new Promise<string>((resolve, reject) => {
      const p = execFile(
        'git',
        ['diff', '--no-index', '--no-ext-diff', '-U0', '--', headFile, '-'],
        { maxBuffer: 64 << 20 },
        (err, stdout) => (err && (err as { code?: number }).code !== 1 ? reject(err) : resolve(stdout)),
      );
      p.stdin?.end(text);
    });
    const ranges: { start: { line: number; character: number }; end: { line: number; character: number } }[] = [];
    for (const m of out.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count)
        ranges.push({
          start: { line: Number(m[1]) - 1, character: 0 },
          end: { line: Number(m[1]) - 1 + count, character: 0 },
        });
    }
    return ranges;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

export interface BlameCommit {
  author: string;
  time: number;
  summary: string;
  you: boolean;
}
export interface Blame {
  commits: Record<string, BlameCommit>;
  lines: string[]; // commit sha per line; all zeros = not committed yet
}
const BLAME_MAX = 1024 * 1024;

/** `git blame` of `text` (the editor buffer) as the content of `rel`; null for untracked / binary / huge / non-repo files. */
async function gitBlame(root: string, rel: string, text: string): Promise<Blame | null> {
  if (text.length > BLAME_MAX) return null;
  let out: string;
  try {
    out = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'git',
        ['-C', root, 'blame', '--porcelain', '--contents', '-', '--', `./${rel}`],
        { maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(text);
    });
  } catch {
    return null;
  }
  const me = (await G.git(root, ['config', 'user.email']).catch(() => '')).trim().toLowerCase();
  const commits: Record<string, BlameCommit> = {};
  const lines: string[] = [];
  let cur: BlameCommit | null = null;
  for (const l of out.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
    if (head) {
      if (!commits[head[1]]) commits[head[1]] = { author: '', time: 0, summary: '', you: false };
      cur = commits[head[1]];
      lines[+head[2] - 1] = head[1];
    } else if (!cur) continue;
    else if (l.startsWith('author ')) cur.author = l.slice(7);
    else if (l.startsWith('author-mail ')) {
      const mail = l.slice(12).replace(/^<|>$/g, '').toLowerCase();
      cur.you = !!me && mail === me;
    } else if (l.startsWith('author-time ')) cur.time = +l.slice(12);
    else if (l.startsWith('summary ')) cur.summary = l.slice(8);
  }
  return { commits, lines };
}

/** Full message of a commit for the blame hover card. */
async function gitCommitMessage(root: string, sha: string): Promise<string> {
  if (!REV.test(sha)) return '';
  try {
    return (await G.git(root, ['log', '-1', '--format=%B', sha])).trim();
  } catch {
    return '';
  }
}

export interface CommitPr {
  number: number;
  title: string;
  url: string;
}
const prCache = new Map<string, Promise<CommitPr | null>>(); // root + sha -> PR
/** The GitHub PR that introduced a commit (via `gh`; null when not GitHub, gh missing/unauthed, or no PR). */
function gitCommitPr(root: string, sha: string): Promise<CommitPr | null> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return Promise.resolve(null);
  const key = `${root}\0${sha}`;
  let p = prCache.get(key);
  if (!p) {
    p = new Promise<CommitPr | null>((resolve) => {
      execFile(
        'gh',
        ['api', `repos/{owner}/{repo}/commits/${sha}/pulls`, '--jq', '[.[] | {number, title, url: .html_url}] | first'],
        { cwd: root, timeout: 15000 },
        (err, stdout) => {
          if (err) {
            prCache.delete(key); // retry later (offline, auth...)
            return resolve(null);
          }
          try {
            const pr = JSON.parse(String(stdout) || 'null');
            resolve(pr?.url ? pr : null);
          } catch {
            resolve(null);
          }
        },
      );
    });
    prCache.set(key, p);
  }
  return p;
}

/** All files for ⌘P: tracked + untracked-not-ignored (git), else a bounded walk. */
async function fileIndex(root: string): Promise<string[]> {
  try {
    const out = await G.git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
    return out.split('\0').filter(Boolean).slice(0, 100000);
  } catch {
    const res: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 12 || res.length > 50000) return;
      for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (HIDDEN.has(e.name) || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else res.push(path.relative(root, p));
      }
    };
    await walk(root, 0);
    return res;
  }
}

interface Pending {
  files: Set<string>;
  git: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

class Watcher extends EventEmitter {
  watchers = new Map<string, fs.FSWatcher>();
  gitWatchers = new Map<string, fs.FSWatcher>();
  pending = new Map<string, Pending>();
  refreshTimer: NodeJS.Timeout | undefined;

  watch(root: string) {
    if (this.watchers.has(root)) return;
    try {
      const w = fs.watch(root, { recursive: true }, (_ev, rel) => {
        if (!rel) return;
        rel = String(rel);
        const gitMeta = /^\.git[\\/](index|HEAD)$/.test(rel);
        if (!gitMeta && WATCH_IGNORE.test(rel)) return;
        this.queue(root, gitMeta ? null : path.join(root, rel));
      });
      w.on('error', () => this.unwatch(root));
      this.watchers.set(root, w);
    } catch {
      /* unsupported fs */
    }
    this.watchGitDir(root);
  }

  /** A linked worktree's .git is a file; its index/HEAD live in the main repo's .git/worktrees/<name>, outside the recursive watch. */
  watchGitDir(root: string) {
    try {
      const dot = path.join(root, '.git');
      if (!fs.statSync(dot).isFile()) return;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
      if (!m) return;
      const w = fs.watch(path.resolve(root, m[1].trim()), (_ev, name) => {
        if (name === 'index' || name === 'HEAD') this.queue(root, null);
      });
      w.on('error', () => {
        try {
          w.close();
        } catch {
          /* */
        }
        this.gitWatchers.delete(root);
      });
      this.gitWatchers.set(root, w);
    } catch {
      /* not a linked worktree */
    }
  }

  queue(root: string, file: string | null) {
    let p = this.pending.get(root);
    if (!p) {
      p = { files: new Set(), git: false, timer: null };
      this.pending.set(root, p);
    }
    if (file) p.files.add(file);
    else p.git = true;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      this.pending.delete(root);
      const changes = [...p.files].map((f) => ({ path: f, type: fs.existsSync(f) ? 2 : 3 }));
      this.emit('changed', root, changes, p.git);
    }, 150);
  }

  unwatch(root: string) {
    const w = this.watchers.get(root);
    if (w) {
      try {
        w.close();
      } catch {
        /* */
      }
      this.watchers.delete(root);
    }
    const g = this.gitWatchers.get(root);
    if (g) {
      try {
        g.close();
      } catch {
        /* */
      }
      this.gitWatchers.delete(root);
    }
  }

  keepOnly(roots: string[]) {
    for (const r of [...this.watchers.keys()]) if (!roots.includes(r)) this.unwatch(r);
  }
  dispose() {
    for (const r of [...this.watchers.keys()]) this.unwatch(r);
  }
}

export {
  copyInto,
  create,
  fileIndex,
  gitAheadBehind,
  gitBlame,
  gitBranches,
  gitChangedRanges,
  gitChanges,
  gitCommit,
  gitCommitFiles,
  gitCommitMessage,
  gitCommitPr,
  gitDiffStat,
  gitDiscard,
  gitLog,
  gitShow,
  gitStage,
  gitStatus,
  gitSwitch,
  gitUndoCommit,
  gitUnstage,
  imageUrl,
  list,
  read,
  rename,
  resolveFile,
  Watcher,
  write,
};
