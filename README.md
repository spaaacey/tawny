# Tawny

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
- **Editor**: files open as tabs next to the agent tabs (same bar, one view at a time). Monaco with file tree (git status colors), `cmd+p` fuzzy file search (`name:line` works; Text tab searches file contents). Buffers reload live when an agent edits files.
- **Language servers**, one per worktree:
  - TypeScript / JavaScript — TypeScript 7's native language server (bundled; uses the project's own TS 7 if present).
  - Ruby / Rails / ERB — [ruby-lsp](https://shopify.github.io/ruby-lsp/) from your Ruby (asdf/rbenv/chruby work). Rails apps get `ruby-lsp-rails` automatically. Falls back to `solargraph`.
  - Errors & warnings, hover, completion, signature help, go to definition (`f12` / `cmd`+click), references (`shift+f12`), rename (`f2`), quick fixes (`cmd+.`), format (`shift+option+f`), outline (`cmd+shift+o`).
- **Debugger**: breakpoints, stepping, variables and a debug console for Node and Ruby (`f5`). See [docs/debugging.md](docs/debugging.md).
- **Agent pane** per worktree: any CLI agent (`claude` default) in tmux — keeps running when you switch worktrees or quit Tawny. Multiple agents as tabs. `cmd+option+l` sends the current selection (`@file#L5-10`) to the agent. Notification + dock badge when an agent finishes.

## Run (macOS)

Needs Node 18+, git, tmux (`brew install tmux`). For Ruby: `gem install ruby-lsp` (Tawny offers to install it if missing).

```bash
cd tawny
npm install
npm start
```

UI components / design-system layer: [docs/ui-layer.md](docs/ui-layer.md).

Landing a worktree on `main` without a merge commit: [docs/worktree-workflow.md](docs/worktree-workflow.md).

Dev instance (isolated, for working on Tawny with Tawny): run from a git worktree of this repo.

```bash
npm run dev [-- --port <n> --data /tmp/tawny-dev-x --repo <path>]
```

Uses its own data dir (default `$TMPDIR/tawny-dev-<hash>`, never the real one), tmux off (so it can't adopt/kill your real agents), window/dock named "Tawny Dev", and a CDP port for agents (Playwright `connectOverCDP('http://localhost:9333')`). Without `--port` it picks the first free port from 9333, so parallel worktrees don't collide (the port is printed at startup and shown in the dev banner and dock icon). Hot reload: renderer edits reload the window, main-process edits restart the app.

Standalone app: `npm run dist` → `dist/Tawny-<version>-arm64.dmg` (unsigned).

## Shortcuts

| | |
|---|---|
| `cmd+shift+p` | command palette (same box as `cmd+p`, opened on the Commands tab): every menu action plus split pane right/down, secondary sidebar files/source, move sidebars to the other side |
| `cmd+p` | go to file; the box has Files / Commands / Text tabs, `left` / `right` at the input's edge switch between them (typing `>` or `#` first also works) |
| `cmd+s` / `cmd+w` | save / close tab (an empty pane closes the pane) |
| `cmd+n` / `cmd+t` / `cmd+j` | new tab launcher in this pane / in a new pane to the right / in a new pane below |
| `cmd+b` / `cmd+option+b` | toggle sidebar / file tree |
| `cmd+option+f` | find in files: the `cmd+p` box in `#` mode (seeded with the selection) with case / whole word / regex, include / exclude globs, replace; press again to carry it over to the secondary sidebar's Find view |
| `cmd+shift+m` | toggle rich (Tiptap) / source view of the active `.md` file (`npm run build:rich` rebuilds the bundle) |
| `f12`, `cmd`+click / `shift+f12` / `f2` | definition / references / rename |
| `ctrl+-` / `ctrl+shift+-` | back / forward |
| `cmd+option+l` | send selection to agent: opens a message box (cmd+enter sends, shift+tab cycles agents) (also from the rich markdown view and its right-click menu; the selection becomes source lines) |
| `cmd+option+p` | switch worktree |
| `cmd+option+1`…`9` / `cmd+option+arrow_up`, `cmd+option+arrow_down` | jump / cycle worktrees |
| `cmd+option+e` / `cmd+option+a` / `cmd+option+t` | focus editor / focus agent / new agent |
| `cmd+option+arrow_left` / `cmd+option+arrow_right` | previous / next tab in the pane |
| `cmd+shift+j`, then `1`…`9` | focus pane by number (`cmd+shift+j` again cycles; `esc` cancels) |
| `cmd+option+shift+arrow_left` / `cmd+option+shift+arrow_right` | move tab to previous / next pane (splits at the ends) |
| `cmd+option+o` | open worktree in desktop VS Code |
| `f5` / `shift+f5` / `f9` | start or continue debugging / stop / toggle breakpoint (`f10`, `f11`, `shift+f11` step; see [debugging](docs/debugging.md)) |

## Settings

Settings opens `~/Library/Application Support/Tawny/tawny.json`:

| key | default | |
|---|---|---|
| `agentCommand` | `claude` | any CLI agent: `codex`, `opencode`, `aider`, … |
| `resumeCommand` | `claude --continue` | when a worktree's agents were lost (reboot) |
| `rubyLspCommand` | | e.g. `bundle exec ruby-lsp`; empty = auto |
| `theme` | `system` | Catppuccin flavor: `latte`, `mocha`, or `system` (follows the OS light/dark setting); applies on window focus |
| `editorFontSize` / `editorFontFamily` | `13` / SF Mono | |
| `smoothScrolling` | `true` | editor smooth scrolling and animated caret; `false` turns both off (applies to newly opened editors) |
| `stickyScrollMaxLines` | `1` | max pinned scope lines at the top of the editor (applies to newly opened editors) |
| `richMarkdown` | `true` | open `.md` files in the rich (Tiptap) view; `false` opens them as source |
| `worktreeRoot` | | default `<repo>.worktrees/` next to the repo |
| `scratchRoot` | | folder holding all new scratch workspaces (one subfolder each); default `scratch/` in Tawny's data dir. `~` ok; existing scratches stay where they are |
| `copyOnCreate` | `[".env", ".env.local"]` | |
| `useTmux` | `true` | |

## Codex chat

Open the new-tab launcher (`cmd+n`) and choose **Codex Chat**. Install and sign
in to the current Codex CLI first:

```bash
npm install -g @openai/codex
codex login
```

Tawny uses the installed CLI's `codex app-server` interface for Codex chats.
Models, reasoning levels, authentication, permissions and execution come from
that runtime. `/fork` branches the conversation in the current tab. Other chat
agents continue to use ACP. The older `codex-acp`
adapter is no longer required; its embedded runtime cannot use the current
ChatGPT model catalog reliably.

Set `settings.chatAgent` to `"codex"` to put Codex first in the chat launcher.
Codex conversations remain in Codex's history when their Tawny tab is closed.
A pre-existing custom `acpAgents.codex` entry still selects that external ACP
command; remove that entry to use the native Codex integration.

## Troubleshooting

- **Agent pane shows "posix_spawnp failed"**: `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` (done automatically by `npm install`).
- **Ruby LSP not running**: the status bar shows why; "Install ruby-lsp" runs `gem install ruby-lsp` with the project's Ruby. View → Restart Language Servers after changing Ruby versions.
