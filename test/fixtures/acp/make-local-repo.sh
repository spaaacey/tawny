#!/usr/bin/env bash
# Scratch repo matching local-code-review.jsonl / local-review-resolve.jsonl: `main` plus the checked-out feature branch
# `local-review-fixture` (2 commits, then one uncommitted edit and one untracked file). The findings' lines:
#   src/session.ts:9      (new file, committed)      expiry compared in seconds against Date.now() ms
#   src/api/client.ts:12  (modified, committed)      retry loop runs one attempt too many
#   src/config.ts:4       (modified, uncommitted)    timeout default 0 disables the request timeout
# Prints the repo path.
set -euo pipefail
d=$(mktemp -d)/gadgets
git init -q -b main "$d"
cd "$d"
c() { git add -A && git -c user.name=t -c user.email=t@t commit -q -m "$1"; }
mkdir -p src/api
printf '# Gadgets\n' > README.md
cat > src/config.ts <<'EOF'
export const config = {
  baseUrl: 'https://api.example.com',
  retries: 3,
  timeoutMs: 10_000,
};
EOF
cat > src/api/client.ts <<'EOF'
import { config } from '../config';

export async function get(path: string): Promise<Response> {
  return fetch(config.baseUrl + path, { signal: AbortSignal.timeout(config.timeoutMs) });
}
EOF
c init
git checkout -q -b local-review-fixture
cat > src/session.ts <<'EOF'
export interface Session {
  token: string;
  /** Unix time in seconds. */
  expiresAt: number;
}

/** True while the session can still be used. */
export function isValid(s: Session): boolean {
  return s.expiresAt > Date.now();
}

export function bearer(s: Session): string {
  return `Bearer ${s.token}`;
}
EOF
c "Add session helpers"
cat > src/api/client.ts <<'EOF'
import { config } from '../config';
import { bearer, type Session } from '../session';

async function once(path: string, s: Session): Promise<Response> {
  return fetch(config.baseUrl + path, {
    headers: { Authorization: bearer(s) },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
}

export async function get(path: string, s: Session): Promise<Response> {
  for (let i = 0; i <= config.retries; i++) {
    const res = await once(path, s);
    if (res.status < 500) return res;
  }
  throw new Error(`GET ${path} failed after ${config.retries} retries`);
}
EOF
c "Retry GETs with the session token"
# uncommitted + untracked working-tree changes (a local review includes them)
sed -i.bak 's/timeoutMs: 10_000/timeoutMs: 0/' src/config.ts && rm src/config.ts.bak
printf 'Session tokens expire; see src/session.ts.\n' > NOTES.md
echo "$d"
