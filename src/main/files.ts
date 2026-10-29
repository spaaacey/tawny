// File access for the editor: directory listing, read/write, git status, file index for ⌘P, and
// a recursive watcher per worktree so agent edits show up live.
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

async function list(dir: string) {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  return ents
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => {
      let type: 'dir' | 'file' = e.isDirectory() ? 'dir' : 'file';
      if (e.isSymbolicLink()) {
        try {
          type = fs.statSync(path.join(dir, e.name)).isDirectory() ? 'dir' : 'file';
        } catch {
          type = 'file';
        }
      }
      return { name: e.name, path: path.join(dir, e.name), type };
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

async function write(file: string, text: string) {
  await fsp.writeFile(file, text, 'utf8');
  return (await fsp.stat(file)).mtimeMs;
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
  fileIndex,
  gitAheadBehind,
  gitChanges,
  gitCommit,
  gitCommitFiles,
  gitDiffStat,
  gitDiscard,
  gitLog,
  gitShow,
  gitStage,
  gitStatus,
  gitUndoCommit,
  gitUnstage,
  list,
  read,
  resolveFile,
  Watcher,
  write,
};
