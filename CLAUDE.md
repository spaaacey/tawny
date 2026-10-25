# Dev instance

- Each worktree runs its own dev instance; other worktrees may be running theirs in parallel. Never kill or reuse another worktree's instance (check its `url` in `curl localhost:<port>/json`).
- If this worktree's isn't running, start it in the background: `npm run dev` (no `--port`: it picks the first free port from 9333 and prints `cdp=http://localhost:<port>`; read the port from that log line).
- `scripts/dev-port.sh` prints this worktree's running CDP port (exit 1 if not running).
- Attach via CDP at that port to screenshot, click and read console logs.
- Main-process changes need a restart of the dev instance. Renderer changes need ⌘R.
- Whenever you start or attach to a dev instance, say so in the chat (include the CDP port).
- Don't touch `~/Library/Application Support/Harbor` or tmux sessions named `harbor_*`.

# Verification

- Always verify changes against the dev instance (restart it for main-process changes) before reporting done: screenshot/inspect via CDP.
- No exceptions for small changes: if the dev instance isn't running, start it. Never skip verification because the change is trivial.
