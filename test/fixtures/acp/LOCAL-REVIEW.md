Synthetic fixtures for local review ([docs/local-review-plan.md](../../../docs/local-review-plan.md), T6). Not recorded from a live agent.

- `local-code-review.jsonl`: the review chat. Prompt `/code-review medium main Include uncommitted and untracked working-tree changes.`; a ReportFindings tool call (id `toolu_fixture_lr_report_1`) with 3 findings:
  - `src/session.ts:9`: committed, new file
  - `src/api/client.ts:12`: committed, modified
  - `src/config.ts:4`: uncommitted
- `local-review-resolve.jsonl`: the fix chat. Its prompt is `buildFixPrompt` (`src/shared/local-review.ts`) for item 0. The agent shows an Edit, then runs `tawny review resolve r-toolu_fixture_lr_report_1-0 <<'EOF' ... EOF` as a Bash tool call, with the note in a quoted heredoc (stdin). The permission request is auto-allowed because it's a tawny call: `isTawnyCall` rejects any of `;&|$()<>` and backticks in the arguments, but allows one quoted heredoc, so the note can contain `Date.now()` etc. The id follows the `r-<toolCallId>-<index>` scheme of `parseReportFindings`. Replay only shows the call: nothing is executed (run the same command in a Tawny terminal to flip the item).

`make-local-repo.sh` creates the matching scratch repo `gadgets` and prints its path. It has `main` and the checked-out branch `local-review-fixture`, with 2 commits, an uncommitted edit to `src/config.ts` and an untracked `NOTES.md`. The finding lines match it.

Two files, not one: `FixtureAgent` (`src/main/acp.ts`) replays only the first `session/prompt` turn of a file. `TAWNY_ACP_FIXTURE` takes a comma-separated list: the nth chat opened in the process plays the nth file (the last one repeats). So list the review fixture first, then the fix one; the review chat is the first chat opened (close/avoid opening other chats before Run).

```sh
d=$(test/fixtures/acp/make-local-repo.sh)
F=$PWD/test/fixtures/acp
TAWNY_ACP_FIXTURE=$F/local-code-review.jsonl,$F/local-review-resolve.jsonl npm run dev -- --repo $d
```
