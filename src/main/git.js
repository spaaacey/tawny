// git worktree + tmux helpers (shared with the Tawny VS Code extension; same session naming).
'use strict';
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        err.message = (err.stderr.trim() || err.message);
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

const git = (cwd, args) => run('git', ['-C', cwd, ...args]);

/** Parse `git worktree list --porcelain`. */
function parseWorktrees(out) {
  const list = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur);
      cur = { path: line.slice(9), head: '', branch: '', detached: false, bare: false, locked: false, prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  if (cur) list.push(cur);
  return list.filter(w => !w.bare);
}

async function listWorktrees(repo) {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  const list = parseWorktrees(out);
  list.forEach((w, i) => { w.main = i === 0; w.repo = repo; });
  return list;
}

async function dirtyCount(dir) {
  try {
    const out = await git(dir, ['status', '--porcelain']);
    return out.split('\n').filter(Boolean).length;
  } catch { return -1; }
}

/** Main repo root (the main worktree) for any path inside a repo or a linked worktree. */
async function repoRootFor(dir) {
  const common = (await git(dir, ['rev-parse', '--git-common-dir'])).trim();
  const abs = path.resolve(dir, common);
  if (path.basename(abs) === '.git') return path.dirname(abs);
  // bare repo or unusual layout: ask git for the main worktree
  const wts = await listWorktrees(dir);
  return wts[0] ? wts[0].path : dir;
}

async function branchExists(repo, branch) {
  try { await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; }
  catch { return false; }
}

async function currentBranch(dir) {
  try { return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); }
  catch { return 'HEAD'; }
}

const slug = s => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wt';

async function addWorktree(repo, branch, base, root) {
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

function copyIntoWorktree(repo, dir, files) {
  const copied = [];
  for (const f of files || []) {
    const src = path.join(repo, f), dst = path.join(dir, f);
    try {
      if (fs.existsSync(src) && fs.statSync(src).isFile() && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        copied.push(f);
      }
    } catch { /* ignore */ }
  }
  return copied;
}

async function removeWorktree(repo, dir, force) {
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
}

// ---------- tmux ----------

/** Stable session-name prefix for a worktree path. */
function sessionPrefix(dir) {
  const h = crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 6);
  const base = slug(path.basename(dir)).replace(/[.:]/g, '-').slice(0, 24);
  return `harbor_${base}_${h}`;
}

let tmuxOk;
async function hasTmux() {
  if (tmuxOk === undefined) {
    try { await run('tmux', ['-V']); tmuxOk = true; } catch { tmuxOk = false; }
  }
  return tmuxOk;
}

/** All harbor tmux panes: [{name, activity, cmd, cwd}] */
async function listSessions() {
  try {
    const out = await run('tmux', ['list-panes', '-a', '-F',
      '#{session_name}|#{window_activity}|#{session_attached}|#{pane_current_command}|#{pane_current_path}']);
    const seen = new Map();
    for (const line of out.split('\n')) {
      // tmux mangles tabs in formats; '|' is safe because cwd (which may contain it) is last
      const [name, act, attached, cmd, ...rest] = line.split('|');
      const cwd = rest.join('|');
      if (!name || !name.startsWith('harbor_')) continue;
      const activity = Number(act) || 0;
      const prev = seen.get(name);
      if (!prev || activity > prev.activity) seen.set(name, { name, activity, cmd, cwd, attached: Number(attached) || 0 });
    }
    return [...seen.values()];
  } catch { return []; } // no server running
}

/** Pane title per harbor tmux session (tmux doesn't forward titles to our pty; Claude Code keeps its busy/idle glyph there). */
async function paneTitles() {
  try {
    const out = await run('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_title}']);
    const titles = new Map();
    for (const line of out.split('\n')) {
      const i = line.indexOf(' ');
      if (i > 0 && line.startsWith('harbor_')) titles.set(line.slice(0, i), line.slice(i + 1));
    }
    return titles;
  } catch { return new Map(); }
}

const sessionIndex = name => Number(name.split('_').pop()) || 0;

async function createSession(name, cwd, command) {
  const sh = process.env.SHELL || '/bin/sh';
  const cmd = command ? `${command}; exec ${sh} -l` : `exec ${sh} -l`;
  await run('tmux', ['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', cmd], {
    env: { ...process.env, TMUX: '' },
  });
  // per-session niceties; never touch the user's global tmux config
  for (const [k, v] of [['mouse', 'on'], ['status', 'off'], ['window-size', 'latest']]) {
    try { await run('tmux', ['set-option', '-t', name, k, v]); } catch { /* old tmux */ }
  }
}

async function killSession(name) {
  try { await run('tmux', ['kill-session', '-t', name]); } catch { /* gone */ }
}

module.exports = {
  run, git, parseWorktrees, listWorktrees, dirtyCount, repoRootFor, currentBranch,
  addWorktree, copyIntoWorktree, removeWorktree, slug,
  sessionPrefix, hasTmux, listSessions, paneTitles, sessionIndex, createSession, killSession,
};
