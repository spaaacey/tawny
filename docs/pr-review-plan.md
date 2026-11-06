# Plan: PR review sessions

Status: design locked 2026-11-06, spike done (findings below). Phases 1 (open + checkout), 2 (PR tab, read-only) and 3 (PR files + inline threads, read-only) done; phases 4-6 not started.

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
4. **Agent.** Chat with the PR system prompt and the `tawny-pr` MCP server. Do review popover and settings. Findings list from `ReportFindings` and `propose_comment`. Record the fixture.
5. **Pending review sync.** Compose in the gutter, add findings to the review, edit/delete drafts, replies, resolve/unresolve, suggestions.
6. **Submit + refresh on new commits.** Verdict submit, fast-forward or reset the worktree, outdated badges, "changes since" banner, remove prompt after merge or close.

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
