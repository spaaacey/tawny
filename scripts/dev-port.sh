#!/usr/bin/env bash
# Print the CDP port of this worktree's running dev instance (exit 1 if none).
root="$(cd "$(dirname "$0")/.." && pwd)"
port=$(ps -axo command= | grep -F "$root " | grep -o 'remote-debugging-port=[0-9]*' | head -1 | cut -d= -f2)
[ -n "$port" ] && echo "$port" || { echo "no dev instance running for $root" >&2; exit 1; }
