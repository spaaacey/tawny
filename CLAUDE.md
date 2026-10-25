# Dev instance

- Each worktree runs its own dev instance; other worktrees may be running theirs in parallel. Never kill or reuse another worktree's instance (check its `url` in `curl localhost:<port>/json`).
- If this worktree's isn't running, start it in the background: `npm run dev` (no `--port`: it picks the first free port from 9333 and prints `cdp=http://localhost:<port>`; read the port from that log line).
- Attach via CDP at that port to screenshot, click and read console logs.
- Main-process changes need a restart of the dev instance. Renderer changes need ⌘R.
- Don't touch `~/Library/Application Support/Harbor` or tmux sessions named `harbor_*`.

# Verification

- Always verify changes against the dev instance (restart it for main-process changes) before reporting done: screenshot/inspect via CDP.
