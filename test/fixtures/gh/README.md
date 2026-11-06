# gh fixtures

`TAWNY_GH_FIXTURE=<file>` makes `src/main/pr.ts` answer every `gh` call from the JSON file instead of running `gh` (no network, no GitHub mutations).

- `prs["<host>/<owner>/<repo>#<n>"]`: the `gh pr view --json number,title,state,isDraft,url,headRefOid,baseRefOid,reviewDecision` response. `headRefOid` is optional (read from `localBranch`).
- `prs[...].localBranch`: a branch in the local repo that stands for the PR head. Under a fixture there is no `gh pr checkout`: the PR worktree is created straight from this branch (`git worktree add <dir> <branch>`), so it must exist and not be checked out anywhere else.
- `prs[...].localBase`: a local branch standing for the PR base (the fixture's recorded base sha isn't real): phase 3's merge-base file list is taken against it.
- `make-repo.sh` creates a scratch repo with `main` and `pr-fixture-7` (3 changed files) that lines up with the threads in `pr-basic.json`.
- `graphql[<OperationName>]`: canned response of a named `query` (used from phase 2). An array value = successive snapshots: the first call returns `[0]`, each later call the next one (the last repeats). `PrView` has two: open shows the first, the PR tab's Refresh switches to the second (new title, head sha, an extra comment and approval). Mutations (phase 5) are handled by functions registered in `mutationHandlers` in `src/main/pr.ts`; they edit the in-memory fixture, never the file.
- The repo that hosts the checkout is matched by its git remotes, so a test repo needs `git remote add origin git@github.com:acme/widgets.git`.

Try it (scratch repo + dev instance with a fake agent):

```sh
d=$(mktemp -d)/widgets && git init -q -b main $d && git -C $d commit -q --allow-empty -m init
git -C $d remote add origin git@github.com:acme/widgets.git
git -C $d branch pr-fixture-7
TAWNY_GH_FIXTURE=$PWD/test/fixtures/gh/pr-basic.json TAWNY_ACP_FIXTURE=$PWD/test/fixtures/acp/claude-basic.jsonl npm run dev -- --repo $d
```

Then in a new tab choose "Review PR…" and enter `https://github.com/acme/widgets/pull/7` or `#7`.
