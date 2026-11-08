# `tawny` CLI

Control a running Tawny from a shell: for agents running inside Tawny, and for you.

> **Status:** Phase 1 (General, `tawny pr`) is implemented; Files/tabs and Chats are planned. Plan and decisions: [tawny-cli-plan.md](tawny-cli-plan.md). Update this file as commands land.

## How it works

```
shell / agent ──▶ tawny (CLI) ──unix socket──▶ Tawny main process ──▶ app UI
```

`tawny` is a thin client. It sends one request to the running app over a local unix socket and prints the reply. The app must be running. Check with `tawny status`.

Inside Tawny terminals and agent chats, `tawny` is already on `PATH` and knows which chat and worktree it was started from, so most commands need no ids.

## Environment

Set by Tawny in its terminals and agent chats. Outside Tawny, `tawny` finds the running app by reading `runtime.json` in Tawny's app data folder; or set `TAWNY_SOCKET` yourself.

| Variable | Meaning |
|---|---|
| `TAWNY` | `1` when running inside Tawny |
| `TAWNY_SOCKET` | Path to the app's socket |
| `TAWNY_CHAT_ID` | The chat tab this process belongs to |
| `TAWNY_PANE_ID` | The terminal pane this process belongs to |
| `TAWNY_WORKTREE` | Absolute path of the current worktree |

## Output and errors

- Data commands print JSON to stdout. Add `--text` for a human-readable form.
- Errors go to stderr as `tawny: <message>`. Exit code is 1.
- `--help` works on every command and group.

## General (Phase 1)

| Command | What it does |
|---|---|
| `tawny status` | Is the app reachable? Prints version and socket path. |
| `tawny agent-context` | Prints the full command schema as JSON, for agents. |
| `tawny --help` | Lists command groups. |

## PR review: `tawny pr` (Phase 1)

Works inside a PR review chat. It replaces the old `tawny-pr` MCP server.

### `tawny pr get`

Prints the PR under review: title, description, refs, head and base sha, state.

### `tawny pr threads`

Prints existing review threads: path, line, resolved, outdated, comments.

### `tawny pr propose-comment`

Proposes an inline review comment. It lands in the reviewer's findings list; the reviewer decides whether to add it to their review. Nothing is posted to GitHub.

| Flag | Required | Meaning |
|---|---|---|
| `--path <file>` | yes | File path relative to the repo root |
| `--line <n>` | yes | Line the comment is on (last line of a range) |
| `--start-line <n>` | no | First line of a multi-line range |
| `--side LEFT\|RIGHT` | no | `RIGHT` (default) is the PR head; `LEFT` is the base |
| `--body <text>` | yes* | The comment, in Markdown |
| `--body-file <file\|->` | yes* | Read the body from a file or stdin (`-`) |
| `--suggestion <text>` | no | Replacement for `--start-line`..`--line` (RIGHT side only) |
| `--suggestion-file <file\|->` | no | Same, from a file or stdin |

\* One of `--body` / `--body-file`.

Prints the new finding's id.

```sh
tawny pr propose-comment --path src/main/pr.ts --line 42 \
  --body-file - <<'EOF'
This swallows the error; log it or rethrow.
EOF
```

## Files and tabs (Phase 2)

| Command | What it does |
|---|---|
| `tawny file open <path> [--line n] [--focus]` | Open a file as a tab. Doesn't steal focus unless `--focus`. |
| `tawny file diff <path> [--focus]` | Open a file's diff as a tab. |
| `tawny file open-changed [--focus]` | Open all changed files as tabs. |
| `tawny tab list` | List open tabs. |
| `tawny tab focus <id>` / `tawny tab close <id>` | Switch to / close a tab. |
| `tawny workspace list` / `show` / `current` | List workspaces (worktrees), show one, or show this one. |
| `tawny notify <message>` | Show a notification in Tawny. |

## Chats (Phase 3)

Shared with the [orchestrator plan](orchestrator-plan.md).

| Command | What it does |
|---|---|
| `tawny chat new --agent claude\|codex [--name N] [--worktree PATH \| --new-worktree NAME] [--prompt TEXT] [--no-focus]` | Open a chat tab; prints `{ chatId, name, worktree, sessionName }`. |
| `tawny chat list` | List chats with id, name, agent, worktree and state. |
| `tawny chat send <id> <text>` | Send a message to a chat. |
| `tawny chat read <id>` | Read recent output from a chat. |
| `tawny chat wait <id>` | Block until the chat is idle. |
| `tawny skills get tawny` | Print the agent guide matching this version. |

## Troubleshooting

- **`tawny: cannot connect`**: Tawny isn't running, or `TAWNY_SOCKET` points at another instance. Dev instances have their own socket.
- **Command hangs or is blocked in an agent**: the agent's permission prompt or sandbox may be blocking the shell call or the socket.
- **`tawny: not in a PR review chat`**: `tawny pr` needs the chat's PR context; run it from the PR review chat.
