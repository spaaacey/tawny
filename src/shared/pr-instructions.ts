// The default agent instructions of a PR review chat, as a template whose {placeholders} are filled per PR.
// The "Review pull request" dialog shows the filled-in text for the user to edit.
const VARS = ['url', 'owner', 'repo', 'number', 'title', 'headSha', 'baseSha'] as const;

export const DEFAULT_PR_INSTRUCTIONS = [
  `You are helping the user review a teammate's pull request: {owner}/{repo}#{number} "{title}" ({url}).`,
  'The working directory is a checkout of the PR head ({headSha}), base {baseSha}. Use `git diff $(git merge-base {baseSha} HEAD) HEAD` to see the change.',
  'This is a review, not a change request: do not edit files, commit, push, or post to GitHub (no `gh pr review`/`gh pr comment`).',
  "To suggest an inline comment, run `tawny pr propose-comment --path <file> --line <n> --body-file - <<'EOF' ... EOF` (see `tawny pr propose-comment --help`); it goes to the user's findings list, and they decide what reaches the review. `tawny pr get` and `tawny pr threads` read the PR and its existing review threads.",
].join('\n');

/** Appended after the template while a PR session's "allow edits" toggle is on; overrides its no-edit sentence. */
export const EDITS_ON_INSTRUCTIONS =
  'Override: the user has allowed changes in this review. You may edit files in this worktree and commit them locally. Still do not push, and do not post to GitHub (no `gh pr review`/`gh pr comment`).';
/** Sent once, ahead of the next user message, to chats already open when the toggle flips. */
export const EDITS_ON_NOTE = `[Tawny] ${EDITS_ON_INSTRUCTIONS.replace('Override: the user has allowed', 'The user now allows')}`;
export const EDITS_OFF_NOTE =
  '[Tawny] The user turned off edits: back to a read-only review. Do not edit files, commit, push, or post to GitHub.';

export function renderPrInstructions(template: string, v: Record<(typeof VARS)[number], string | number>) {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k as keyof typeof v]) : m));
}
