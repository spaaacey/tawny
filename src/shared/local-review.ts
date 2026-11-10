// Local review text shared by main and the renderer (docs/local-review-plan.md): the "Send to agent" prompt and the
// resolve command it teaches. Pure, unit-tested in test/local-review.test.mjs.
import type { ReviewItem } from './types';

/** The command a fix chat runs to mark an item fixed. The note goes through a quoted heredoc (stdin), not argv: Tawny
 *  auto-allows `tawny` calls only without shell metacharacters, and a quoted heredoc keeps the note verbatim. */
export function resolveCommand(id: string, note = '<what changed>') {
  return `tawny review resolve ${id} <<'EOF'\n${note}\nEOF`;
}

/** A fence longer than any backtick run in `text`. */
function fence(text: string) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const indent = (text: string, pad = '   ') =>
  text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');

/** The "Send to agent" prompt for `items` (inserted into the fix chat's composer, not sent): each item's id, `path:line`, body,
 *  failure scenario and suggestion, then how to mark it fixed. */
export function buildFixPrompt(
  items: Pick<ReviewItem, 'id' | 'path' | 'line' | 'startLine' | 'body' | 'detail' | 'suggestion'>[],
) {
  const head = [
    `Fix ${items.length === 1 ? 'this review item' : `these ${items.length} review items`}. After fixing each one, mark it fixed with a short note on what changed, using exactly this form (a quoted heredoc, so the note can contain any characters):`,
    '',
    resolveCommand('<id>'),
    '',
    "If you decide not to fix an item, say why in the chat and don't resolve it.",
  ].join('\n');
  const body = items.map((it, i) => {
    const range = it.startLine && it.startLine < it.line;
    const lines = range ? `${it.startLine}-${it.line}` : `${it.line}`;
    const parts = [`${i + 1}. ${it.id} ${it.path}:${lines}`, indent(it.body.trim())];
    if (it.detail?.trim()) parts.push(indent(it.detail.trim()));
    if (it.suggestion?.trim()) {
      // unindented, so the replacement's own indentation stays exact
      const f = fence(it.suggestion);
      parts.push(
        `   Suggested replacement for ${range ? 'lines' : 'line'} ${lines}:\n${f}\n${it.suggestion.replace(/\n$/, '')}\n${f}`,
      );
    }
    return parts.join('\n');
  });
  return [head, ...body].join('\n\n');
}
