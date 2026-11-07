# Dev instance

- Each worktree runs its own dev instance; other worktrees may be running theirs in parallel. Never kill or reuse another worktree's instance (check its `url` in `curl localhost:<port>/json`).
- If this worktree's isn't running, start it in the background: `npm run dev` (no `--port`: it picks the first free port from 9333 and prints `cdp=http://localhost:<port>`; read the port from that log line).
- `scripts/dev-port.sh` prints this worktree's running CDP port (exit 1 if not running).
- Attach via CDP at that port to screenshot, click and read console logs.
- Dev runs through electron-vite: React/TS renderer edits hot-reload (HMR), static assets in `src/renderer/public` (only `fileicons` remains) full-reload the page, main/preload edits rebuild and restart the app automatically.adfasdf
- `npm run typecheck` and `npm run lint` (Biome) before reporting done.
- Whenever you start or attach to a dev instance, say so in the chat (include the CDP port).
- Don't touch `~/Library/Application Support/Tawny` (or legacy `Harbor`).
- New worktree without `node_modules`: symlink it to the main checkout's (`ln -s /Users/chu/src/tawny/node_modules node_modules`). Never run `npm install`.

# Verification

- Always verify changes against the dev instance (restart it for main-process changes) before reporting done: screenshot/inspect via CDP.
- No exceptions for small changes: if the dev instance isn't running, start it. Never skip verification because the change is trivial.
- When done verifying, CLOSE the dev instance you started (only this worktree's; never another's). Don't leave it running.
- Exception: leave it running if a human must check the result (needs human judgement or taste, e.g. visual polish, feel, UX). Say so in the chat with the CDP port.
- When testing AI chat in a dev instance, use a fixture file. Never call an actual AI agent.

# Shipping

- When finished, verified manually in the dev instance yourself, and VERY confident in the changes: commit and merge to main yourself, no human needed.
- Committing is part of shipping: if you can't verify the change yourself (e.g. native window chrome that CDP screenshots can't capture), don't commit or merge. Leave it uncommitted and say what's unverified.
- Merge into main without a "Merge branch ... into main" commit: keep only the branch's own commit message(s). Rebase the branch onto main, then `git merge --ff-only` (or squash and commit with the branch's message).
- Always report the short SHA (in backticks, e.g. `1df6218`) of every commit you make/land on main in the final message.

# UI components

- Always reuse existing components from `@/ui` (`src/renderer/src/components/ui`, import per file e.g. `@/ui/item`) before hand-rolling markup/CSS.
- If no `@/ui` component fits and you must hand-roll, get the human's sign-off first.

# Accessibility

- Follow WCAG 2.2 AA in both themes (mocha and latte). Check both; the pastel base tokens (`--idle`, `--toggle`, `--faint`, ...) fail on latte if used raw.
- Text: 4.5:1 against its background (3:1 only for large text, 18px+ or 14px+ bold). Non-text UI (icons, borders, focus rings): 3:1 against adjacent colours.
- Colour is never the only signal: pair it with text, an icon shape or a label (e.g. a state pill shows the state word).
- For coloured pills/badges: use `--text` for the label on a tint of the state colour; tint icons by mixing the state colour toward `--text` (`color-mix`).
- Compute the ratios (WCAG relative-luminance formula) from the palettes in `src/renderer/src/lib/theme.ts` for both themes before reporting done; don't judge by eye.
- Every themed colour used in CSS must be defined per theme in `theme.ts` (a var missing there silently keeps the mocha fallback in latte).
