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

## Local review: `tawny review`

Works in a worktree with a local review ([local-review-plan.md](local-review-plan.md)). Commands with a positional argument also accept the flag form (`--id`); commands marked *stdin* read that param from a quoted heredoc when no flag gives it, which keeps shell metacharacters out of argv (Tawny auto-allows `tawny` calls only without `;&|$()<>` and backticks in the arguments).

| Command | What it does |
|---|---|
| `tawny review resolve <id>` (*stdin*: note) | Mark an item fixed with a note on what changed. Any chat or terminal in the worktree. |
| `tawny review get` | The items: id, status, path:line, outdated, text, suggestion, fix note. |
| `tawny review propose-comment` (*stdin*: body) | Review chats only. Same flags as `tawny pr propose-comment`, without `--side` (always the working tree). |

```sh
tawny review resolve r-toolu_abc-0 <<'EOF'
isValid now compares with Math.floor(Date.now() / 1000)
EOF
```

## Workspaces: `tawny workspace`

| Command | What it does |
|---|---|
| `tawny workspace list` | All workspaces: `path`, `name`, `branch`, `kind` (`main`, `worktree`, `folder`, `scratch`), `repo`, `active`. |
| `tawny workspace show [<path\|name>]` | One workspace (default: the current one). |
| `tawny workspace current` | The workspace this terminal or chat runs in (from `TAWNY_WORKTREE`). |

Tab, file and chat commands act on the current workspace; `--workspace <path|name>` overrides it. An unknown value errors with the valid ones.

## Files and tabs (Phase 2)

| Command | What it does |
|---|---|
| `tawny file open <path> [--line n] [--focus]` | Open a file as a tab; prints the tab id (`f:<abs path>`). Paths are absolute or relative to the workspace; outside it or missing errors. Opens in the background unless `--focus` (`--line` only applies with `--focus`). |
| `tawny file diff <path> [--focus]` | Open the diff of a changed file (working tree, else staged) as a tab (`d:<mode>:<abs path>`). Errors if the file has no uncommitted changes. |
| `tawny file open-changed [--focus]` | Open a diff tab for every changed file; prints the tab ids. |
| `tawny tab list [--workspace W]` | Tabs of a workspace: `id`, `kind` (`chat`, `agent`, `terminal`, `file`, `diff`, ...), `title`, `workspace`, `focused`. Chats and terminals use the session id (= `TAWNY_CHAT_ID`); other tabs use their layout key (e.g. `f:/path`). |
| `tawny tab focus <id> [--workspace W]` / `tawny tab close <id> [--workspace W]` | Raise a tab and its workspace / close it. Unknown ids error with the valid ones. |
| `tawny notify [<tab>]` | Mark a chat tab (default: the calling chat) as needing attention: the "!" mark in the sidebar and attention chips, cleared when the tab is focused. No message, toast or OS notification. No-op if the tab is already focused; errors for unknown ids and terminals. |

File commands open tabs in the active workspace: for another workspace, pass `--focus` (switches to it) or the command errors.

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
- **Command hangs or is blocked in an agent**: the agent's permission prompt or sandbox may be blocking the shell call or the socket. `tawny ...` calls (plain args, optionally one quoted heredoc) are auto-allowed in Tawny chats; chained commands (`tawny x; rm y`) still prompt.
- **Sandboxed agents (e.g. Codex)**: unverified whether the sandbox allows connecting to the unix socket (needs a live agent to test). If blocked, allow `<userData>/tawny-<pid>.sock` in the agent's sandbox config.
- **`tawny: not in a PR review chat`**: `tawny pr` needs the chat's PR context; run it from the PR review chat.
