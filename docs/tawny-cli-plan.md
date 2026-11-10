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

### Later

- Remote access (TCP/SSH forwarding with auth), mobile.
- `tawny pane split|read|send`, `tawny pr` write actions that touch GitHub (submit review).

## Phase 2+3 plan: close Phase 1, workspace surface, chats, skill

Goal: finish the CLI. Agents and humans can inspect workspaces and tabs, open files and diffs, flag a tab for attention, spawn and drive chats, and learn all of it from a skill.

### Non-goals

- Toasts or OS notifications (`notify` only sets a tab attention state).
- Panes, GitHub-writing `pr` actions, remote access (see Later).
- Calling a real AI agent in any test (fixture only, per AGENT.md).

### Decisions (grilling Q1-Q7)

| # | Decision | Rejected |
|---|---|---|
| Q1 | One pass covers closing Phase 1, then Phase 2 and 3 | Phase 2 only |
| Q2 | Generic main-to-renderer request/response bridge: main sends `cli:request {id, method, params}`, renderer answers over ipc. Clear error if no window is open. | Mirroring tab state into main; hybrid |
| Q3 | `tawny notify` only marks the caller's tab with an attention state (reuse the `unread` set in `src/renderer/src/store.ts`). No message text, no toast, no OS notification. | Toast + OS notification |
| Q4 | Tabs are addressed by the existing stable session ids (same id as `TAWNY_CHAT_ID`) | Per-call handles, path/title matching |
| Q5 | Tab, file and chat commands act on the caller's worktree (`TAWNY_WORKTREE`); `--workspace <path\|name>` overrides. `workspace list` supplies the values. | Caller-only; always explicit |
| Q6 | `chat new`: default agent, optional `--agent`, `--prompt`, `--workspace`; never steals focus unless `--focus`. Returns the chat id. | Caller's agent only |
| Q7 | Close Phase 1 unverified items with the ACP fixture player; if sandboxed socket access (Codex) can't be tested without a live agent, document it as an unverified limitation | Manual testing by user; leave as is |

### Context for implementers

- Registry: `src/main/cli/registry.ts` (`registry.add({name, summary, params, args, stdin, handler})`; names are `group.command`, snake_case). Methods are registered in `src/main/main.ts` (~line 876, `status`, `cli.schema`), `src/main/pr-agent.ts` (`reg.add`), `src/main/local-review.ts`. New groups follow the same `register(reg)` pattern.
- Socket server: `src/main/cli/server.ts` validates `ctx.chatId` via `agents.chat(id)`. Client: `src/cli/tawny.ts` derives argv parsing and help from the registry schema, so new methods need no client code.
- Main already has `send(ch, ...args)` to the window (`main.ts` ~122) and `agents` (sessions: chats and terminals, `agents.create(dir, {kind})`). Tab layout, open files and the `unread` set live in the renderer (`src/renderer/src/store.ts`, `src/preload/index.ts`, `src/shared/tawny-api.ts` for the IPC typings). Verify exactly where open-file tabs are modelled before ticket 4.
- `acp.ts` ~line 323-327 auto-allows `tawny ...` execute calls; ~857 is the allow site. Local review e2e has a multi-session ACP fixture player (see `docs/local-review-plan.md`, commit 5783c59): reuse it for ticket 1 and chat tests.
- Orchestrator spec for `chat new|list` and the skill: [orchestrator-plan.md](orchestrator-plan.md) Phase 2. Its "control endpoint" is this socket.
- Keep [tawny-cli.md](tawny-cli.md) in sync in every ticket that adds commands. Follow AGENT.md: verify on a dev instance, `npm run typecheck` and `npm run lint`, reuse `@/ui` components, WCAG for any UI (the attention state).

### Tickets

#### 1. Close Phase 1 unverified items
- **Blocked by:** None
- **Delivers:** Confirmed (or fixed) auto-allow of `tawny *` shell calls in Tawny chats; documented sandbox status.
- **Where:** `src/main/acp.ts` (~323, ~857), ACP fixture player from the local review e2e.
- **Steps:** Add a fixture script that issues an execute/permission request for `tawny status` and for a non-tawny command; assert the first auto-allows and the second still prompts. Check that chaining (`tawny x; rm`) is still prompted. Then check Codex's sandbox docs/config for unix socket access; if it can't be verified without a live agent, write the limitation under Phase 1 and in tawny-cli.md.
- **Done when:**
  - [ ] Fixture test passes for allow and prompt cases
  - [ ] Both Phase 1 unverified checkboxes ticked or replaced with a documented note
- **Verify:** run the e2e fixture; typecheck; lint.

#### 2. Renderer bridge + `tawny workspace list|show|current`
- **Blocked by:** None
- **Delivers:** Generic `ctx`-aware request/response channel to the renderer, plus workspace commands built on it (or on main's `allWorkspaces` where the renderer isn't needed).
- **Where:** `src/main/cli/` (new `bridge.ts`), `src/preload/index.ts`, `src/shared/tawny-api.ts`, renderer handler module near `store.ts`, `main.ts` registration.
- **Steps:** Main: `bridge.request(method, params, timeoutMs)` sends `cli:request {id, method, params}` and resolves on the matching `cli:response`; rejects with `no Tawny window open` or on timeout. Renderer: a handler map keyed by method, registered at startup. Add a shared helper to resolve `--workspace <path|name>` (default `ctx.worktree`) to a workspace. Register `workspace.list`, `workspace.show`, `workspace.current` (JSON: path, name, branch, kind). Document in tawny-cli.md.
- **Done when:**
  - [ ] `tawny workspace list|show|current` work against a dev instance
  - [ ] Bridge returns a clear error with no window and on timeout
  - [ ] Unknown `--workspace` gives an error naming valid values
- **Verify:** dev instance, run commands from a terminal pane; close the window and re-run for the error; typecheck; lint.

#### 3. `tawny tab list|focus|close`
- **Blocked by:** 2
- **Delivers:** List tabs of a workspace (id, kind, title, workspace, focused), focus one, close one, by session id.
- **Where:** renderer store, bridge handlers from ticket 2, new `tab` register in main.
- **Steps:** Register `tab.list|focus|close` with `--workspace`. `focus` raises the tab and its workspace; `close` closes it (error for unknown id). Reuse the app's existing close/focus actions rather than touching state directly.
- **Done when:**
  - [ ] All three commands work from a terminal pane; ids match `TAWNY_CHAT_ID`
  - [ ] Unknown ids error cleanly
- **Verify:** dev instance, open a few tabs, drive them by CLI, screenshot via CDP; typecheck; lint.

#### 4. `tawny file open|diff|open-changed`
- **Blocked by:** 2
- **Delivers:** Open a file tab, a diff tab, or all changed files of the workspace, without stealing focus unless `--focus`.
- **Where:** renderer open-file/diff actions (find in `store.ts` / `components`), bridge from ticket 2.
- **Steps:** `file.open <path> [--line N] [--focus]`; `file.diff <path>` (working tree vs HEAD, reuse the existing diff tab); `file.open_changed [--focus]`. Resolve relative paths against the workspace; reject paths outside it. Return the tab id(s).
- **Done when:**
  - [ ] Each command opens the right tab; focus unchanged without `--focus`
  - [ ] Outside-workspace and missing paths error
- **Verify:** dev instance with CDP screenshots; typecheck; lint.

#### 5. `tawny notify`
- **Blocked by:** 2
- **Delivers:** `tawny notify [--tab <id>]` marks a tab (default: caller's chat) with the attention state; cleared when the tab is focused.
- **Where:** `unread` set and focus handling in `src/renderer/src/store.ts`; existing tab unread indicator.
- **Steps:** Add `notify.send` bridge handler that adds the id to `unread` (no-op if already focused). Reuse the existing unread indicator; confirm it meets WCAG AA in mocha and latte (compute ratios from `src/renderer/src/lib/theme.ts`) and isn't colour-only.
- **Done when:**
  - [ ] Unfocused tab shows the attention state; focusing clears it
  - [ ] Contrast checked in both themes
- **Verify:** dev instance, CDP screenshots in both themes; typecheck; lint.

#### 6. `tawny chat new|list`
- **Blocked by:** 2
- **Delivers:** Spawn a chat (default agent; `--agent`, `--prompt`, `--workspace`, `--focus`) returning `{ chatId, name, worktree }`, and list chats with id, name, agent, worktree, state.
- **Where:** `agents.create(dir, { kind: 'chat' })` in `main.ts`/agents module; `src/main/acp.ts` agent resolution (~123, unknown agent errors); state from hooks (`src/main/hooks.ts`); orchestrator-plan.md Phase 2 spec.
- **Steps:** Register `chat.new` and `chat.list`. `--prompt` is sent as the first turn (also accepts stdin). Don't steal focus unless `--focus`. Use the ACP fixture agent for tests.
- **Done when:**
  - [ ] New chat appears in the workspace without focus change
  - [ ] `--agent` unknown errors with the valid names; `--prompt` delivered
  - [ ] `chat list` shows state
- **Verify:** dev instance with a fixture agent (never a real one); typecheck; lint.

#### 7. `tawny chat send|read|wait`
- **Blocked by:** 6
- **Delivers:** Message a chat, read its recent output as text, block until it finishes its turn.
- **Where:** same as ticket 6; chat transcript source in agents/acp modules.
- **Steps:** `chat.send <id> [--text|stdin]` (error if mid-turn unless `--queue` is supported; check how the UI handles it and mirror); `chat.read <id> [--last N]` returns the last N messages (text only, summaries over transcripts); `chat.wait <id> [--timeout S]` resolves on idle, exits non-zero on timeout. Only chats in known workspaces are addressable.
- **Done when:**
  - [ ] Send, read and wait work end-to-end with a fixture agent
  - [ ] Timeout and unknown-id paths error cleanly
- **Verify:** dev instance with fixture; typecheck; lint.

#### 8. Skill, `tawny skills get`, docs, system-prompt line
- **Blocked by:** 3, 4, 5, 7
- **Delivers:** Agents discover the CLI: `tawny skills get tawny` prints a guide for the installed version; stub skill at `~/.claude/skills/tawny/SKILL.md` gated on `TAWNY=1`; a short appended system prompt for Tawny-launched Claude chats.
- **Where:** `src/main/cli/` (new `skills.ts`), `src/shared/pr-instructions.ts` as the pattern for shipped text, ACP `session/new` systemPrompt append (`acp.ts`), orchestrator-plan.md skill guide bullets.
- **Steps:** Generate the guide from the registry schema plus the workflow rules from orchestrator-plan.md (only drive chats you opened, don't message a mid-turn chat, use `chat wait` instead of polling, parallel tasks get their own worktree). Install the stub from Settings or on request (consent; never silently write outside Tawny's dirs; do not touch `~/Library/Application Support/Tawny`). Final pass over tawny-cli.md: drop "planned" status.
- **Done when:**
  - [ ] `tawny skills get tawny` output matches registered commands
  - [ ] System prompt line present in a fixture-agent chat
  - [ ] tawny-cli.md has no stale "planned" notes; orchestrator-plan.md Phase 2 points here
- **Verify:** dev instance; typecheck; lint.

### Status

| # | Ticket | Status |
|---|--------|--------|
| 1 | Close Phase 1 unverified items | todo |
| 2 | Renderer bridge + workspace commands | todo |
| 3 | tab list/focus/close | todo |
| 4 | file open/diff/open-changed | todo |
| 5 | notify | todo |
| 6 | chat new/list | todo |
| 7 | chat send/read/wait | todo |
| 8 | Skill, docs, system prompt | todo |

Parallel from the start: 1 and 2. After 2: 3, 4, 5, 6 in parallel. Then 7 (after 6), then 8.

## Open questions

None.
