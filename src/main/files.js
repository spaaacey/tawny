'use strict';
// File access for the editor: directory listing, read/write, git status, file index for ⌘P, and
// a recursive watcher per worktree so agent edits show up live.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const G = require('./git');

const HIDDEN = new Set(['.git', '.DS_Store', '.ruby-lsp']);
const WATCH_IGNORE = /(^|[\\/])(\.git|node_modules|\.ruby-lsp|tmp|log|\.next|dist|build|coverage|\.turbo|\.cache)([\\/]|$)/;
const MAX_FILE = 8 * 1024 * 1024;

async function list(dir) {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  return ents
    .filter(e => !HIDDEN.has(e.name))
    .map(e => {
      let type = e.isDirectory() ? 'dir' : 'file';
      if (e.isSymbolicLink()) {
        try { type = fs.statSync(path.join(dir, e.name)).isDirectory() ? 'dir' : 'file'; } catch { type = 'file'; }
      }
      return { name: e.name, path: path.join(dir, e.name), type };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
}

async function read(file) {
  const st = await fsp.stat(file);
  if (st.size > MAX_FILE) throw new Error(`File is too large to open (${Math.round(st.size / 1048576)} MB)`);
  const buf = await fsp.readFile(file);
  // crude binary check: NUL byte in the first 8KB
  if (buf.subarray(0, 8192).includes(0)) return { binary: true, text: '', mtime: st.mtimeMs };
  return { binary: false, text: buf.toString('utf8'), mtime: st.mtimeMs };
}

/** Terminal link text (absolute, ~/ or relative to `cwd`) → absolute path of an existing file, else null. */
async function resolveFile(cwd, p) {
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  p = path.resolve(cwd || os.homedir(), p);
  try { return (await fsp.stat(p)).isFile() ? p : null; } catch { return null; }
}

async function write(file, text) {
  await fsp.writeFile(file, text, 'utf8');
  return (await fsp.stat(file)).mtimeMs;
}

/** git status → { relPath: 'M'|'A'|'D'|'?'|'R'|'U' } plus dirs that contain changes */
async function gitStatus(root) {
  try {
    const out = await G.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const map = {};
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const x = p[0], y = p[1];
      let rel = p.slice(3);
      if (x === 'R' || x === 'C') i++; // next entry is the source path
      const code = x === '?' ? '?' : (x === 'U' || y === 'U') ? 'U' : (x === 'A' ? 'A' : (x === 'D' || y === 'D') ? 'D' : (x === 'R' ? 'R' : 'M'));
      map[rel] = code;
      let d = path.dirname(rel);
      while (d && d !== '.' && !map[d + '/']) { map[d + '/'] = '•'; d = path.dirname(d); }
    }
    return map;
  } catch { return {}; }
}

/**
 * git status → { staged: [...], unstaged: [...] } with entries { path (relative), status, orig? }.
 * status: 'M' modified, 'A' added, 'D' deleted, 'R' renamed, 'C' copied, '?' untracked, 'U' conflict.
 */
async function gitChanges(root) {
  const staged = [], unstaged = [];
  try {
    const out = await G.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const x = p[0], y = p[1], rel = p.slice(3);
      let orig;
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') orig = parts[++i];
      const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
      if (x === '?') unstaged.push({ path: rel, status: '?' });
      else if (conflict) unstaged.push({ path: rel, status: 'U' });
      else {
        if (x !== ' ') staged.push({ path: rel, status: x, ...(orig ? { orig } : {}) });
        if (y !== ' ') unstaged.push({ path: rel, status: y });
      }
    }
  } catch { /* not a repo */ }
  return { staged, unstaged };
}

/** File content at `ref` ('HEAD' or 'index') for the diff viewer; { missing } when the path isn't there. */
async function gitShow(root, rel, ref) {
  try {
    const text = await G.git(root, ['show', `${ref === 'index' ? '' : 'HEAD'}:./${rel}`]);
    if (text.slice(0, 8192).includes('\0')) return { binary: true, text: '' };
    return { text };
  } catch { return { missing: true, text: '' }; }
}

/** All files for ⌘P: tracked + untracked-not-ignored (git), else a bounded walk. */
async function fileIndex(root) {
  try {
    const out = await G.git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
    return out.split('\0').filter(Boolean).slice(0, 100000);
  } catch {
    const res = [];
    const walk = async (dir, depth) => {
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

class Watcher extends EventEmitter {
  constructor() { super(); this.watchers = new Map(); this.gitWatchers = new Map(); this.pending = new Map(); }

  watch(root) {
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
    } catch { /* unsupported fs */ }
    this.watchGitDir(root);
  }

  /** A linked worktree's .git is a file; its index/HEAD live in the main repo's .git/worktrees/<name>, outside the recursive watch. */
  watchGitDir(root) {
    try {
      const dot = path.join(root, '.git');
      if (!fs.statSync(dot).isFile()) return;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
      if (!m) return;
      const w = fs.watch(path.resolve(root, m[1].trim()), (_ev, name) => { if (name === 'index' || name === 'HEAD') this.queue(root, null); });
      w.on('error', () => { try { w.close(); } catch { /* */ } this.gitWatchers.delete(root); });
      this.gitWatchers.set(root, w);
    } catch { /* not a linked worktree */ }
  }

  queue(root, file) {
    let p = this.pending.get(root);
    if (!p) { p = { files: new Set(), git: false, timer: null }; this.pending.set(root, p); }
    if (file) p.files.add(file); else p.git = true;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      this.pending.delete(root);
      const changes = [...p.files].map(f => ({ path: f, type: fs.existsSync(f) ? 2 : 3 }));
      this.emit('changed', root, changes, p.git);
    }, 150);
  }

  unwatch(root) {
    const w = this.watchers.get(root);
    if (w) { try { w.close(); } catch { /* */ } this.watchers.delete(root); }
    const g = this.gitWatchers.get(root);
    if (g) { try { g.close(); } catch { /* */ } this.gitWatchers.delete(root); }
  }

  keepOnly(roots) { for (const r of [...this.watchers.keys()]) if (!roots.includes(r)) this.unwatch(r); }
  dispose() { for (const r of [...this.watchers.keys()]) this.unwatch(r); }
}

module.exports = { list, read, resolveFile, write, gitStatus, gitChanges, gitShow, fileIndex, Watcher };
