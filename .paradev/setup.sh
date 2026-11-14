#!/usr/bin/env bash
# Paradev workspace setup: share deps with the root checkout and copy gitignored files it needs.
set -euo pipefail
root="${SUPERSET_ROOT_PATH:?SUPERSET_ROOT_PATH not set}"

# Dependencies: symlink the root checkout's node_modules (repo convention, see AGENT.md); install only if the root has none.
if [ ! -e node_modules ]; then
  if [ -d "$root/node_modules" ]; then
    ln -s "$root/node_modules" node_modules
  else
    npm ci
  fi
fi

# Gitignored files: vendor/ (js-debug adapter etc) and any .env files.
if [ -d "$root/vendor" ] && [ ! -e vendor ]; then cp -R "$root/vendor" vendor; fi
for f in "$root"/.env "$root"/.env.*; do
  [ -f "$f" ] && [ ! -e "$(basename "$f")" ] && cp "$f" .
done
exit 0
