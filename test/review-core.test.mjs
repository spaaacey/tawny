import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureAnchor, parseProposal, parseReportFindings, remap } from '../src/main/review-core.ts';

const file = (...lines) => lines.join('\n');
const base = file('import a', 'import b', '', 'function f() {', '  return 1;', '}', '', 'function g() {', '  return 1;', '}');

test('parseReportFindings strips worktree paths, defaults line, skips incomplete entries', () => {
  const out = parseReportFindings('/w/repo', 'tc1', [
    { file: '/w/repo/src/a.ts', line: 3, summary: 'S', failure_scenario: 'F', category: 'bug', verdict: 'real' },
    { file: './b.ts', short_summary: 'short' },
    { file: 'c.ts' },
    null,
    { summary: 'no file' },
  ]);
  assert.deepEqual(out, [
    {
      id: 'r-tc1-0',
      source: 'review',
      path: 'src/a.ts',
      line: 3,
      side: 'RIGHT',
      body: 'S',
      detail: 'F',
      category: 'bug',
      verdict: 'real',
    },
    {
      id: 'r-tc1-1',
      source: 'review',
      path: 'b.ts',
      line: 1,
      side: 'RIGHT',
      body: 'short',
      detail: undefined,
      category: undefined,
      verdict: undefined,
    },
  ]);
  assert.equal(parseReportFindings('/w', '', [{ file: 'x', summary: 's' }])[0].id, 'r-x-0');
});

test('parseProposal validates and normalises', () => {
  const p = parseProposal({ path: './a.ts', line: 9, start_line: 4, side: 'LEFT', body: 'b', suggestion: 's' });
  assert.match(p.id, /^p-[0-9a-f]{8}$/);
  assert.deepEqual({ ...p, id: '' }, {
    id: '',
    source: 'propose',
    path: 'a.ts',
    line: 9,
    startLine: 4,
    side: 'LEFT',
    body: 'b',
    suggestion: 's',
  });
  assert.equal(parseProposal({ path: 'a', line: 2, start_line: 5, body: 'b' }).startLine, undefined);
  assert.equal(parseProposal({ path: 'a', line: 2, body: 'b' }).side, 'RIGHT');
  assert.throws(() => parseProposal({ path: 'a', line: 0, body: 'b' }));
  assert.throws(() => parseProposal({ path: 'a', line: 1, body: '  ' }));
  assert.throws(() => parseProposal({ line: 1, body: 'b' }));
});

test('captureAnchor keeps up to 2 lines of context, clipped at file edges', () => {
  assert.deepEqual(captureAnchor(base, 5), {
    text: '  return 1;',
    before: ['', 'function f() {'],
    after: ['}', ''],
  });
  assert.deepEqual(captureAnchor(base, 1), { text: 'import a', before: [], after: ['import b', ''] });
  assert.deepEqual(captureAnchor(base, 10), { text: '}', before: ['function g() {', '  return 1;'], after: [] });
  assert.equal(captureAnchor(base, 11), undefined);
  assert.equal(captureAnchor(base, 0), undefined);
});

test('remap follows the anchor block when lines are inserted above', () => {
  const anchor = captureAnchor(base, 9); // g's `return 1;` (same text as line 5)
  const edited = file('// header', '// more', base);
  assert.deepEqual(remap({ line: 9, anchor }, edited), { line: 11, outdated: false });
  assert.deepEqual(remap({ line: 9, anchor }, base), { line: 9, outdated: false });
});

test('remap picks the block match nearest the old line on a tie', () => {
  const dup = file('a', 'b', 'x', 'c', 'd', 'a', 'b', 'x', 'c', 'd');
  const anchor = captureAnchor(dup, 8);
  assert.deepEqual(remap({ line: 8, anchor }, dup), { line: 8, outdated: false });
  assert.deepEqual(remap({ line: 2, anchor }, dup), { line: 3, outdated: false });
});

test('remap falls back to a unique line match when context changed', () => {
  const anchor = captureAnchor(file('one', 'two', 'target();', 'three', 'four'), 3);
  assert.deepEqual(remap({ line: 3, anchor }, file('changed', 'target();', 'x')), { line: 2, outdated: false });
});

test('remap marks outdated (at the old line) when the line is gone or ambiguous', () => {
  const anchor = captureAnchor(base, 5);
  assert.deepEqual(remap({ line: 5, anchor }, file('nothing', 'here')), { line: 5, outdated: true });
  // context gone, and `  return 1;` appears twice
  assert.deepEqual(remap({ line: 5, anchor }, file('  return 1;', 'x', '  return 1;')), { line: 5, outdated: true });
});

test('remap ignores trailing whitespace and CRLF', () => {
  const anchor = captureAnchor(base, 5);
  assert.deepEqual(remap({ line: 5, anchor }, base.replaceAll('\n', '\r\n').replace('return 1;', 'return 1;  ')), {
    line: 5,
    outdated: false,
  });
});

test('remap without an anchor keeps the line, outdated only past the end', () => {
  assert.deepEqual(remap({ line: 3 }, base), { line: 3, outdated: false });
  assert.deepEqual(remap({ line: 99 }, base), { line: 99, outdated: true });
});
