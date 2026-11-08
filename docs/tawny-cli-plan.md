# `tawny` CLI: drive the app from a shell (replaces the `tawny-pr` MCP server)

Goal: a general `tawny` command that agents and humans run to control the running app. PR review (`tawny pr ...`) is the first command group and replaces the `tawny-pr` MCP server. Chat/orchestration commands from [orchestrator-plan.md](orchestrator-plan.md) (Phase 2) build on the same foundation.

Human reference (what the CLI looks like to use): [tawny-cli.md](tawny-cli.md). Keep it in sync as commands land.

## Why

- `tawny-pr-mcp.js` is already a stateless stdio-to-socket relay: agent, then MCP script, then unix socket, then `pr-agent.ts`. The MCP layer adds nothing the socket doesn't have.
- Herdr and Orca both expose a CLI over a local socket, with no MCP server of their own. Agents learn the CLI from a skill, gated on an env var (see the research summary in the orchestrator plan).
- A CLI works for humans, scripts and any agent with a shell. MCP only works for agents that accept an MCP config.

## Today (what exists)

- `src/main/tawny-pr-mcp.js` (built from `tawny-pr-mcp.ts`): MCP stdio server with `propose_comment`, `get_pr`, `get_threads`. Relays line-JSON to `$TAWNY_PR_SOCKET`.
- `src/main/pr-agent.ts`: one unix socket per PR chat (`os.tmpdir()/tawny-pr-<pid>-<rand>.sock`), passes the MCP config via ACP `mcpServers` (`acp.ts`), owns the findings list.
- `src/main/hooks.ts`: local HTTP server for Claude Code hooks (agent state). Port written to a file.

## Decisions

| # | Decision | Reason | Rejected |
|---|---|---|---|
| 1 | One app-level unix socket per Tawny instance, stable path, mode `0600` | File permissions are the auth; no token to leak into env or logs. `pr-agent.ts` already speaks this protocol. | HTTP + token (the orchestrator plan's first idea): works too, but needs a port file and token plumbing. Revisit if remote access is wanted. |
| 1b | Socket and discovery file live in the app's `userData` dir (durable, like Orca and herdr): `<userData>/tawny-<pid>.sock` plus `<userData>/runtime.json` (`{ pid, socket, version }`) | A plain terminal outside Tawny can find the running app by reading `runtime.json`. Dev instances already get their own `userData` via `TAWNY_USER_DATA`, so they never touch the real `Tawny` dir or collide. | `os.tmpdir()`: not discoverable from outside without env vars. |
| 1c | Agents in every chat (not just PR chats) get `tawny` on `PATH` | Commands act on the caller's own workspace; harmless. | PR chats only |
| 1d | `tawny *` shell calls are allowed without a prompt in Tawny-launched chats | They only affect Tawny's own UI, never GitHub; a prompt per proposed comment would be noise. | Prompt each time |
| 2 | Methods live in a registry in main: `{ name, summary, params (zod), handler }` | CLI parsing, `--help`, `agent-context` and validation all derive from it, so docs can't drift from behaviour. | Hand-written argv parsing per command |
| 3 | Session context comes from env vars injected into chat adapters and PTYs | `tawny pr propose-comment` needs no `--pr`/`--chat` flags; commands act on "my" workspace by default. | Passing ids in the prompt |
| 4 | CLI is an Electron-as-Node script outside asar, with a `bin/tawny` shim added to `PATH` in Tawny's PTYs and chat adapter processes | Same approach as Orca; no global install needed at first. | Native client binary (later, if startup time hurts) |
| 5 | Output is JSON on stdout by default for data commands, human text with `--text`; errors go to stderr, exit code 1 | Agents parse it; humans can add `--text`. | Pretty by default |
| 6 | Remove the MCP server once `tawny pr` works. No MCP wrapper for now. | One interface to maintain. | Keeping both |
| 7 | Discovery: `tawny agent-context` prints the command schema as JSON; a bundled skill teaches the workflow | Same as Orca. A system-prompt line covers sessions without the skill. | Only `--help` |

## Protocol

Line-delimited JSON over the socket, one request and one response per connection (as now):

```
-> {"method":"pr.propose_comment","params":{...},"ctx":{"chatId":"...","worktree":"..."}}\n
<- {"result":...}\n   or   {"error":"message"}\n
```

`ctx` comes from env (`TAWNY_CHAT_ID`, `TAWNY_WORKTREE`). The server re-checks that the chat exists; it never trusts `ctx` for anything beyond choosing the default target.

## Environment (injected by Tawny)

| Var | Meaning |
|---|---|
| `TAWNY=1` | Running inside Tawny (skills gate on this) |
| `TAWNY_SOCKET` | Path to the app socket |
| `TAWNY_CHAT_ID` | Chat tab this process belongs to (chat adapters) |
| `TAWNY_PANE_ID` | Terminal pane (PTYs) |
| `TAWNY_WORKTREE` | Absolute path of the current worktree |

Dev instances get their own socket path, so parallel worktrees never collide.

## Phases

### Phase 1: foundation + `tawny pr` (replaces MCP)

- [x] Command registry in main (`src/main/cli/registry.ts`) and the app-level socket server (`src/main/cli/server.ts`), mode `0600`, path `<userData>/tawny-<pid>.sock` plus `<userData>/runtime.json`; both removed on quit, stale ones (dead pid) ignored by the CLI. Unix socket paths max out around 104 chars on macOS: if `TAWNY_USER_DATA` makes the path too long, fall back to `os.tmpdir()` and record that path in `runtime.json`.
- [x] Env injection for chat adapter processes (`acp.ts`) and PTYs.
- [x] `src/cli/tawny.ts` client: parse argv from the registry, relay, print. Build it next to `tawny-pr-mcp`; `bin/tawny` shim; add `bin` to `PATH` for PTYs and adapters.
- [x] Port `propose_comment`, `get_pr`, `get_threads` to `pr.*` methods (handlers move out of `PrAgent.handle`). Resolve the PR session from `TAWNY_CHAT_ID`.
- [x] `tawny pr propose-comment` accepts `--body-file -` (stdin) and `--suggestion-file -`.
- [x] `tawny agent-context`, `tawny status`, `tawny --help`.
- [x] Update `src/shared/pr-instructions.ts` (default PR instructions) to name `tawny pr propose-comment` instead of the MCP tool; drop `mcpServers` from `pr-agent.ts` / `acp.ts`; delete `tawny-pr-mcp.ts`.
- [x] Verified from a shell with the env set against a dev instance (no ACP fixture agent): finding persisted; `tawny` on PATH in a terminal pane.
- [ ] Unverified: does the ACP agent's permission flow prompt for every `tawny` shell call? If so, add an allow rule for `tawny *` for Tawny-launched chats.
- [ ] Unverified: sandboxed agents (e.g. Codex) can reach the unix socket. If not, document the limitation.

Implemented: `src/main/cli/{registry,server,env}.ts`, `src/cli/tawny.ts`, shim generated into `<userData>/bin/tawny` each launch. `acp.ts` auto-allows `tawny ...` execute calls (untested against a live adapter).

### Phase 2: workspace surface

- [ ] `tawny file open|diff|open-changed` (open a tab, don't steal focus unless `--focus`).
- [ ] `tawny tab list|focus|close`, `tawny workspace list|show|current`.
- [ ] `tawny notify`.

### Phase 3: chats (shared with orchestrator plan)

- [ ] `tawny chat new|list|send|read|wait` as specified in [orchestrator-plan.md](orchestrator-plan.md) Phase 2. That plan's "control endpoint" becomes this socket.
- [ ] Skill: `tawny skills get tawny` prints a guide matching the installed version; stub in `~/.claude/skills/tawny/SKILL.md`, gated on `TAWNY=1`.

### Later

- Remote access (TCP/SSH forwarding with auth), mobile.
- `tawny pane split|read|send`, `tawny pr` write actions that touch GitHub (submit review).

## Open questions

None left; all decided (see Decisions 1b-1d).
