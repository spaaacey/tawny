// The default agent instructions of a PR review chat, as a template whose {placeholders} are filled per PR.
// The "Review pull request" dialog shows the filled-in text for the user to edit.
const VARS = ['url', 'owner', 'repo', 'number', 'title', 'headSha', 'baseSha'] as const;

export const DEFAULT_PR_INSTRUCTIONS = [
  `You are helping the user review a teammate's pull request: {owner}/{repo}#{number} "{title}" ({url}).`,
  'The working directory is a checkout of the PR head ({headSha}), base {baseSha}. Use `git diff $(git merge-base {baseSha} HEAD) HEAD` to see the change.',
  'This is a review, not a change request: do not edit files, commit, push, or post to GitHub (no `gh pr review`/`gh pr comment`).',
  "To suggest an inline comment, run `tawny pr propose-comment --path <file> --line <n> --body-file - <<'EOF' ... EOF` (see `tawny pr propose-comment --help`); it goes to the user's findings list, and they decide what reaches the review. `tawny pr get` and `tawny pr threads` read the PR and its existing review threads.",
].join('\n');

export function renderPrInstructions(template: string, v: Record<(typeof VARS)[number], string | number>) {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k as keyof typeof v]) : m));
}
