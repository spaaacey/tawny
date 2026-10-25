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

- **Workspaces**: repos → git worktrees, with agent state (spinner = working, green = idle) and uncommitted-change count. `cmd+option+n` creates a worktree (copies `.env`, can start an agent).
- **Editor**: files open as tabs next to the agent tabs (same bar, one view at a time). Monaco with file tree (git status colors), `cmd+p` fuzzy file search (`name:line` works). Buffers reload live when an agent edits files.
- **Language servers**, one per worktree:
  - TypeScript / JavaScript — TypeScript 7's native language server (bundled; uses the project's own TS 7 if present).
  - Ruby / Rails / ERB — [ruby-lsp](https://shopify.github.io/ruby-lsp/) from your Ruby (asdf/rbenv/chruby work). Rails apps get `ruby-lsp-rails` automatically. Falls back to `solargraph`.
  - Errors & warnings, hover, completion, signature help, go to definition (`f12` / `cmd`+click), references (`shift+f12`), rename (`f2`), quick fixes (`cmd+.`), format (`shift+option+f`), outline (`cmd+shift+o`).
- **Debugger**: breakpoints, stepping, variables and a debug console for Node and Ruby (`f5`). See [docs/debugging.md](docs/debugging.md).
- **Agent pane** per worktree: any CLI agent (`claude` default) in tmux — keeps running when you switch worktrees or quit Harbor. Multiple agents as tabs. `cmd+option+l` sends the current selection (`@file#L5-10`) to the agent. Notification + dock badge when an agent finishes.

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
| `cmd+shift+p` | command palette (same box as `cmd+p`; backspace the `>` for file search): every menu action plus split pane right/down, secondary sidebar files/source, move sidebars to the other side |
| `cmd+p` | go to file |
| `cmd+s` / `cmd+w` | save / close tab |
| `cmd+b` / `cmd+option+b` | toggle sidebar / file tree |
| `cmd+shift+m` | toggle rich (Tiptap) / source view of the active `.md` file (`npm run build:rich` rebuilds the bundle) |
| `f12`, `cmd`+click / `shift+f12` / `f2` | definition / references / rename |
| `ctrl+-` / `ctrl+shift+-` | back / forward |
| `cmd+option+l` | send selection to agent (also from the rich markdown view and its right-click menu; the selection becomes source lines) |
| `cmd+option+p` | switch worktree |
| `cmd+option+1`…`9` / `cmd+option+arrow_up`, `cmd+option+arrow_down` | jump / cycle worktrees |
| `cmd+option+e` / `cmd+option+a` / `cmd+option+t` | focus editor / focus agent / new agent |
| `cmd+option+arrow_left` / `cmd+option+arrow_right` | previous / next tab in the pane |
| `cmd+j`, then `1`…`9` | focus pane by number (`cmd+j` again cycles; `esc` cancels) |
| `cmd+option+shift+arrow_left` / `cmd+option+shift+arrow_right` | move tab to previous / next pane (splits at the ends) |
| `cmd+option+o` | open worktree in desktop VS Code |
| `f5` / `shift+f5` / `f9` | start or continue debugging / stop / toggle breakpoint (`f10`, `f11`, `shift+f11` step; see [debugging](docs/debugging.md)) |

## Settings

Settings opens `~/Library/Application Support/Harbor/harbor.json`:

| key | default | |
|---|---|---|
| `agentCommand` | `claude` | any CLI agent: `codex`, `opencode`, `aider`, … |
| `resumeCommand` | `claude --continue` | when a worktree's agents were lost (reboot) |
| `rubyLspCommand` | | e.g. `bundle exec ruby-lsp`; empty = auto |
| `theme` | `system` | Catppuccin flavor: `latte`, `mocha`, or `system` (follows the OS light/dark setting); applies on window focus |
| `editorFontSize` / `editorFontFamily` | `13` / SF Mono | |
| `richMarkdown` | `true` | open `.md` files in the rich (Tiptap) view; `false` opens them as source |
| `worktreeRoot` | | default `<repo>.worktrees/` next to the repo |
| `copyOnCreate` | `[".env", ".env.local"]` | |
| `useTmux` | `true` | |

## Troubleshooting

- **Agent pane shows "posix_spawnp failed"**: `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` (done automatically by `npm install`).
- **Ruby LSP not running**: the status bar shows why; "Install ruby-lsp" runs `gem install ruby-lsp` with the project's Ruby. View → Restart Language Servers after changing Ruby versions.
