# Dev instance

- Port 9333 is the dev instance. If it isn't running, start it: `npm run dev -- --port 9333` (in the background).
- Attach via CDP at http://localhost:9333 to screenshot, click and read console logs.
- Main-process changes need a restart of the dev instance. Renderer changes need ⌘R.
- Don't touch `~/Library/Application Support/Harbor` or tmux sessions named `harbor_*`.

# Verification

- Always verify changes against the dev instance (restart it for main-process changes) before reporting done: screenshot/inspect via CDP.
