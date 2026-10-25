# Worktree workflow

Work in a new worktree, then land it on `main` with a clean history: no `Merge branch ...` commit.

Shortcut for steps 4-5: from the worktree, run `npm run land` (or `scripts/land.sh`). It rebases onto `main`, then fast-forwards `main` in the main worktree. Your commit messages land unchanged, and the worktree and branch stay in place.

1. Create the worktree: `cmd+option+n` in Tawny, or from the main worktree:
   ```sh
   git worktree add ../harbor-app.worktrees/my-feature -b my-feature
   ```
2. Work and commit in the new worktree. Use a clear message: imperative, one line, no prefix (`Add pages: multiple pane layouts per workspace`).
3. Tidy the branch into the commits you want on `main` (optional):
   ```sh
   git rebase -i main      # squash/reword
   ```
4. Put the branch on top of the latest `main`:
   ```sh
   git rebase main
   ```
5. In the **main worktree** (`main` can only be checked out there), fast-forward:
   ```sh
   cd /Users/chu/src/harbor-app
   git merge --ff-only my-feature
   ```
   Fast-forward adds the branch's commits as-is, so no merge commit. If it refuses, `main` moved: repeat step 4.

   To land as a single commit with your own message instead:
   ```sh
   git merge --squash my-feature
   git commit -m "Add my feature"
   ```
6. Clean up:
   ```sh
   git worktree remove ../harbor-app.worktrees/my-feature
   git branch -d my-feature      # use -D after --squash; git can't tell it was merged
   ```

Never run plain `git merge my-feature` or `git pull` without `--ff-only` / `--rebase` on `main`; both can create the merge commit.
