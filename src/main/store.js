'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  // command started in a new agent session (any CLI agent: claude, codex, opencode, aider, …)
  agentCommand: 'claude',
  // used when a worktree had agents before but their tmux sessions are gone (e.g. after a reboot)
  resumeCommand: 'claude --continue',
  // path to desktop VS Code CLI for "Open in VS Code" (auto-detected when empty)
  codeCommand: '',
  // Ruby language server command; empty = ruby-lsp from your PATH / version manager
  rubyLspCommand: '',
  // Catppuccin flavor: 'system' (Latte by day, Mocha at night, follows the OS), 'latte' or 'mocha'
  theme: 'system',
  editorFontSize: 13,
  editorFontFamily: '',
  // where new worktrees go; empty = "<repo>.worktrees" next to the repo
  worktreeRoot: '',
  // where new scratch workspaces go (a folder per scratch); empty = "scratch" in Tawny's data dir; ~ is expanded
  scratchRoot: '',
  copyOnCreate: ['.env', '.env.local'],
  // run agents in tmux so they survive quitting Tawny
  useTmux: true,
  notifyWhenAgentFinishes: true,
  // chat tabs speak ACP to an agent subprocess. chatAgent: which agent the "Chat" launcher row starts.
  // acpAgents: { name: { command, args, env, label } } adds more (Claude is built in as "claude")
  chatAgent: 'claude',
  acpAgents: {},
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'harbor.json');
    this.data = { repos: [], active: null, knownSessions: [], settings: {}, ui: {} };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
    this.data.settings = { ...DEFAULT_SETTINGS, ...this.data.settings };
    this.save();
  }
  get settings() { return this.data.settings; }
  reloadSettings() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
    } catch { /* keep */ }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  set(k, v) { this.data[k] = v; this.save(); }
}

module.exports = { Store, DEFAULT_SETTINGS };
