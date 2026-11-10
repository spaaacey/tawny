import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remapped } from '../src/main/review-core.ts';
import { buildFixPrompt, resolveCommand } from '../src/shared/local-review.ts';

test('resolveCommand uses a quoted heredoc for the note', () => {
  assert.equal(
    resolveCommand('r-x-0', 'uses Date.now() / 1000 && $HOME'),
    "tawny review resolve r-x-0 <<'EOF'\nuses Date.now() / 1000 && $HOME\nEOF",
  );
});

test('buildFixPrompt lists items and teaches the heredoc resolve form', () => {
  const p = buildFixPrompt([
    { id: 'r-t-0', path: 'src/a.ts', line: 9, body: 'Seconds vs ms', detail: 'Every session expires.' },
    { id: 'u-1', path: 'src/b.ts', line: 5, startLine: 3, body: 'Rename', suggestion: 'const x = `a`;\n```\n' },
  ]);
  assert.match(p, /^Fix these 2 review items\./);
  assert.ok(p.includes("tawny review resolve <id> <<'EOF'\n<what changed>\nEOF"));
  assert.ok(p.includes('1. r-t-0 src/a.ts:9\n   Seconds vs ms\n   Every session expires.'));
  assert.ok(
    p.includes('2. u-1 src/b.ts:3-5\n   Rename\n   Suggested replacement for lines 3-5:\n````\nconst x = `a`;\n```\n````'),
  );
  assert.doesNotMatch(p, /--note/);
});

test('buildFixPrompt singular wording, no suggestion block without one', () => {
  const p = buildFixPrompt([{ id: 'p-1', path: 'x.ts', line: 1, body: 'B', suggestion: '  ' }]);
  assert.match(p, /^Fix this review item\./);
  assert.doesNotMatch(p, /Suggested/);
});

test('remapped shifts line and startLine with the anchor, flags outdated', () => {
  const anchor = { text: 'b', before: ['a'], after: ['c'] };
  const moved = remapped({ id: 'i', line: 2, startLine: 1, anchor }, 'x\ny\na\nb\nc');
  assert.equal(moved.line, 4);
  assert.equal(moved.startLine, 3);
  assert.equal(moved.outdated, undefined);
  const gone = remapped({ id: 'i', line: 2, anchor }, 'x\ny');
  assert.equal(gone.line, 2);
  assert.equal(gone.outdated, true);
});
