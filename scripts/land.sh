#!/usr/bin/env bash
# Land the current worktree's branch on main as-is: rebase onto main, then fast-forward main in the main worktree.
# No merge commit; the worktree's commit messages are what main gets. Leaves this worktree and branch in place.
set -euo pipefail

branch=$(git symbolic-ref --short HEAD)
main_branch=main
[ "$branch" != "$main_branch" ] || { echo "already on $main_branch" >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "commit or stash changes in this worktree first" >&2; exit 1; }

main_tree=$(git worktree list --porcelain | awk -v b="refs/heads/$main_branch" '/^worktree /{w=substr($0,10)} $1=="branch" && $2==b {print w}')
[ -n "$main_tree" ] || { echo "$main_branch isn't checked out in any worktree" >&2; exit 1; }

git rebase "$main_branch"
git -C "$main_tree" merge --ff-only "$branch"
git -C "$main_tree" log --oneline -n 3
