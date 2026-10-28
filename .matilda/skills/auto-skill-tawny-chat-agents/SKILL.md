---
name: tawny-chat-agents
description: When adding a new CLI agent to tawny's chat tabs, checking whether an agent CLI will work with them, or verifying chat-tab changes against the dev instance
source: auto-skill
extracted_at: '2026-10-27T12:04:45.392Z'
---

# Wiring a CLI agent into tawny chat tabs

Chat tabs speak ACP (Agent Client Protocol) over stdio to one adapter process per tab. All ACP code lives in `src/main/acp.ts`; terminal handling in `src/main/acp-terminals.ts`.

## Two ways to add an agent

1. **Config-only (no code change)**: add an entry under `acpAgents` in `settings` in `tawny.json` (openable in-app with Cmd-comma or `File > Open Settings`). Shape: `{ name: { command, args, env, label } }`. Example that works:

```json
{
  "settings": {
    "acpAgents": {
      "matilda": { "command": "matilda", "args": ["--acp"], "label": "Matilda" }
    }
  }
}
```

2. **First-class built-in** — all four of these must change together (done 2026-10 for `matilda`; use that diff as the template):
   - `agentList` in `src/main/acp.ts`: seed the entry `{ name, label, builtin: false, command, args }` next to `claude`. Only the name `claude` is protected, so users can override a built-in (e.g. `matilda`) via `acpAgents.<name>` — don't add it to the skip list.
   - `chatKinds()` in `src/renderer/src/legacy/layout.ts`: the launcher's chat rows are built renderer-side from a hardcoded name list plus `acpAgents`; add the name to the `builtin()` check and the labels. `main` falls back to `'claude'` when `chatAgent` isn't recognised.
   - `ChatView.tsx` `no-agent` banner: for a built-in, "Check acpAgents in tawny.json" is wrong advice — branch on `ctl.agent.name` and print the install command instead (see `INSTALL`/`INSTALL_MATILDA` constants).
   - `DEFAULT_SETTINGS` comment in `src/main/store.ts` ("...are built in") and the `agentList` doc comment.

Either way the agent CLI must itself implement ACP over stdio — check its docs for the flag that starts the ACP server (e.g. `matilda --acp`, confirmed via the bundled `mainy` skill's Zed-integration doc). The command must resolve on the login-shell PATH (`findOnPath` in `acp.ts`); a missing binary surfaces in the UI as the `no-agent`/`no-claude` banner state.

## Behaviour differences to remember

- Non-Claude agents are advertised `clientCapabilities.terminal: true` (Claude gets `false`); tawny runs their `terminal/*` requests in node-pty ptys and shows output on the tool card. `fs.readTextFile/writeTextFile` and `requestPermission` are handled for all agents.
- Persisted `chatSessions` store the `agent` name; `restoreChats` calls `resolveAgent` and **deletes the persisted chat if its agent name no longer resolves** — a built-in entry survives this, an `acpAgents`-only agent doesn't if the user removes the config.
- The launcher gets one `<label> Chat` row per agent automatically; `chatAgent` in settings picks which one the default row starts.
- Auth: the banner lists the agent's ACP auth methods — agent methods call `authenticate`, terminal methods open a real terminal tab running the agent's login command. Easiest path is to sign in with the agent's CLI once first so credentials already exist.
- Claude-only features by design: "continue in terminal" (`claude --resume`), transcript-file deletion on tab close, and hook-file rewriting of the `claude` command (`src/main/hooks.ts`).

## Verifying the change (tawny dev loop, from CLAUDE.md)

- Required before reporting done: `npm run typecheck` and `npm run lint` (Biome).
- Per-worktree dev instance: `npm run dev` — it picks the first free port from 9333 and prints `cdp=http://localhost:<port>`. Main/preload edits rebuild and auto-restart the app; renderer edits hot-reload. `scripts/dev-port.sh` prints this worktree's port (exit 1 if down). Other worktrees run instances in parallel on other ports — never kill them (confirm ownership via `url` in `curl localhost:<port>/json`).
- Fresh-worktree gotcha: if `npm run dev` fails with `Error: Electron uninstall`, the Electron binary was never fetched — run `node node_modules/electron/install.js` once and restart.
- **Never call a real AI agent from a dev instance.** Start with `TAWNY_ACP_FIXTURE=test/fixtures/acp/claude-basic.jsonl npm run dev`; every chat agent then replays the recorded session instead of spawning. `test/acp-mock-agent.js` is a mock ACP agent exercising `terminal/*` and terminal auth.
- Drive it over CDP: `GET /json` → `webSocketDebuggerUrl`, Node ≥22 speaks WS natively. Click launcher rows via `document.querySelectorAll('.lopt')` + `dispatchEvent(MouseEvent)`, read screens via `document.body.innerText`, screenshot via `Page.captureScreenshot`. To confirm persistence, read `<worktree-temp-data-dir>/tawny.json` (`chatSessions` → each chat's `agent` field); the dev data dir is printed at startup (`data=/var/folders/.../tawny-dev-...`).
- Per-tab ACP traffic is logged to `<dataDir>/logs/acp-<id>.log` (path built in `Chat.connect`).
- If you started a dev instance only for verification, kill it afterwards so port 9333 is free again.
