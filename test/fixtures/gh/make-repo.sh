#!/usr/bin/env bash
# Scratch repo matching pr-basic.json: `main` (base) and `pr-fixture-7` (PR head, 3 changed files, src/cache.ts has
# a thread on line 42, src/store.ts one outdated thread). Prints the repo path.
set -euo pipefail
d=$(mktemp -d)/widgets
git init -q -b main "$d"
cd "$d"
git remote add origin git@github.com:acme/widgets.git
mkdir src
seq 1 30 | sed 's/^/export const store_/; s/$/ = 1;/' > src/store.ts
printf '# Widgets\n' > README.md
git add -A && git -c user.name=t -c user.email=t@t commit -q -m init
git checkout -q -b pr-fixture-7
{ echo "// LRU cache for widgets"; for i in $(seq 1 60); do echo "export const cache_$i = $i;"; done; } > src/cache.ts
sed -i.bak 's/store_5 = 1/store_5 = 5/; s/store_20 = 1/store_20 = 20/' src/store.ts && rm src/store.ts.bak
printf '# Widgets\n\nCaching: see src/cache.ts. Eviction is LRU.\n' > README.md
git add -A && git -c user.name=t -c user.email=t@t commit -q -m "Add widget cache"
git checkout -q main
echo "$d"
