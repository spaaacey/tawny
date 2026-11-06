import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffNodes } from '../src/renderer/src/rich/diff.ts';

const text = (value) => ({ type: 'text', text: value });
const paragraph = (...content) => ({ type: 'paragraph', content });
const image = (src) => ({ type: 'image', attrs: { src } });
const kinds = (result) => result.nodes.map((n) => n.attrs?.diff);

test('image replacements preserve old and new versions', () => {
  const old = paragraph(image('old.png'));
  const next = paragraph(image('new.png'));
  const result = diffNodes([old], [next]);
  assert.deepEqual(kinds(result), ['old', 'new']);
  assert.deepEqual(result.nodes.map((n) => n.content), [old.content, next.content]);
});

test('inline image removal and insertion retain surrounding prose', () => {
  const withImage = paragraph(text('hello '), image('a.png'));
  const plain = paragraph(text('hello '));
  for (const [a, b] of [[withImage, plain], [plain, withImage]]) {
    const result = diffNodes([a], [b]);
    assert.deepEqual(kinds(result), ['old', 'new']);
    assert.deepEqual(result.nodes.map((n) => n.content), [a.content, b.content]);
  }
});

test('modified prose marks deleted and inserted words', () => {
  const result = diffNodes([paragraph(text('the old cat'))], [paragraph(text('the new cat'))]);
  const content = result.nodes[0].content;
  assert.ok(content.some((n) => n.text === 'old' && n.marks.some((m) => m.type === 'diffDel')));
  assert.ok(content.some((n) => n.text === 'new' && n.marks.some((m) => m.type === 'diffIns')));
});

test('whitespace-only prose changes produce no marks', () => {
  const result = diffNodes([paragraph(text('hello   world'))], [paragraph(text('hello world'))]);
  assert.equal(result.changed, false);
});

test('a list edit retains unchanged items and marks only changed words', () => {
  const item = (s) => ({ type: 'listItem', content: [paragraph(text(s))] });
  const list = (...content) => ({ type: 'bulletList', content });
  const result = diffNodes([list(item('same'), item('the old cat'))], [list(item('same'), item('the new cat'))]);
  assert.equal(result.nodes[0].attrs?.diff, undefined);
  assert.deepEqual(result.nodes[0].content[0], item('same'));
  assert.match(JSON.stringify(result.nodes[0].content[1]), /diffDel/);
});

test('code, tables and Mermaid preserve both versions', () => {
  for (const type of ['codeBlock', 'table']) {
    const block = (s) => ({ type, content: [text(s)], ...(type === 'codeBlock' ? { attrs: { language: 'mermaid' } } : {}) });
    const result = diffNodes([block('old')], [block('new')]);
    assert.deepEqual(kinds(result), ['old', 'new']);
  }
});

test('removed hard breaks preserve both paragraphs', () => {
  const old = paragraph(text('hello'), { type: 'hardBreak' }, text('world'));
  const next = paragraph(text('hello world'));
  assert.deepEqual(kinds(diffNodes([old], [next])), ['old', 'new']);
});

test('added and removed blocks are marked', () => {
  assert.deepEqual(kinds(diffNodes([], [paragraph(text('added'))])), ['add']);
  assert.deepEqual(kinds(diffNodes([paragraph(text('removed'))], [])), ['del']);
});
