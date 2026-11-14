#!/usr/bin/env bash
# Paradev workspace teardown: stop this worktree's dev instance (`npm run dev`) and remove its temp data dir.
set -uo pipefail
ws="$(cd "${SUPERSET_WORKSPACE_PATH:-$PWD}" && pwd -P)"
data="${TMPDIR:-/tmp}"; data="${data%/}/tawny-dev-$(printf '%s' "$ws" | shasum | cut -c1-6)" # matches scripts/dev.ts

# electron-vite runs from this worktree's node_modules; its parent is `node scripts/dev.ts`.
for pid in $(pgrep -f -- "$ws/node_modules/.bin/electron-vite"); do
  kill -TERM "$(ps -o ppid= -p "$pid" | tr -d ' ')" "$pid" 2>/dev/null
done
sleep 1
# Electron (main + helpers) is identified by its per-worktree user-data dir.
pkill -f -- "--user-data-dir=$data" 2>/dev/null

rm -rf "$data"
exit 0
