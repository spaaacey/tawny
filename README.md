# Harbor

Orca-style agent workspaces with a fast code editor (Monaco + language servers) per worktree.

```
┌ Workspaces ──┬ agent 1 · agent 2 · user.rb · routes.rb ┬ Files ─────┐
│ repo         │ class User < Application…               │ ▾ app      │
│  ● main      │                                         │   models   │
│  ◌ feat/auth │                                         │   …        │
│  ◌ fix/tests │ ● Ruby LSP   ⊗ 0 ⚠ 1                    │            │
└──────────────┴─────────────────────────────────────────┴────────────┘
```

- **Workspaces**: repos → git worktrees, with agent state (spinner = working, green = idle) and uncommitted-change count. ⌥⌘N creates a worktree (copies `.env`, can start an agent).
- **Editor**: files open as tabs next to the agent tabs (same bar, one view at a time). Monaco with file tree (git status colors), ⌘P fuzzy file search (`name:line` works). Buffers reload live when an agent edits files.
- **Language servers**, one per worktree:
  - TypeScript / JavaScript — TypeScript 7's native language server (bundled; uses the project's own TS 7 if present).
  - Ruby / Rails / ERB — [ruby-lsp](https://shopify.github.io/ruby-lsp/) from your Ruby (asdf/rbenv/chruby work). Rails apps get `ruby-lsp-rails` automatically. Falls back to `solargraph`.
  - Errors & warnings, hover, completion, signature help, go to definition (F12 / ⌘-click), references (⇧F12), rename (F2), quick fixes (⌘.), format (⇧⌥F), outline (⇧⌘O).
- **Agent pane** per worktree: any CLI agent (`claude` default) in tmux — keeps running when you switch worktrees or quit Harbor. Multiple agents as tabs. ⌥⌘L sends the current selection (`@file#L5-10`) to the agent. Notification + dock badge when an agent finishes.

## Run (macOS)

Needs Node 18+, git, tmux (`brew install tmux`). For Ruby: `gem install ruby-lsp` (Harbor offers to install it if missing).

```bash
cd harbor-app
npm install
npm start
```

Dev instance (isolated, for working on Harbor with Harbor): run from a git worktree of this repo.

```bash
npm run dev [-- --port 9333 --data /tmp/harbor-dev-x --repo <path>]
```

Uses its own data dir (default `$TMPDIR/harbor-dev-<hash>`, never the real one), tmux off (so it can't adopt/kill your real agents), window/dock named "Harbor Dev", and a CDP port for agents (Playwright `connectOverCDP('http://localhost:9333')`). Use a distinct `--data` and `--port` per parallel instance. Hot reload: renderer edits reload the window, main-process edits restart the app.

Standalone app: `npm run dist` → `dist/mac-arm64/Harbor.app` (unsigned).

## Shortcuts

| | |
|---|---|
| ⌘P | go to file |
| ⌘S / ⌘W | save / close tab |
| ⌘B / ⌥⌘B | toggle sidebar / file tree |
| F12, ⌘-click / ⇧F12 / F2 | definition / references / rename |
| ⌃- / ⌃⇧- | back / forward |
| ⌥⌘L | send selection to agent |
| ⌥⌘P | switch worktree |
| ⌥⌘1…9 / ⌥⌘↑↓ | jump / cycle worktrees |
| ⌥⌘E / ⌥⌘A / ⌥⌘T | focus editor / focus agent / new agent |
| ⌥⌘← / ⌥⌘→ | previous / next tab in the pane |
| ⌘J, then 1…9 | focus pane by number (⌘J again cycles; esc cancels) |
| ⇧⌥⌘← / ⇧⌥⌘→ | move tab to previous / next pane (splits at the ends) |
| ⌥⌘O | open worktree in desktop VS Code |

## Settings

Settings opens `~/Library/Application Support/Harbor/harbor.json`:

| key | default | |
|---|---|---|
| `agentCommand` | `claude` | any CLI agent: `codex`, `opencode`, `aider`, … |
| `resumeCommand` | `claude --continue` | when a worktree's agents were lost (reboot) |
| `rubyLspCommand` | | e.g. `bundle exec ruby-lsp`; empty = auto |
| `theme` | `system` | Catppuccin flavor: `latte`, `mocha`, or `system` (follows the OS light/dark setting); applies on window focus |
| `editorFontSize` / `editorFontFamily` | `13` / SF Mono | |
| `worktreeRoot` | | default `<repo>.worktrees/` next to the repo |
| `copyOnCreate` | `[".env", ".env.local"]` | |
| `useTmux` | `true` | |

## Troubleshooting

- **Agent pane shows "posix_spawnp failed"**: `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` (done automatically by `npm install`).
- **Ruby LSP not running**: the status bar shows why; "Install ruby-lsp" runs `gem install ruby-lsp` with the project's Ruby. View → Restart Language Servers after changing Ruby versions.
