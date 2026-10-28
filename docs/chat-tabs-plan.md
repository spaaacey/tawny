# Plan: chat tabs over ACP

Status: phases 0-6 done; phase 0 findings below. Researched 2026-10-25.

A **chat tab** is a new kind of agent tab: a chat UI like the Claude Code desktop app, instead of the TUI in xterm. Tawny is the client and talks to the agent over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP, from Zed): JSON-RPC over stdio, with the agent as a subprocess. Claude Code joins through the official adapter, which wraps the Claude Agent SDK. Any other ACP agent can use the same tab later.

Not to be confused with agentcommunicationprotocol.dev (IBM/BeeAI's agent-to-agent REST protocol, now merged into A2A).

## Decisions

| | Choice | Why |
|---|---|---|
| Protocol version | ACP **v1** (the SDK's default entrypoint) | v2 is a draft; the SDK calls its v2 entrypoints experimental and allows incompatible changes in any release. The adapter serves both. |
| Client library | `@agentclientprotocol/sdk` (2.0.2) | Official. Fluent `client()`, `onRequest`, `onNotification`, `connect(ndJsonStream(...))`. `ClientSideConnection` is deprecated. |
| Claude agent | `@agentclientprotocol/claude-agent-acp` (0.95.0), **pinned to an exact version** | Official adapter (the old `@zed-industries/claude-code-acp` is deprecated). It ships often, so pin the version and upgrade on purpose. |
| `claude` binary | `CLAUDE_CODE_EXECUTABLE` = the user's `claude` from the login-shell PATH (`shellenv.js`). **Not bundled**: if none is found, the chat tab shows "Install Claude Code" | Same version, login and settings as the terminal agents, which already need `claude` on PATH. Bundling the SDK's native binary would add 275 MB per arch. |
| Process model | One adapter process per chat tab | Crash isolation. The resource manager gets a root pid per tab for free. Killing the tab kills the process. |
| Session model | A chat is an `Agents` session with `kind: 'chat'`, tab key `a:<id>`, without a pty | Sidebar state, notifications, dock badge, send-selection and `currentAgent()` work unchanged. The renderer mounts a chat view instead of xterm when `kind === 'chat'`. |
| Working state | From ACP itself, not from hooks or heuristics | Open `session/prompt` = working. Pending `session/request_permission` = waiting. Prompt resolved = idle, plus the existing "finished" notification. |
| Renderer code | `src/renderer/chat.js`, plain script like the rest | Markdown rendering is bundled with esbuild into `vendor/chat.js` (marked + DOMPurify + lowlight, which is already a dependency), the same way `build-rich.js` builds `vendor/rich.js`. CSP stays `'self'`. |
| Main code | `src/main/acp.ts` (CJS), loading the ESM SDK with `await import()` | Main is CommonJS. The SDK and adapter are ESM only. |

## What the Claude adapter gives us (from its v0.95.0 source)

- `initialize` returns `loadSession: true` and session capabilities `list`, `resume`, `close`, `delete`, `fork`, `additionalDirectories`. Prompt capabilities: `image`, `embeddedContext`. MCP over `http` and `sse`.
- `session/update` variants (v1 schema):
  - Message chunks: `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk` (replay)
  - Tool calls: `tool_call`, `tool_call_update`
  - Session state: `plan`, `available_commands_update`, `current_mode_update`, `config_option_update` (model, mode, effort), `session_info_update` (title), `usage_update` (context used/size, cost)
  - Other: `notice`, `compaction_update`, `compaction_summary_chunk`
- Tool calls have `kind` (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`) and `status` (`pending`, `in_progress`, `completed`, `failed`). They also have `locations`, `rawInput`, `rawOutput`, and `content`: text, `diff {path, oldText, newText}`, or `terminal {terminalId}`.
- Permission options: `allow_once`, `allow_always`, `reject_once`, `reject_always`. The outcome is `selected {optionId}` or `cancelled`.
- Stop reasons: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- **Claude Code runs its own tools.** Bash, Read and Edit run inside the CLI and don't go through the client's `fs/*` or `terminal/*` (confirmed: zero `fs/*` calls). Command output arrives as display-terminal data in the tool call's `_meta` (`terminal_info`, `terminal_output`, `terminal_exit`), but **only if the client declares `clientCapabilities._meta.terminal_output: true`**. Edits land on disk, where the existing file watcher reloads buffers.
- **Auth.** `authMethods` is **empty unless the client declares `clientCapabilities.auth.terminal: true`** (or `_meta['terminal-auth']: true`). Then it lists two `type: 'terminal'` methods whose `args` are appended to the adapter's own command line: `--cli auth login --claudeai` and `--cli auth login --console` (`--cli` makes the adapter exec the claude binary). Tawny runs `<adapter command> <args>` in an ordinary terminal tab.
- Extras under `_meta`: steering (`_session/steering`, to inject a message into a running turn), and subagents as child sessions when the client declares `clientCapabilities.subagents`.

## Architecture

```
renderer                       main                              child process
chat.js  ──IPC chat:*──▶  acp.js (ACP client)  ──stdio NDJSON──▶  claude-agent-acp  ──▶  claude CLI
  ▲  transcript, cards,        Agents session kind:'chat'          (ELECTRON_RUN_AS_NODE)
  │  composer, prompts         state: working/waiting/idle
  └──────chat:update ◀──────── session/update, request_permission
```

### Main: `src/main/acp.ts`

- **Spawn.** Run `process.execPath` with `ELECTRON_RUN_AS_NODE=1` on the adapter's `dist/index.js`, cwd = the workspace. Env: `CLAUDE_CODE_EXECUTABLE`, `CLAUDE_CODE_AUTO_CONNECT_IDE=false`, and `CLAUDE_AGENT_ACP_PROTOCOL=v1`. **Start it as `-e "delete process.env.ELECTRON_RUN_AS_NODE; import(require('url').pathToFileURL(process.argv[1]).href)" <adapter>`**, not directly: otherwise `ELECTRON_RUN_AS_NODE=1` leaks into the agent's Bash tool and breaks anything that runs `electron`. Wrap the pipes with `Writable.toWeb` / `Readable.toWeb` → `ndJsonStream` → `client({ name: 'tawny' }).connect(stream)`. Write stderr to `<data dir>/logs/acp-<id>.log`.
- **`initialize`.** Send `clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, auth: { terminal: true }, _meta: { terminal_output: true } }` and `clientInfo`. Keep the agent's capabilities, auth methods and `_meta` on the session.
- **`session/new`** with `cwd` = the workspace path and `mcpServers: []`. Store `{ id → { sessionId, agent, cwd } }` in `store.data.chatSessions`.
- **Handlers:**
  - `session/update`: update the session (state, title, usage) and forward to the renderer as `chat:update`.
  - `session/request_permission`: forward as `chat:permission` and keep a pending promise per request. The renderer answers with `chat:answer`. A cancel, or the tab closing, resolves it as `cancelled`.
  - `fs/read_text_file`: ask the renderer for a dirty buffer of the path, else read from disk. This matters for other agents; Claude mostly reads files itself.
  - `fs/write_text_file`: write through `files.js`. The editor already reloads on `fs:changed`.
- **Agents integration.**
  - `register()` a session with `kind: 'chat'`, no pty, and an `acp` handle.
  - Guard the code paths that assume a pty: `write`, `resize`, `buffer`, `tick`, `pollProcs`, `onExit`, and the pid lookup in `resources.js` (which takes the adapter's pid).
  - `kill()` sends `session/close` and kills the process. Closing a tab also sends `session/delete`, matching how closing an agent tab deletes its transcript today.
- **Crash and reconnect.** When the process exits unexpectedly, the tab shows "Disconnected · Reconnect". Reconnect respawns the adapter and calls `session/resume` (no replay; the transcript is still in the renderer).

### IPC (preload)

`createAgent(p, 'chat')` reuses the existing call. New calls:

- `chatPrompt(id, blocks)`
- `chatCancel(id)`
- `chatAnswer(id, reqId, outcome)`
- `chatSetConfig(id, configId, value)`
- `chatSetMode(id, modeId)`
- `chatHistory(id)` (the transcript so far, for remounts)

Events: `onChatUpdate`, `onChatPermission`, `onChatStatus` (connected, disconnected, auth required).

Main keeps a per-session transcript model, built by folding updates: messages, tool calls by id, plan, usage. A remount, a second window or a page move then renders from `chatHistory` without the agent replaying anything.

### Renderer: `src/renderer/chat.js`

- **Transcript:**
  - User messages; agent messages as streaming markdown (re-rendered per chunk, throttled to one frame).
  - Thinking collapsed into a "Thinking" disclosure.
  - Compaction as a divider; notices as banners.
- **Tool cards**, one per `toolCallId`, updated in place:
  - Header: kind icon, title, status (spinner, ✓ or ✗). Body collapsed by default except for failures and pending permissions.
  - `locations` are clickable and open the file at that line (`tawnyLayout.openFile`).
  - A `diff` renders inline with Monaco's colorizer, plus an "Open diff" button that opens a diff tab.
  - Terminal output renders in a monospace block with ANSI colors (or a small read-only xterm).
- **Permission card.** Inline on the tool card, with one button per option and `1`…`4` keys. The tab shows the existing waiting dot. Answering focuses the composer again.
- **Composer:**
  - Enter sends, `shift+enter` adds a newline. While a turn runs, the send button turns into Stop (`session/cancel`). A message sent while running is queued (later: sent through steering).
  - `@` opens a file picker over `tawnyEditor.fileMatches`. The pick becomes a `resource_link` block.
  - Pasting or dropping an image adds an `image` block.
  - `/` lists `available_commands_update` commands.
  - Footer: mode picker (config option category `mode`), model and effort pickers (`config_option_update`), a context meter (`usage_update` used/size, cost) and the session title.
- **Plan panel.** The latest `plan` entries as a checklist pinned above the composer.
- **Send selection** (`cmd+option+l`). For a chat target, `askAgent` puts the reference into the composer as a `resource_link`. With a message, it sends at once.
- **Theme.** Catppuccin tokens from `themes.js`, light and dark.

### Launcher and settings

- The launcher list in `layout.js` (now Terminal, Claude Code, …) gets **Claude Chat**, plus one row per agent configured in `acpAgents`.
- New settings in `tawny.json`:

  | key | default | |
  |---|---|---|
  | `chatAgent` | `claude` | which `acpAgents` entry the Claude Chat row starts |
  | `acpAgents` | `{ "claude": <bundled adapter> }` | `{ name: { command, args, env } }` for other ACP agents |

## Phases

Each phase ends verified in this worktree's dev instance over CDP (screenshots, console, clicks), per CLAUDE.md.

0. **Spike.** Write `scripts/acp-spike.js`: spawn the adapter, `initialize`, `session/new`, send one prompt that reads a file, edits it and runs a command, then log every message to `test/fixtures/acp/*.jsonl`. Confirm:
   - Electron-as-node runs the ESM adapter, both in dev and from the dmg's `app.asar.unpacked`.
   - Whether the ACP `sessionId` equals the Claude Code session id. If it does, `claude --resume <id>` opens the same chat in a terminal tab.
   - The exact `_meta` shape of display terminals, and the auth-required error.
   - Cold-start time to the first `session/new`.

### Findings (phase 0)

Script: `scripts/acp-spike.js` (flags in its header). Fixtures in `test/fixtures/acp/` (`{t, dir: out|in|meta, msg}` per line; emails scrubbed, `available_commands_update` trimmed to 5): `claude-basic.jsonl` (user's default mode, `auto`), `claude-basic-default.jsonl` (mode switched to `default`, has a permission request), `claude-load.jsonl` (respawn + `session/load` of the `-default` session), `claude-init-plain.jsonl` (initialize without the extra capabilities). Ran with Electron 45 as node (Node 24.22), plain Node 26, a packaged `--dir` build, and the SDK's bundled claude (2.1.309) as well as the user's (2.1.310). All end-to-end OK.

- **Electron-as-node: works.** Dev and packaged (`Tawny.app/.../app.asar.unpacked/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`, run with the app's own binary as node). Needs the `asarUnpack` list in Packaging (7 package dirs; the dependency closure is `claude-agent-acp` + nested `sdk`, `sdk`, `claude-agent-sdk`, `claude-agent-sdk-darwin-arm64`, `zod`, `diff`). Gotcha: with plain `ELECTRON_RUN_AS_NODE=1` the agent's Bash sees `ELECTRON_RUN_AS_NODE=1` (checked with `--env-check`); the `-e delete ...` launcher fixes it (`--unset-electron-env`). The dmg itself was not built (a `--dir` build of the same config was).
- **`sessionId` = Claude Code session id: yes.** `~/.claude/projects/<cwd, non-alphanumerics -> '-'>/<sessionId>.jsonl` exists with that exact id; `session/load` logs `resume=<same id>`. So `claude --resume <id>` (from the same cwd) can open the chat in a terminal tab. The cwd is realpath'd (`/private/var/...`), so use the real path. Transcripts and `~/.claude/session-env/<id>` from the spike were deleted afterwards.
- **Tool-call shape** (`claude-basic-default.jsonl`): a `tool_call` arrives first with a generic `title` (`Read File`, `Edit`, `Terminal`), `kind`, `status: pending`, empty `rawInput`/`content`/`locations`; then partial `tool_call_update`s fill fields in (absent field = unchanged), ending with `status: completed` and `rawOutput`. `_meta.claudeCode.toolName` carries the tool (`Read`/`Edit`/`Bash`).
  - read: `kind: read`, title `Read notes.txt`, `locations [{path, line: 1}]`, `rawInput {file_path}`, content a fenced text block with line numbers.
  - edit: `kind: edit`, title `Edit notes.txt`, `rawInput {file_path, old_string, new_string, replace_all}`, `content [{type: diff, path, oldText, newText}]` (a snippet of `old_string`/`new_string` at first, whole-line `hello world` -> `hello acp` after the result), `locations [{path, line}]`. `_meta.claudeCode.toolResponse` has `originalFile` and `structuredPatch`.
  - execute: `kind: execute`, title `Terminal`, then the command (`ls -la`); `rawInput {command, description}`.
  - **Display terminal `_meta` (real keys, only with `_meta.terminal_output: true`)**: on the `tool_call` `_meta.terminal_info {terminal_id}` + `content [{type: terminal, terminalId}]`; later an update with `_meta.terminal_output {terminal_id, data}` (one chunk, full output); then `_meta.terminal_exit {terminal_id, exit_code, signal}` with `status: completed`. `terminal_id` = `toolCallId`. Without the capability, output comes only as a fenced ```` ```console ```` text block in `content`, plus `rawOutput` and `_meta.claudeCode.toolResponse {stdout, stderr, interrupted}`.
- **fs methods called: none.** Read, Edit and Bash all ran in the CLI with `fs.readTextFile/writeTextFile: true` advertised. `fs/*` handlers are only for other agents.
- **`initialize` result**: `protocolVersion 1`; `agentInfo {name: @agentclientprotocol/claude-agent-acp, version 0.95.0}`; `agentCapabilities`: `loadSession`, `promptCapabilities {image, embeddedContext}`, `mcpCapabilities {http, sse}`, `auth {logout}`, `providers {}`, `sessionCapabilities {additionalDirectories, close, delete, fork, list, resume, systemPrompt}`, `_meta {claudeCode {promptQueueing: true}, authStatus {}}`; top-level `_meta {steering {supported: true}}`; `authMethods: []` without `auth.terminal`, else `claude-ai-login` and `console-login` (see Auth). **Auth missing** (from source, not tested live): `session/new` still succeeds; the turn fails (`session/prompt` rejects with JSON-RPC `-32000` `Authentication required`, no `data`) when the CLI answers "Please run /login"; the adapter also pushes a custom `_auth/status_update` notification (`authStatus {kind: none, label: "Not logged in"}`; when logged in `{kind: account, label, account {plan, email, organization}}`). The renderer must not log it raw (contains the email).
- **`session/update` variants seen**: `available_commands_update` (twice at start, once after `session/load`'s response; `{name, description, input}`, ~25 KB with the user's skills), `session_info_update {title, updatedAt}` (about 1 s into the first turn), `usage_update {used, size, cost?, _meta {_claude/model, _claude/rateLimit}}` (cost only on the last), `tool_call`, `tool_call_update`, `agent_message_chunk` (+ `messageId`), `current_mode_update` (after `session/set_config_option` for mode). On replay: `user_message_chunk`. Not seen (this prompt): `agent_thought_chunk`, `plan`, `config_option_update`, `notice`, compaction. `session/new` returns `modes` (legacy) and `configOptions`: `mode` (category `mode`: `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`), `model` (category `model`: `default`, `opus`, `sonnet`, `fable`, `haiku`, plus pinned ids), `effort` (category `thought_level`: `default`, `low`, `medium`, `high`, `xhigh`, `max`), `fast` (category `model_config`: `on`/`off`). New sessions start in the user's configured default mode (`auto` here). `session/set_config_option {sessionId, configId, value}` returns the full `configOptions`. The prompt response has `stopReason` and `usage {inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens}`.
- **Permissions**: in `auto` mode none were asked. In `default` mode the Edit asked (`session/request_permission`, params `{sessionId, toolCall {toolCallId, title, kind, rawInput, content (diff), locations}, options}`); read-only `ls` and Read did not. Options: `allow-once` (`allow_once`, "Yes"), `allow-with-updates` (`allow_always`, "Yes, allow all edits during this session"), `reject` (`reject_once`). No `reject_always`. Answer `{outcome: {outcome: 'selected', optionId}}`.
- **`session/load`**: replays before the response: `user_message_chunk`, merged `tool_call` (complete `rawInput`, title, diff, `terminal_info`) + `tool_call_update completed` (incl. `terminal_output`/`terminal_exit`), `agent_message_chunk`. No thinking, usage, title or permission requests are replayed. The response has `modes`/`configOptions` with the current mode restored. `session/list {cwd}` -> `{sessions: [{sessionId, cwd, title, updatedAt}]}`.
- **Timings** (ms since spawn; dev, Electron-as-node, user's claude): `initialize` ~245 (plain Node ~320); `session/new` ~1000-1200 (770 of it is the CLI's `sdk-initialize`); first update (`available_commands_update`) lands right after the `session/new` response; turn to `stop` 7-11 s for 3 tools on Opus (one plain-Node run took 21 s: model latency); `session/load` ~1170 on Electron, ~1880 on plain Node. Packaged build: first launch `initialize` 6 s (cold unsigned app), then ~250. SDK's bundled claude: `session/new` 4.5 s (single, probably cold sample). One turn cost about $0.12 on Opus.
- **Corrections to this plan** (already applied above): (1) the client must declare `auth.terminal: true` or `authMethods` is empty; (2) the client must declare `_meta.terminal_output: true` to get display terminals; the key names are `terminal_info`/`terminal_output`/`terminal_exit`; (3) the terminal-auth args are appended to the adapter command (`--cli auth login ...`), not `claude /login`; (4) spawn through an `-e` launcher that deletes `ELECTRON_RUN_AS_NODE`; (5) `asarUnpack` needs the whole closure, not only adapter + SDK; (6) the permission options have no `reject_always`; (7) the first `tool_call` is a stub, so cards need merge-by-field updates and a title that changes; (8) replay has no thinking, usage or title, so `session/load` alone doesn't rebuild the footer: keep title/usage in the persisted transcript model.
- **For phase 1**: fixture replay should play `dir: in` lines with the recorded `t` gaps (skip `meta`), and answer `session/request_permission` from the UI; `claude-basic-default.jsonl` has the permission request. Unknown notifications (`_auth/status_update`) pass through the SDK without errors, but handle them explicitly. `session/delete`/`session/close`, `session/resume` and a live auth failure were not exercised.
1. **Plumbing.** Add `acp.js`, the `Agents` `kind: 'chat'` integration, IPC and preload, state mapping, kill and close. Add a **fixture replay** mode (`TAWNY_ACP_FIXTURE=<file>`) that feeds a recorded session to the UI, for deterministic UI work and screenshots without spending tokens.
2. **MVP chat tab.** Launcher row; streaming markdown; tool cards with title, status and kind; permission cards; composer with send and stop; working, waiting and idle in the sidebar; the finished notification.
3. **Editor integration.** Diffs inline and in Monaco diff tabs; clickable locations; `@` mentions; `cmd+option+l`; images; unsaved buffers through `fs/read_text_file`.
4. **Session lifecycle.**
   - Chats survive a Tawny restart: respawn the adapter and call `session/load`, whose replay rebuilds the transcript.
   - Reconnect after a crash.
   - Delete on close.
   - "Open in terminal" (`claude --resume`, if phase 0 confirms the session ids match).
   - A history picker over `session/list`.
   - A confirm on quit while a chat is working (no tmux, so the turn dies).

   Done. `store.data.chatSessions[id]` = `{sessionId, cwd, started, title, usage}` (replay carries no title or usage). Restore is eager at startup; `session/load` failing (transcript gone) falls back to `session/new` with a notice. Reconnect uses `session/resume`. Closing a tab also removes `~/.claude/projects/.../<sessionId>.jsonl` in case the agent couldn't. "Open in terminal" closes the chat (keeping the transcript) and starts `claude --resume <id>` as an agent tab. The history picker is the launcher row "Resume chat…" (`session/list` via a short-lived adapter, minus chats already open). Resuming from history then closing the tab deletes that conversation.
5. **Desktop parity.** Plan panel, slash commands, mode, model and effort pickers, usage meter, notices, compaction, thinking, session titles. Later: steering and subagent child sessions.

   Done (steering and subagents still later). Plan: collapsible checklist above the composer. `/` at the start of the composer lists `available_commands_update` commands (Tab/Enter completes; an exactly typed name sends). Footer selects for config options of category `mode`, `model`, `thought_level` (`session/set_config_option`). Usage meter bar with token tooltip. The client declares `session: {notices, compaction}` so the adapter sends `notice` (`{severity, title, description}`) and `compaction_update`/`compaction_summary_chunk` (one divider per `compactionId`, summary in a disclosure). Synthetic fixture with these updates: `test/fixtures/acp/synthetic-extras.jsonl` (hand-edited from `claude-basic.jsonl`; shapes from the adapter source, not recorded live).
6. **Other ACP agents.** The `acpAgents` setting and launcher rows. Client `terminal/*` (node-pty, output shown on the tool card, optionally as a real terminal tab). Auth flows for other agents.

   Done (real terminal tab for client terminals: not done). `acpAgents` = `{name: {command, args, env, label}}` in `settings`; `claude` is built in; `chatAgent` picks the first launcher row ("<label> Chat"), one more row per other agent. Chats persist their `agent` name. Non-Claude agents are spawned directly (`launchOf`), need the command on PATH (`no-agent` banner), and get `clientCapabilities.terminal: true`; Claude keeps `false`. `terminal/*` in `src/main/acp-terminals.ts` (node-pty, output cap, batched to the card as synthetic `x_terminal` updates folded into `model.terminals`). Auth: banner lists the agent's auth methods; terminal methods open a tab running the agent's command + method args (Retry afterwards), agent methods call `authenticate` and reconnect. Open in terminal, `claude --resume` and transcript deletion stay Claude-only. Test agent: `test/acp-mock-agent.js` (terminal/*, terminal auth).

## Packaging

- Add dependencies `@agentclientprotocol/sdk` and `@agentclientprotocol/claude-agent-acp`, both pinned.
- Add to `asarUnpack` (verified in a `--dir` build): `node_modules/@agentclientprotocol/**` (adapter, its nested SDK, our SDK), `node_modules/@anthropic-ai/claude-agent-sdk/**`, `node_modules/zod/**`, `node_modules/diff/**`. The adapter runs from `app.asar.unpacked` and resolves its imports there, so its whole dependency closure must be unpacked. `@anthropic-ai/sdk` (23 MB, a dependency of `claude-agent-sdk`) wasn't in the verified list: check in phase 1 whether it's needed unpacked.
- **Don't ship the native `claude`.** Exclude it with `"!node_modules/@anthropic-ai/claude-agent-sdk-*/**"` in `build.files` (it's the optional per-platform package, 275 MB per arch; `app.asar.unpacked` would grow from ~30 MB to 314 MB). Always set `CLAUDE_CODE_EXECUTABLE` to the user's `claude`, so the adapter never looks for the bundled one. The rest of the closure is ~56 MB: `@anthropic-ai/sdk` 23, `claude-agent-acp` 11, `zod` 8, `@agentclientprotocol/sdk` 8, `claude-agent-sdk` 5, `diff` 1. Bundling the adapter with esbuild could shrink that; untested.
- Missing `claude`: the chat tab shows "Install Claude Code" with the install command, instead of spawning the adapter.

## Risks and open questions

- **Version skew.** The adapter is tested against the `claude` its SDK bundles (2.1.309 for adapter 0.95.0); Tawny runs whatever the user has installed (2.1.310 worked in the spike). Keep the adapter pin close to current `claude` releases, and log both versions at spawn so a mismatch is easy to spot.
- **Auth terms.** Anthropic doesn't allow third-party products built on the Agent SDK to offer claude.ai subscription login. Personal use with your own `claude` login is the gray area. Distributing Tawny with chat tabs would need API-key or Bedrock/Vertex auth for the Claude agent.
- **Adapter churn.** It's 0.x, released almost daily, with lots of `_meta` extensions. Use only stable ACP v1 fields in the core UI and treat `_meta` features as optional.
- **v2 migration.** v2 changes prompt lifecycle (prompt returns on accept, an idle `state_update` ends the turn) and makes subagents baseline. Keep the ACP calls inside `acp.js` so a v2 switch stays local.
- **No tmux persistence.** A running turn dies when Tawny quits. Resume restores the conversation, not the in-flight work.
- **TUI-only features.** The interactive slash command menus (`/config`, `/model` pickers) don't exist over ACP except where the adapter maps them to commands or config options. Some will stay terminal-only.
- **Fidelity.** The desktop app gets features before the adapter maps them. A "Claude Code (terminal)" tab remains the fallback.
