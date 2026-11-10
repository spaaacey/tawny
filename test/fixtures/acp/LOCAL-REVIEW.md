Synthetic fixtures for local review ([docs/local-review-plan.md](../../../docs/local-review-plan.md), T6). Not recorded from a live agent.

- `local-code-review.jsonl`: the review chat. Prompt `/code-review medium main Include uncommitted and untracked working-tree changes.`; a ReportFindings tool call (id `toolu_fixture_lr_report_1`) with 3 findings:
  - `src/session.ts:9`: committed, new file
  - `src/api/client.ts:12`: committed, modified
  - `src/config.ts:4`: uncommitted
- `local-review-resolve.jsonl`: the fix chat. Its prompt mimics "Send to agent" for item 0. The agent shows an Edit, then runs `tawny review resolve r-toolu_fixture_lr_report_1-0 --note "..."` as a Bash tool call. The permission request is auto-allowed because it's a tawny call. The id follows `PrAgent.fromReport`'s scheme, `r-<toolCallId>-<index>`. Replay only shows the call: nothing is executed. The note has no shell metacharacters on purpose: `isTawnyCall` rejects any of `;&|$()<>` and backticks, so a note like `Date.now()` would get a permission prompt.

`make-local-repo.sh` creates the matching scratch repo `gadgets` and prints its path. It has `main` and the checked-out branch `local-review-fixture`, with 2 commits, an uncommitted edit to `src/config.ts` and an untracked `NOTES.md`. The finding lines match it.

Two files, not one: `FixtureAgent` (`src/main/acp.ts`) replays only the first `session/prompt` turn, and every later prompt replays that same turn. The review and the fix also run in different chats. `TAWNY_ACP_FIXTURE` applies to every chat in the process, so switching fixtures means restarting dev.

```sh
d=$(test/fixtures/acp/make-local-repo.sh)
TAWNY_ACP_FIXTURE=$PWD/test/fixtures/acp/local-code-review.jsonl npm run dev -- --repo $d
TAWNY_ACP_FIXTURE=$PWD/test/fixtures/acp/local-review-resolve.jsonl npm run dev -- --repo $d
```
