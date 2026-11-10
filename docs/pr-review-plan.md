# Plan: PR review sessions

Status: design locked 2026-11-06, spike done (findings below). All phases (1-6) done. Remaining TODOs: record a real /code-review ACP fixture (needs model calls, throwaway PR), pagination (100-item caps), dark theme check of the PR UI, packaged-app path of the `tawny-pr` MCP, LEFT-side composer / resolve button not driven through the UI, outdated-line remapping for drafts (findings: done, see below), real (non-fixture) `gh pr checkout` refresh path untested.

A **PR review session** is a new kind of workspace for reviewing a teammate's GitHub PR inside Tawny. You paste a PR URL or number, and Tawny opens a worktree on the PR head. The workspace shows:

- a native PR tab with the description, conversation and your pending review
- a Claude chat that already has the PR as context
- inline threads in the Monaco diff

The agent can run /code-review and propose comments. Nothing reaches GitHub until you accept it, and nothing goes public until you submit the review.

## Prior art (researched 2026-11-06)

- **Codex Code Review**
  - Has a PR inbox, plus Summary and Changes tabs.
  - "Review with Codex" runs in a private chat, and Submit sends Comment, Approve or Request changes.
  - Trap to avoid: comments typed directly in its views post immediately, without going through Submit.
- **Claude Code**
  - /code-review accepts an effort level, `--comment` and `--fix`.
  - The desktop app shows findings grouped by file, steps through them in the diff and fixes or dismisses each.
  - The managed GitHub App posts inline comments but never approves.
- **VS Code GitHub Pull Requests**: a local checkout in "review mode", with inline comments on the real files. You submit the review from the Description page.
- **Cursor Bugbot, CodeRabbit, Greptile**: a bot posts comments on GitHub, and the IDE consumes or fixes them.
- **Devin Review**: orders hunks logically and explains each one.
- **Conductor, Warp**: one worktree per workspace. Inline comments become agent prompts. Neither posts reviews back to GitHub.

Patterns we adopt:

- findings as a structured list, separate from chat
- keep things private first and publish explicitly
- a single submit with a verdict
- a worktree per session
- auth through the gh CLI

## Decisions

| | Choice | Why |
|---|---|---|
| Use case | Reviewing **teammates'** PRs | Reviewer flow. Fixes are suggestions; the agent never pushes. |
| Forge / auth | GitHub only, via the user's `gh` login (GHE works through gh) | Already used by `gitCommitPr` (`src/main/files.ts:453`). No OAuth app. |
| Open | Paste a PR URL or `#number`. No inbox | Smallest entry point. |
| Checkout | **New worktree per PR** on the PR head (`gh pr checkout` in the new worktree, which handles forks) | Full workspace: tree, ⌘P, terminal, and the agent can run tests. Your own work is isolated. |
| Lifecycle | Kept until you remove it. Status badge (open / approved / merged / closed) updates on Refresh. A remove prompt appears after merge or close | You often come back for a second round. |
| Layout | Left group: PR tab. Right group: Claude chat. The tree pane switches to "PR files". Diff tabs open next to the PR tab | |
| PR tab | **Native** (gh api + marked/DOMPurify + `@/ui`). Description, conversation timeline and pending-review tray only. No checks, reviewers or commits in v1 | Matches the theme, links to Tawny's editor and agent. New UI pieces need human sign-off (AGENT.md). |
| PR files | Diff against the merge-base, with per-file "viewed" checkboxes | |
| Inline comments | Monaco diff view zones for existing threads, your pending drafts and agent findings. Click or drag in the gutter to compose | GitHub / VS Code PR experience. |
| Suggestions | Supported for you and the agent: an optional replacement for the selected lines, rendered as a mini diff and posted as a ```` ```suggestion ```` block | |
| Drafts | **Synced to the GitHub pending review** (GraphQL `addPullRequestReviewThread` etc.), so they're visible on github.com too | You chose sync over local-only. GitHub allows only one pending review per user per PR, so if one exists, Tawny adopts it. |
| Refresh | Manual button. Pulls the PR, all threads and your pending review. If the head moved, fast-forwards the worktree (resets it on force-push). GitHub marks moved comments outdated, and findings from the old head get an "outdated" badge. A banner shows "N new commits", with a "changes since" diff | |
| Existing threads | Replies go into the pending review. Resolve/unresolve acts immediately (as on GitHub) | |
| Submit | One review with every comment kept as its own inline comment (not one long comment), plus an optional summary and a verdict: Comment, Approve or Request changes | Like GitHub's "pending" comments. |
| Agent | **Claude only** in v1. Codex later | Uses /code-review. |
| Do review | A button, never automatic. A popover pre-filled from settings (default instructions and default effort) that you can edit per run, then it runs `/code-review <effort> <instructions>` | Repo REVIEW.md/CLAUDE.md still apply. **Never pass `--comment`/`--fix`**, and always pass an explicit level (with none, it reuses the last level typed). |
| Agent output | Findings and chat-proposed comments land in a Tawny findings list. Each needs **"Add to review"** before it reaches the pending review; otherwise you dismiss it | The pending review only holds what you agreed with. |
| Agent limits | Never edits, pushes or posts. It gets read-only PR context and the `propose_comment` tool | |

## Spike findings (2026-11-06, adapter 0.95.0, claude 2.1.318, no model calls)

Script: `/tmp/pr-spike/client.mjs` (not committed). It spawns the adapter, then runs `initialize` → `session/new` with one stdio MCP server → a local-only `/mcp` prompt (0 tokens).

- **/code-review is advertised over ACP.** `available_commands_update` lists `code-review` with input hint `[low|medium|high|xhigh|max|ultra] [--fix] [--comment] [<pr#>|<branch>|<path>] [--max-findings <n>|all]`. That means the effort level and extra text go in as plain prompt text (`/code-review high <instructions>`). `ultrareview` and `security-review` are listed too.
  - Note: the recorded fixtures only show 5 commands because `scripts/acp-spike.ts` trims the list.
- **Findings arrive structured.** The adapter has a `ReportFindingsReporter` (`dist/tool-calls/reporters/interaction.js:136`).
  - /code-review reports through a `ReportFindings` tool call, and `rawInput.findings[]` carries `{file, line, summary, failure_scenario, category?, short_summary?, verdict?}`.
  - Tawny reads it from `tool_call.rawInput`, so there's no text parsing.
  - The schema has a single line, no side and no suggestion. "Add to review" therefore maps a finding to a draft (single line, RIGHT side, body = summary + failure scenario) that you can edit. You can also ask the agent to turn it into a suggestion through `propose_comment`.
- **MCP over `session/new` works, including stdio.** A stdio server passed in `mcpServers` connected and exposed its tool (`/mcp` → "`tawny-pr`: 1 tool"). `mcpCapabilities` only advertises http/sse, but the adapter maps stdio too (`acp-agent.js:8505`). Tawny can ship its MCP server as a small stdio script, run with Electron as Node.
- **The system prompt can be extended.** `_meta.systemPrompt = { append: "<PR context>" }` keeps the claude_code preset and appends to it (`acp-agent.js:8535`). The spec-level `systemPrompt` replaces the preset (capability `mode.override`), so **don't** use it.
- **Not verified:** an actual /code-review run over ACP emitting `ReportFindings`, which needs model calls. Record a fixture once, deliberately, against a throwaway PR (phase 4).

## Architecture

```
renderer                             main                                   children
PR tab, PR files view, diff zones ─IPC pr:*─▶ pr.ts (gh api / GraphQL)  ──▶  gh
findings list, Do review popover                 │ state per PR session
chat tab (existing) ◀── chat:update ── acp.ts ──stdio──▶ claude-agent-acp ──▶ claude
                                                   │ mcpServers: [tawny-pr (stdio)]
                                                   └─ _meta.systemPrompt.append: PR context
tawny-pr MCP (stdio) ──IPC socket──▶ main: propose_comment, get_pr, get_threads
```

- **`src/main/pr.ts`**
  - `parseRef(url|#n)`, `open(ref)`: resolve → worktree (via `git.ts`) → `gh pr checkout` → session.
  - `fetch(pr)`: one GraphQL query for PR metadata, body, timeline comments, review threads (with `isOutdated`, `originalCommit`) and the viewer's pending review.
  - Pending-review mutations: `addPullRequestReview` (draft), `addPullRequestReviewThread`, `addPullRequestReviewThreadReply`, `updatePullRequestReviewComment`, `deletePullRequestReviewComment`, `submitPullRequestReview {event, body}`.
  - Live mutations: `resolveReviewThread`, `unresolveReviewThread`.
  - All of it runs through `gh api graphql`.
- **Session model.** A PR session is a worktree workspace with `pr: {owner, repo, number, headSha, baseSha}` stored on it, and the tab key `p:<owner>/<repo>#<n>`. The chat tab is an ordinary `kind: 'chat'` session created with extra `mcpServers` and `_meta.systemPrompt.append`.
- **MCP server `tawny-pr`.** A stdio script that relays to main over a per-session local socket (path in env).
  - `propose_comment {path, startLine?, line, side, body, suggestion?}`: adds to the findings list and returns an id.
  - `get_pr`, `get_threads`: read-only.
- **Findings list.** Built from `ReportFindings` tool calls and from `propose_comment`. Stored per PR session, marked outdated when `headSha` changes, and gives Add to review / Dismiss / Jump.
- **Settings.** `prReview.instructions` (string) and `prReview.effort` (`low|medium|high|xhigh|max`, default `medium`).
- **Fixtures.**
  - `TAWNY_GH_FIXTURE` replaces `gh` with recorded GraphQL responses, and mutations update an in-memory pending review.
  - A recorded ACP fixture covers a /code-review turn with `ReportFindings`.
  - No real GitHub or agent calls during dev verification.

## Phases

0. ~~Spike: /code-review over ACP, MCP via session/new~~ (done, above).
1. ~~**Open + checkout.**~~ (done: `src/main/pr.ts`, launcher "Review PR…", `test/fixtures/gh/`; PR tab is a placeholder pane `PrPane.tsx`). Parse a URL or #n, create the worktree, `gh pr checkout`, open the session with the layout, add the gh fixture layer.
2. ~~**PR tab, read-only.**~~ (done) Description and timeline from GraphQL, a Refresh button, the status badge. Get UI sign-off first.
3. ~~**PR files + inline threads, read-only.**~~ (done) Merge-base diff list, viewed checkboxes, view zones for existing threads.
4. ~~**Agent.**~~ (done) Chat with the PR system prompt and the `tawny-pr` MCP server. Do review popover and settings. Findings list from `ReportFindings` and `propose_comment`. Record the fixture.
5. ~~**Pending review sync.**~~ (done) Compose in the gutter, add findings to the review, edit/delete drafts, replies, resolve/unresolve, suggestions.
6. ~~**Submit + refresh on new commits.**~~ (done) Verdict submit, fast-forward or reset the worktree, outdated badges, "changes since" banner, remove prompt after merge or close.

## Open risks

- A pending review already started on github.com: adopt it on open. Check that GraphQL returns the viewer's PENDING review and its threads.
- Line mapping for suggestions on LEFT-side or deleted lines: GitHub only allows suggestions on RIGHT-side lines, so disable it elsewhere.
- Monaco view zones with many threads in the side-by-side diff could hurt performance.
- The /code-review output shape could change with Claude Code versions. Pin and record a fixture, and fall back to showing chat text if no `ReportFindings` tool call arrives.

## Phase 1 notes (deviations)

- PR metadata lives in `store.data.prSessions[<worktree path>]` (worktrees themselves aren't stored); `Worktree.pr` is attached in `refreshWorktrees` and drives the sidebar badge. `pr.state` is one of open/draft/approved/merged/closed.
- Real checkout: `git worktree add -b pr-<n>` from HEAD, then `gh pr checkout <n> --branch pr-<n> --force` inside it (force resets that branch to the PR head). Fixture checkout: worktree from `localBranch`, see `test/fixtures/gh/README.md`.
- The renderer lays the workspace out (`openPrReview` in `lib/actions.ts`): seed the PR tab, activate, create the chat, then `splitAgentRight`. Reopening a PR that already has a worktree reuses it. `main` does not activate the worktree.
- `Gh.graphql` and the fixture `mutationHandlers` exist but nothing uses them yet.
- The repo hosting a URL's checkout is found by matching git remotes of repos known to Tawny; `#N` uses the active workspace's repo.

## Phase 2 notes (deviations)

- One query `PrView` (`PR_QUERY` in `src/main/pr.ts`) -> `PrSnapshot` (`src/shared/types.ts`: `PrThread`, `PrReview`, `PrReviewComment`, `PrTimelineItem`). Snapshot persisted in `store.data.prSnapshots[<worktree path>]`. IPC `pr:fetch` (stored, else fetch) and `pr:refresh` (always fetch; updates `prSessions` title/head/base/state, so the sidebar badge follows).
- Lists capped at 100 per connection (comments, reviews, threads, comments per thread): no pagination yet. Timeline = issue comments + non-pending reviews; inline review comments only appear in the "Review threads" section (reviews show a count). Pending review is the viewer's `PENDING` review, kept in `snapshot.pendingReview` with its comments.
- Fixture `graphql.PrView` is an array of snapshots: first call = open, later calls = next (Refresh shows the v2 snapshot). See fixtures README.
- Thread path click opens `<worktree>/<path>` in the editor at the line (no diff yet).
- Avatars are `<img>` from GitHub avatarUrl (broken-image placeholder offline).
- Not done: dark theme check, pagination.

## Phase 3 notes (deviations)

- Tree pane: new view `pr` ("PR files", `tree/PrFilesView.tsx`), only in the rail for PR worktrees and auto-selected the first time such a worktree becomes the tree root (not persisted). IPC `pr:files` -> `PrFiles` `{ base, files }`: `git merge-base <baseSha> HEAD` (fetches `origin/<baseRef>` if the base commit isn't local), then `git diff --name-status -M <base> HEAD`. Under a fixture the base is the local branch `localBase` (the recorded base sha is fake).
- Viewed checkboxes: `ui.prViewed[<worktree path>] = string[]` via `saveUi`. Not reset when the head moves (a changed file stays viewed; phase 6 may want to clear it).
- Diff tab: new key mode `d:r:<mergeBaseSha>:<abs path>` (merge-base <-> worktree `HEAD`, read-only, via `gitShow`). Not refreshed by `refreshDiffs`; renames show the old side as missing (key has no old path).
- Threads: `editor/prThreads.tsx` draws one view zone per thread (React root per zone, `@/ui` Card/Collapsible/Message, shared `workspace/prParts.tsx`) from `H.prFetch`; redrawn when the PR tab loads/refreshes (`prSnapshotChanged`). RIGHT threads go in the modified editor, LEFT (non-outdated) in the original editor. Resolved = collapsed with a badge; outdated = shown at `originalLine` with an "Outdated" badge (line may not match the current head).
- Fixtures: `localBase` in `pr-basic.json`, `test/fixtures/gh/make-repo.sh` builds a scratch repo lining up with the threads.
- Not done: dark theme check, threads on files not in the merge-base diff, pagination, `d:r` keys across restarts if the merge-base changes.

## Phase 4 notes (deviations)

- PR chats: `Agents.prContext` (set in `main.ts` to `PrAgent.context`, `src/main/pr-agent.ts`) gives every chat created in a PR worktree (also on restore) a `PrChatCtx`: `mcpServers: [tawny-pr]` and `_meta.systemPrompt.append` (Claude only, on session/new, load and resume), plus the `onFindings` sink. Not applied to other worktrees.
- `tawny-pr` MCP: `src/main/tawny-pr-mcp.ts`, built as a second main entry (`out/main/tawny-pr-mcp.js`), uses `@modelcontextprotocol/sdk` (was only a transitive peer dep; now a direct dep with `zod`, lockfile touched, both in `asarUnpack`). The agent spawns it with `ELECTRON_RUN_AS_NODE=1`; it relays newline-JSON over a per-chat unix socket in `os.tmpdir()` (`TAWNY_PR_SOCKET`), closed when the chat exits. Packaged-app path (asar.unpacked) is untested.
- Findings: `store.data.prFindings[<worktree path>]` (`PrFinding` in `shared/types.ts`), IPC `pr:findings`, `pr:findingStatus`, event `pr:findings`. ReportFindings is detected in `Chat.push` by any update whose `rawInput.findings` is an array (streamed `tool_call_update` included), ids `r-<toolCallId>-<i>` so replays don't duplicate. `propose_comment` ids `p-<hex>`. Outdated = finding `headSha` != snapshot `headSha` (badge). Findings are remapped through the shared `src/main/review-core.ts` (anchor captured on add, nearest match on list, Outdated if none), shared with local review ([local-review-plan.md](local-review-plan.md)); done.
- Findings UI: `workspace/PrFindings.tsx` (list in the PR tab, `FindingCard`, `DoReview`), view zones in `editor/prThreads.tsx` (open findings, same card), Jump via `editor/prReveal.ts` (opens the `d:r` diff, scrolls the modified editor). Files outside the merge-base diff open as plain files.
- "Add to review" only sets status `accepted` (badge "Added to review"). **Phase 5 hook: `addToReview` in `PrFindings.tsx`** (and `PrAgent.setStatus` in main) is where the pending-review draft must be created (single line, RIGHT, body = summary + failure scenario; propose_comment findings carry `startLine`, `side`, `suggestion`).
- Settings are flat dotted keys in the settings JSON: `"prReview.instructions"` (default empty) and `"prReview.effort"` (default `medium`); there is no settings form in the app, the JSON file is the settings UI.
- Do review is a `@/ui/dialog` (there is no popover in `@/ui`), effort `Select` + instructions `Textarea`, sends `/code-review <effort> <instructions>` through the chat composer controller (`tawnyChat.send`, keeps the draft, queues if busy). Never `--comment`/`--fix`.
- Fixture `test/fixtures/acp/pr-code-review.jsonl`: **hand-written** (derived from `claude-basic`), a `/code-review medium` turn with a `ReportFindings` tool_call matching `test/fixtures/gh/make-repo.sh` paths. **A real recording is still TODO** (needs model calls, throwaway PR). Use with `TAWNY_ACP_FIXTURE` + `TAWNY_GH_FIXTURE` as in the gh README.
- Not done: fallback is implicit (no ReportFindings = chat text only), dark theme check, a real `claude` run of the MCP tool.

## Phase 5 notes (deviations)

- Main: `Pr.review(dir, PrReviewAction)` (`kind: thread | reply | edit | delete | resolve`) runs the GraphQL mutations through `Gh.graphql` (scalar variables, since `gh -F` can't pass input objects; null/undefined vars are skipped) and returns the re-fetched snapshot. IPC `pr:review`; `pr:findingAdd` (`PrAgent.addToReview`) drafts a finding and marks it accepted. `pr:findingStatus 'accepted'` alone no longer drafts anything.
- Pending review: `pendingReviewId` uses the snapshot's pending review (adoption), else `addPullRequestReview`; if that fails (a pending one was made on github.com since the last fetch) it re-fetches and adopts. `PrSnapshot.prId` (PR node id) is new, so snapshots stored before phase 5 are re-fetched on the first draft.
- Re-fetch after a mutation is the same query under the name `PrViewSync` (so the fixture can tell it from a user Refresh). Pending comments come back inside `reviewThreads` (GitHub returns the viewer's pending comments there), so drafts, replies and threads render through the same `PrThread` path; a comment is a draft when `reviewId === snapshot.pendingReview.id`.
- Suggestions: the composer sends `suggestion` separately; main appends a ```` ```suggestion ```` block (`withSuggestion`) and only for `side: RIGHT`. The checkbox is disabled on the LEFT side. The mini diff (`SuggestionDiff`) exists only in the composer; posted suggestions render as a plain code block in `Md`.
- Composer: `onMouseDown`/`onMouseUp` on the line numbers of both diff editors (`editor/prThreads.tsx`, side = the editor clicked; inline diff mode only has the modified one). Click = one line, drag = range. Draft text is kept across zone redraws. Cmd/Ctrl+Enter submits, Escape cancels.
- View zones now use `suppressMouseDown: false`. With `true` Monaco captured the mouse on mousedown, so real clicks on buttons inside zones (finding card, collapsibles) never fired their click (a phase 3/4 bug).
- New files: `workspace/PrDrafts.tsx` (Composer, CommentView with Pending badge + Edit/Delete, ReplyBox, SuggestionDiff, `prReview` helper that notifies the bus), `editor/prBus.ts` (the snapshot listener bus, moved out of `prThreads.tsx`; the PR tab now also listens, so a diff-side mutation updates the tab). Threads in the PR tab and the pending tray reuse CommentView.
- Findings "Add to review": `FindingCard` got an Edit toggle (body textarea, suggestion textarea on RIGHT) before adding; after adding, edit the draft like any pending comment. ReportFindings body = summary + blank line + failure scenario.
- Resolve / Unresolve is in the diff thread card only (hidden on threads made only of drafts), applies immediately.
- Fixture: see `test/fixtures/gh/README.md`. Fixture draft comments are authored by `chu`.
- Not done: LEFT-side composer and the resolve button were not exercised through the UI (only inline diff mode was driven; resolve through IPC), no pagination (a pending review with more than 100 comments is cut), no outdated-line remapping for drafts on an old head, submit (phase 6; the tray says so).

## Phase 6 notes (deviations)

- Submit: `Pr.submit(dir, verdict, body)` (IPC `pr:submit`) reuses `pendingReviewId` (so zero drafts starts an empty review), runs `submitPullRequestReview {event, body}` and re-fetches (`PrViewSync`). UI: `workspace/PrSubmit.tsx`, a `@/ui/dialog` with verdict `Select` and summary `Textarea`, opened from the pending tray. Guard (UI and main): Comment / Request changes need a summary or at least one draft; Approve is always allowed. Drafts stay separate inline comments.
- Fixture: `SubmitReview` mutation handler moves the in-memory pending review into `fx.state.submitted`; the overlay renders it as a normal review (state, body, comments in threads) and sets `reviewDecision` for approve / request changes.
- Refresh: `Pr.refresh` (IPC `pr:refresh`) re-fetches, and when the head differs from the previous snapshot (or an earlier sync was blocked) runs `syncWorktree`. It refuses with `snap.syncWarn` (amber card in the PR tab) if the worktree has uncommitted changes; retried on the next Refresh. Real path: `gh pr checkout <n> --branch pr-<n> --force` (handles forks and force-push), then checks HEAD equals the PR head. Fixture path: `localBranchNext` in the fixture PR entry, fast-forward (or reset when not an ancestor); `make-repo.sh` builds `pr-fixture-7-v2` (one more commit on `src/cache.ts`).
- `PrSnapshot.moved` (`PrMoved`: from, to, count, forced, files, latest) is persisted with the snapshot and carried across re-fetches until Dismiss (`pr:dismissMoved`). Repeated refreshes extend `from` (cumulative). Banner (`MovedBanner` in `PrPane.tsx`) shows "N new commits" with a "Changes since" list; each file opens `d:r:<from>:<path>` (old head <-> worktree HEAD), so no new diff mode was needed. Reset after force-push: the old commit stays in the object db, so the diff still works.
- Open `d:r` tabs: `refreshDiffs` no longer skips mode `r` (re-reads both sides, using the sha from the key); PrPane also calls it after a Refresh that moved the head. Thread / finding zones redraw through the snapshot bus. The merge-base in a `d:r` key is not recomputed if the base moves.
- prViewed: files in `moved.latest` (changed by the latest update) lose their viewed mark (`clearViewed` in `PrFilesView.tsx`).
- Outdated badge on findings (finding `headSha` != snapshot `headSha`) confirmed after refresh in the diff zone.
- Merged / closed: PR tab shows a card with "Remove worktree" calling the existing `deleteWorktree` flow (own confirm, dirty handling). Shown whenever the snapshot state is not OPEN.
- Fixture `PrView` now has 3 snapshots (open, v2 with new head, v3 merged). Note: the first Refresh after a cached open returns snapshot 0.


## Commit review (2026-11-07)

- The PR files pane lists all PR commits oldest first, excluding commits reachable from the base (no 50/100-commit cap). All changes remains the default. Selecting a commit lists its files and opens the existing read-only parent-to-commit diff; Previous / Next commit navigate the list. The worktree stays on the PR head.
- Each commit has an explicit reviewed checkbox and the pane shows N of M reviewed. Opening a commit does not mark it reviewed. `ui.prReviewedCommits` stores SHAs per `host/owner/repo#number`, independently of the GitHub review verdict. New and rewritten SHAs start unreviewed; surviving SHAs retain their status. Progress counts only commits currently in the PR.
- Viewed files are separate for All changes and each commit (`ui.prViewed[<dir>:<sha>]`). Both progress stores hydrate after the initial app-state IPC, so progress survives a full reload.
- Historical diffs do not draw current-head threads, findings or the comment composer. Return to All changes for inline comments; historical comment anchoring/remapping remains future work. Agent Do review continues to review the full PR.
- Commit diffs fetch their rename metadata directly rather than relying on the Source pane's expanded-commit cache, including after restart.
- Verified with the local gh/ACP fixtures over CDP: parent-to-commit diffs and rename sides, previous/next, viewed/reviewed state across reloads, new commits, rewritten SHAs, and both themes. New progress text uses foreground colours (minimum 5.17:1 on selected rows); commit checkbox boundaries use foreground (minimum 6.57:1 on the pane), with checked icons above 3:1.
