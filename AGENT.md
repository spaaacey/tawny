# Dev instance

- Each worktree runs its own dev instance; other worktrees may be running theirs in parallel. Never kill or reuse another worktree's instance (check its `url` in `curl localhost:<port>/json`).
- If this worktree's isn't running, start it in the background: `npm run dev` (no `--port`: it picks the first free port from 9333 and prints `cdp=http://localhost:<port>`; read the port from that log line).
- `scripts/dev-port.sh` prints this worktree's running CDP port (exit 1 if not running).
- Attach via CDP at that port to screenshot, click and read console logs.
- Dev runs through electron-vite: React/TS renderer edits hot-reload (HMR), static assets in `src/renderer/public` (only `fileicons` remains) full-reload the page, main/preload edits rebuild and restart the app automatically.adfasdf
- `npm run typecheck` and `npm run lint` (Biome) before reporting done.
- Whenever you start or attach to a dev instance, say so in the chat (include the CDP port).
- Don't touch `~/Library/Application Support/Tawny` (or legacy `Harbor`) or tmux sessions named `tawny_*` (or legacy `harbor_*`).

# Verification

- Always verify changes against the dev instance (restart it for main-process changes) before reporting done: screenshot/inspect via CDP.
- No exceptions for small changes: if the dev instance isn't running, start it. Never skip verification because the change is trivial.
- When testing AI chat in a dev instance, use a fixture file. Never call an actual AI agent.

# Shipping

- When finished, verified manually in the dev instance yourself, and VERY confident in the changes: commit and merge to main yourself, no human needed.
- Always report the short SHA (in backticks, e.g. `1df6218`) of every commit/merge you make in the final message.
