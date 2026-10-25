'use strict';
// Entry for the rich markdown editor bundle (Tiptap). Built by scripts/build-rich.js into src/renderer/vendor/rich.js.
// window.harborRich.create(host, { markdown, onChange, onLink, keys }) → { getMarkdown, setMarkdown, focus, hasFocus, destroy }
import { Editor, Extension, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Heading } from '@tiptap/extension-heading';
import { Image } from '@tiptap/extension-image';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { render as renderMermaid } from 'pele';

const lowlight = createLowlight(common);

/** ```mermaid blocks stay plain code blocks in the document (round-trip untouched); the node view renders the diagram
 *  (pele) and, per block, lets you switch between diagram only (default), code only, or both. */
const MODES = [['diagram', 'Diagram'], ['code', 'Code'], ['both', 'Both']];
const MermaidCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'code-wrap';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      pre.append(code);
      const view = document.createElement('div');
      view.className = 'mermaid-view';
      view.contentEditable = 'false';
      const bar = document.createElement('div');
      bar.className = 'mermaid-modes';
      bar.contentEditable = 'false';
      const btns = MODES.map(([m, label]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.title = label === 'Both' ? 'Code and diagram' : label + ' only';
        b.addEventListener('mousedown', ev => ev.preventDefault());   // keep the editor selection
        b.addEventListener('click', () => { mode = m; sync(); });
        bar.append(b);
        return [m, b];
      });
      dom.append(bar, pre, view);
      let cur = node;
      let mode = 'diagram';
      let timer = 0;
      let shown = null;   // source the diagram on screen was rendered from
      const isMermaid = () => cur.attrs.language === 'mermaid';
      const draw = () => {
        const src = cur.textContent;
        if (src === shown) return;
        shown = src;
        view.classList.remove('err');
        view.textContent = '';
        if (src.trim()) {
          try { view.innerHTML = renderMermaid(src).svg; }
          catch (e) { view.classList.add('err'); view.textContent = e && e.message ? e.message : String(e); }
        }
        sync();
      };
      const sync = () => {
        const m = isMermaid();
        const err = view.classList.contains('err');
        const empty = !view.firstChild;
        // an empty or broken diagram has nothing to show alone, so the source stays visible next to the message
        const eff = !m ? 'code' : err || empty ? (mode === 'diagram' ? 'both' : mode) : mode;
        dom.classList.toggle('mermaid', m);
        dom.classList.toggle('src-hidden', eff === 'diagram');
        view.hidden = !m || eff === 'code' || empty && !err;
        for (const [k, b] of btns) b.classList.toggle('on', k === mode);
      };
      const schedule = () => {
        clearTimeout(timer);
        if (!isMermaid()) { sync(); return; }
        if (shown === null) draw(); else timer = setTimeout(draw, 250);
      };
      code.className = node.attrs.language ? 'language-' + node.attrs.language : '';
      schedule();
      return {
        dom, contentDOM: code,
        update(n) {
          if (n.type !== cur.type) return false;
          cur = n;
          code.className = n.attrs.language ? 'language-' + n.attrs.language : '';
          schedule();
          return true;
        },
        stopEvent: ev => view.contains(ev.target) || bar.contains(ev.target),
        // only edits inside the code text are the editor's business; our own class/diagram changes must not re-create the view
        ignoreMutation: m => m.type !== 'selection' && !(code.contains(m.target) && m.target !== code),
        destroy() { clearTimeout(timer); },
      };
    };
  },
});

const FRONT = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/;
/** YAML front matter isn't markdown: keep it aside so it survives the round trip untouched. */
const splitFront = md => { const m = FRONT.exec(md); return m ? [m[0], md.slice(m[0].length)] : ['', md]; };

const BUTTONS = [
  { t: 'H1', title: 'Heading 1', run: c => c.toggleHeading({ level: 1 }), on: e => e.isActive('heading', { level: 1 }) },
  { t: 'H2', title: 'Heading 2', run: c => c.toggleHeading({ level: 2 }), on: e => e.isActive('heading', { level: 2 }) },
  { t: 'H3', title: 'Heading 3', run: c => c.toggleHeading({ level: 3 }), on: e => e.isActive('heading', { level: 3 }) },
  '|',
  { t: 'B', cls: 'b', title: 'Bold', run: c => c.toggleBold(), on: e => e.isActive('bold') },
  { t: 'I', cls: 'i', title: 'Italic', run: c => c.toggleItalic(), on: e => e.isActive('italic') },
  { t: 'S', cls: 's', title: 'Strikethrough', run: c => c.toggleStrike(), on: e => e.isActive('strike') },
  { t: '</>', cls: 'm', title: 'Inline code', run: c => c.toggleCode(), on: e => e.isActive('code') },
  { t: 'Link', title: 'Link', link: true, on: e => e.isActive('link') },
  '|',
  { t: '• List', title: 'Bullet list', run: c => c.toggleBulletList(), on: e => e.isActive('bulletList') },
  { t: '1. List', title: 'Numbered list', run: c => c.toggleOrderedList(), on: e => e.isActive('orderedList') },
  { t: '☐ Tasks', title: 'Task list', run: c => c.toggleTaskList(), on: e => e.isActive('taskList') },
  '|',
  { t: '❝', title: 'Quote', run: c => c.toggleBlockquote(), on: e => e.isActive('blockquote') },
  { t: '{ }', cls: 'm', title: 'Code block', run: c => c.toggleCodeBlock(), on: e => e.isActive('codeBlock') },
  { t: 'Table', title: 'Insert table', run: c => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }), on: e => e.isActive('table') },
  { t: '―', title: 'Horizontal rule', run: c => c.setHorizontalRule() },
];

/** Raw HTML blocks (<details>, <div align>, comments…) are kept verbatim and shown as source rather than parsed (and lost). */
const HtmlBlock = Node.create({
  name: 'htmlBlock', group: 'block', content: 'text*', marks: '', code: true, defining: true,
  parseHTML: () => [{ tag: 'pre[data-html-block]', preserveWhitespace: 'full' }],
  renderHTML: () => ['pre', { 'data-html-block': '' }, ['code', 0]],
  markdownTokenName: 'html',
  parseMarkdown: (token, h) => {
    const raw = (token.raw || token.text || '').replace(/\s+$/, '');
    return h.createNode('htmlBlock', {}, raw ? [h.createTextNode(raw)] : []);
  },
  renderMarkdown: (node, h) => (node.content ? h.renderChildren(node.content) : ''),
});

function toolbar(editor) {
  const bar = document.createElement('div');
  bar.className = 'rich-bar';
  const items = [];
  for (const b of BUTTONS) {
    if (b === '|') { const s = document.createElement('span'); s.className = 'rb-sep'; bar.append(s); continue; }
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `rb ${b.cls || ''}`;
    el.textContent = b.t;
    el.title = b.title;
    el.addEventListener('mousedown', e => e.preventDefault());   // keep the editor's selection
    el.addEventListener('click', () => {
      if (b.link) return linkPrompt();
      b.run(editor.chain().focus()).run();
    });
    bar.append(el);
    items.push([el, b]);
  }

  const form = document.createElement('form');
  form.className = 'rb-link';
  form.hidden = true;
  form.innerHTML = '<input spellcheck="false" placeholder="https://…  (empty removes the link)">';
  const input = form.firstChild;
  bar.append(form);
  function linkPrompt() {
    if (!form.hidden) { form.hidden = true; editor.commands.focus(); return; }
    input.value = editor.getAttributes('link').href || '';
    form.hidden = false;
    input.focus();
    input.select();
  }
  form.addEventListener('submit', e => {
    e.preventDefault();
    const href = input.value.trim();
    const c = editor.chain().focus().extendMarkRange('link');
    (href ? c.setLink({ href }) : c.unsetLink()).run();
    form.hidden = true;
  });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { form.hidden = true; editor.commands.focus(); } });

  const refresh = () => { for (const [el, b] of items) el.classList.toggle('on', !!(b.on && b.on(editor))); };
  editor.on('transaction', refresh);
  refresh();
  return bar;
}

/** App-level shortcuts that Tiptap would otherwise claim (cmd+B is bold here, but the app uses it for the sidebar). */
const appKeys = keys => Extension.create({
  name: 'harborKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    return Object.fromEntries(Object.entries(keys || {}).map(([k, fn]) => [k, () => { fn(); return true; }]));
  },
});

function create(host, { markdown = '', onChange, onLink, keys, baseDir = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'rich';
  const scroll = document.createElement('div');
  scroll.className = 'rich-scroll';
  const el = document.createElement('div');
  el.className = 'rich-doc';
  scroll.append(el);
  let silent = false;
  let front = '';
  let dir = baseDir;
  const imgSrc = src => (!src || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src) ? src : 'file://' + encodeURI(new URL(src, 'file://' + dir + '/').pathname));
  const ImageRel = Image.extend({
    renderHTML({ HTMLAttributes }) { return ['img', { ...HTMLAttributes, src: imgSrc(HTMLAttributes.src) }]; },
  });
  // Mod-Alt-1..6 would turn into headings here, but they are the app's worktree-jump keys
  const HeadingNoKeys = Heading.extend({ addKeyboardShortcuts: () => ({}) });
  const out = () => front + editor.getMarkdown().replace(/\n*$/, '\n');   // files end with a newline
  [front, markdown] = splitFront(markdown);

  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ codeBlock: false, heading: false, link: { openOnClick: false, autolink: true } }),
      HeadingNoKeys,
      HtmlBlock,
      ImageRel.configure({ inline: true }),
      MermaidCodeBlock.configure({ lowlight, defaultLanguage: null }),
      Markdown,
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      appKeys(keys),
    ],
    content: markdown,
    contentType: 'markdown',
    onUpdate: () => { if (!silent && onChange) onChange(out()); },
    editorProps: {
      attributes: { spellcheck: 'true' },
      handleClick(_view, _pos, ev) {
        const a = ev.target.closest && ev.target.closest('a[href]');
        if (a && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); if (onLink) onLink(a.getAttribute('href')); return true; }
        return false;
      },
    },
  });

  // the host sits inside the Monaco editor's DOM, whose own cmd+b (toggle sidebar) would otherwise fire a second time and undo the first
  wrap.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 'b') e.stopPropagation(); });
  wrap.append(toolbar(editor), scroll);
  host.append(wrap);

  return {
    el: wrap,
    getMarkdown: out,
    setBaseDir(d) { dir = d; },
    /** Replace the document without reporting a change (the caller is the source of this text). */
    setMarkdown(md, { reset = false } = {}) {
      silent = true;
      [front, md] = splitFront(md);
      try {
        editor.commands.setContent(md, { contentType: 'markdown', emitUpdate: false });
        if (reset) { editor.commands.setTextSelection(1); scroll.scrollTop = 0; }
      } finally { silent = false; }
    },
    focus: () => editor.commands.focus(),
    hasFocus: () => editor.isFocused,
    destroy() { editor.destroy(); wrap.remove(); },
  };
}

window.harborRich = { create };
