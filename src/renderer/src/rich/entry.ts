// Entry for the rich markdown editor bundle (Tiptap).
// window.tawnyRich.create(host, { markdown, onChange, onLink, onSelectionMenu, onAskLines, keys }) → { getMarkdown, setMarkdown, selectionLines, setAsks, focus, hasFocus, destroy }
import { Editor, Extension, Node } from '@tiptap/core';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Heading } from '@tiptap/extension-heading';
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import { Markdown } from '@tiptap/markdown';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { render as renderMermaid } from 'pele';

// biome-ignore lint/suspicious/noExplicitAny: Tiptap chains, ProseMirror nodes and markdown tokens are used loosely here
type Any = any;

const lowlight = createLowlight(common);

/** ```mermaid blocks stay plain code blocks in the document (round-trip untouched); the node view renders the diagram
 *  (pele) and, per block, lets you switch between diagram only (default), code only, or both. */
const MODES: [string, string][] = [
  ['diagram', 'Diagram'],
  ['code', 'Code'],
  ['both', 'Both'],
];
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
      const btns: [string, HTMLButtonElement][] = MODES.map(([m, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = label === 'Both' ? 'Code and diagram' : `${label} only`;
        b.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep the editor selection
        b.addEventListener('click', () => {
          mode = m;
          sync();
        });
        bar.append(b);
        return [m, b];
      });
      dom.append(bar, pre, view);
      let cur = node;
      let mode = 'diagram';
      let timer: ReturnType<typeof setTimeout> | undefined;
      let shown: string | null = null; // source the diagram on screen was rendered from
      const isMermaid = () => cur.attrs.language === 'mermaid';
      const draw = () => {
        const src = cur.textContent;
        if (src === shown) return;
        shown = src;
        view.classList.remove('err');
        view.textContent = '';
        if (src.trim()) {
          try {
            view.innerHTML = renderMermaid(src).svg;
          } catch (e) {
            view.classList.add('err');
            view.textContent = e?.message ? e.message : String(e);
          }
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
        view.hidden = !m || eff === 'code' || (empty && !err);
        for (const [k, b] of btns) b.classList.toggle('on', k === mode);
      };
      const schedule = () => {
        clearTimeout(timer);
        if (!isMermaid()) {
          sync();
          return;
        }
        if (shown === null) draw();
        else timer = setTimeout(draw, 250);
      };
      code.className = node.attrs.language ? `language-${node.attrs.language}` : '';
      schedule();
      return {
        dom,
        contentDOM: code,
        update(n: Any) {
          if (n.type !== cur.type) return false;
          cur = n;
          code.className = n.attrs.language ? `language-${n.attrs.language}` : '';
          schedule();
          return true;
        },
        stopEvent: (ev: Event) =>
          view.contains(ev.target as globalThis.Node) || bar.contains(ev.target as globalThis.Node),
        // only edits inside the code text are the editor's business; our own class/diagram changes must not re-create the view
        ignoreMutation: (m: Any) => m.type !== 'selection' && !(code.contains(m.target) && m.target !== code),
        destroy() {
          clearTimeout(timer);
        },
      };
    };
  },
});

const FRONT = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/;
/** YAML front matter isn't markdown: keep it aside so it survives the round trip untouched. */
const splitFront = (md: string): [string, string] => {
  const m = FRONT.exec(md);
  return m ? [m[0], md.slice(m[0].length)] : ['', md];
};

interface Button {
  t: string;
  title: string;
  cls?: string;
  link?: boolean;
  run?: (c: Any) => Any;
  on?: (e: Any) => boolean;
}
const BUTTONS: (Button | '|')[] = [
  {
    t: 'H1',
    title: 'Heading 1',
    run: (c: Any) => c.toggleHeading({ level: 1 }),
    on: (e: Any) => e.isActive('heading', { level: 1 }),
  },
  {
    t: 'H2',
    title: 'Heading 2',
    run: (c: Any) => c.toggleHeading({ level: 2 }),
    on: (e: Any) => e.isActive('heading', { level: 2 }),
  },
  {
    t: 'H3',
    title: 'Heading 3',
    run: (c: Any) => c.toggleHeading({ level: 3 }),
    on: (e: Any) => e.isActive('heading', { level: 3 }),
  },
  '|',
  { t: 'B', cls: 'b', title: 'Bold', run: (c: Any) => c.toggleBold(), on: (e: Any) => e.isActive('bold') },
  { t: 'I', cls: 'i', title: 'Italic', run: (c: Any) => c.toggleItalic(), on: (e: Any) => e.isActive('italic') },
  { t: 'S', cls: 's', title: 'Strikethrough', run: (c: Any) => c.toggleStrike(), on: (e: Any) => e.isActive('strike') },
  { t: '</>', cls: 'm', title: 'Inline code', run: (c: Any) => c.toggleCode(), on: (e: Any) => e.isActive('code') },
  { t: 'Link', title: 'Link', link: true, on: (e: Any) => e.isActive('link') },
  '|',
  {
    t: '• List',
    title: 'Bullet list',
    run: (c: Any) => c.toggleBulletList(),
    on: (e: Any) => e.isActive('bulletList'),
  },
  {
    t: '1. List',
    title: 'Numbered list',
    run: (c: Any) => c.toggleOrderedList(),
    on: (e: Any) => e.isActive('orderedList'),
  },
  { t: '☐ Tasks', title: 'Task list', run: (c: Any) => c.toggleTaskList(), on: (e: Any) => e.isActive('taskList') },
  '|',
  { t: '❝', title: 'Quote', run: (c: Any) => c.toggleBlockquote(), on: (e: Any) => e.isActive('blockquote') },
  {
    t: '{ }',
    cls: 'm',
    title: 'Code block',
    run: (c: Any) => c.toggleCodeBlock(),
    on: (e: Any) => e.isActive('codeBlock'),
  },
  {
    t: 'Table',
    title: 'Insert table',
    run: (c: Any) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
    on: (e: Any) => e.isActive('table'),
  },
  { t: '―', title: 'Horizontal rule', run: (c: Any) => c.setHorizontalRule() },
];

/** Raw HTML blocks (<details>, <div align>, comments…) are kept verbatim and shown as source rather than parsed (and lost). */
const HtmlBlock = Node.create({
  name: 'htmlBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  parseHTML: () => [{ tag: 'pre[data-html-block]', preserveWhitespace: 'full' }],
  renderHTML: () => ['pre', { 'data-html-block': '' }, ['code', 0]],
  markdownTokenName: 'html',
  parseMarkdown: (token: Any, h: Any) => {
    const raw = (token.raw || token.text || '').replace(/\s+$/, '');
    return h.createNode('htmlBlock', {}, raw ? [h.createTextNode(raw)] : []);
  },
  renderMarkdown: (node: Any, h: Any) => (node.content ? h.renderChildren(node.content) : ''),
});

/** Shown only while the cursor is inside a table (adding rows and columns happens on the table itself, see tableHandles). */
const TABLE_BUTTONS: Button[] = [
  { t: '− Row', title: 'Delete row', run: (c: Any) => c.deleteRow() },
  { t: '− Col', title: 'Delete column', run: (c: Any) => c.deleteColumn() },
  { t: '− Table', title: 'Delete table', run: (c: Any) => c.deleteTable() },
];

/** "+" handles on the table itself: hovering near the top edge shows one on the nearest column boundary, near the left edge
 *  one on the nearest row boundary (outer edges included, so rows and columns can also go first or last). */
function tableHandles(editor: Any, scroll: HTMLElement) {
  const NEAR = 28; // px outside the table in which a handle shows
  const mk = (cls: string, dir: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `tbl-add ${cls}`;
    b.textContent = '+';
    b.title = dir === 'col' ? 'Add column' : 'Add row';
    b.hidden = true;
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor's selection
    scroll.append(b);
    return b;
  };
  const colBtn = mk('col', 'col');
  const rowBtn = mk('row', 'row');
  let col: Any = null,
    row: Any = null; // { i, cell, after } of the boundary each handle sits on

  const hide = () => {
    colBtn.hidden = rowBtn.hidden = true;
    col = row = null;
  };
  const place = (btn: HTMLElement, x: number, y: number) => {
    const r = scroll.getBoundingClientRect();
    btn.style.left = `${x - r.left + scroll.scrollLeft}px`;
    btn.style.top = `${y - r.top + scroll.scrollTop}px`;
    btn.hidden = false;
  };
  /** nearest of the boundaries given as [coord, cell, after] to p */
  const nearest = (bounds: Any[], p: number): Any =>
    bounds.reduce((best: Any, b: Any) => (Math.abs(b[0] - p) < Math.abs(best[0] - p) ? b : best));

  scroll.addEventListener('mousemove', (e) => {
    const tables = [...scroll.querySelectorAll<HTMLTableElement>('.rich-doc table')];
    const t = tables.find((t) => {
      const r = t.getBoundingClientRect();
      return (
        e.clientX >= r.left - NEAR &&
        e.clientX <= r.right + NEAR &&
        e.clientY >= r.top - NEAR &&
        e.clientY <= r.bottom + NEAR
      );
    });
    if (!t) return hide();
    const r = t.getBoundingClientRect();
    const rows = [...t.rows];
    const cells = [...rows[0].cells];
    const inX = e.clientX >= r.left - NEAR && e.clientX <= r.right + NEAR;
    const inY = e.clientY >= r.top - NEAR && e.clientY <= r.bottom + NEAR;
    // column boundaries: before the first cell, then after each cell
    const cb = [
      [cells[0].getBoundingClientRect().left, cells[0], false],
      ...cells.map((c) => [c.getBoundingClientRect().right, c, true]),
    ];
    const rb = [
      [rows[0].getBoundingClientRect().top, rows[0].cells[0], false],
      ...rows.map((w) => [w.getBoundingClientRect().bottom, w.cells[0], true]),
    ];
    if (inX && e.clientY < r.top + 10) {
      const [x, cell, after] = nearest(cb, e.clientX);
      col = { cell, after };
      place(colBtn, x, r.top);
    } else colBtn.hidden = true;
    if (inY && e.clientX < r.left + 10) {
      const [y, cell, after] = nearest(rb, e.clientY);
      row = { cell, after };
      place(rowBtn, r.left, y);
    } else rowBtn.hidden = true;
  });
  scroll.addEventListener('mouseleave', hide);
  scroll.addEventListener('scroll', hide);

  const add = (target: Any, kind: string) => {
    if (!target) return;
    const pos = editor.view.posAtDOM(target.cell, 0) + 1; // inside the cell's first paragraph
    const c = editor.chain().focus().setTextSelection(pos);
    (kind === 'col'
      ? target.after
        ? c.addColumnAfter()
        : c.addColumnBefore()
      : target.after
        ? c.addRowAfter()
        : c.addRowBefore()
    ).run();
    hide();
  };
  colBtn.addEventListener('click', () => add(col, 'col'));
  rowBtn.addEventListener('click', () => add(row, 'row'));
}

function toolbar(editor: Any) {
  const bar = document.createElement('div');
  bar.className = 'rich-bar';
  const items: [HTMLButtonElement, Button][] = [];
  for (const b of BUTTONS) {
    if (b === '|') {
      const s = document.createElement('span');
      s.className = 'rb-sep';
      bar.append(s);
      continue;
    }
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `rb ${b.cls || ''}`;
    el.textContent = b.t;
    el.title = b.title;
    el.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor's selection
    el.addEventListener('click', () => {
      if (b.link) return linkPrompt();
      b.run?.(editor.chain().focus()).run();
    });
    bar.append(el);
    items.push([el, b]);
  }

  const tableEls: HTMLElement[] = [];
  const sep = document.createElement('span');
  sep.className = 'rb-sep';
  bar.append(sep);
  tableEls.push(sep);
  for (const b of TABLE_BUTTONS) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'rb';
    el.textContent = b.t;
    el.title = b.title;
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', () => {
      b.run?.(editor.chain().focus()).run();
    });
    bar.append(el);
    tableEls.push(el);
  }

  const form = document.createElement('form');
  form.className = 'rb-link';
  form.hidden = true;
  form.innerHTML = '<input spellcheck="false" placeholder="https://…  (empty removes the link)">';
  const input = form.firstChild as HTMLInputElement;
  bar.append(form);
  function linkPrompt() {
    if (!form.hidden) {
      form.hidden = true;
      editor.commands.focus();
      return;
    }
    input.value = editor.getAttributes('link').href || '';
    form.hidden = false;
    input.focus();
    input.select();
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const href = input.value.trim();
    const c = editor.chain().focus().extendMarkRange('link');
    (href ? c.setLink({ href }) : c.unsetLink()).run();
    form.hidden = true;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      form.hidden = true;
      editor.commands.focus();
    }
  });

  const refresh = () => {
    for (const [el, b] of items) el.classList.toggle('on', !!b.on?.(editor));
    const inTable = editor.isActive('table');
    for (const el of tableEls) el.hidden = !inTable;
  };
  editor.on('transaction', refresh);
  refresh();
  return bar;
}

/** Maps blocks of the document (as paths of child indexes) to the source lines of `md` they came from (0-based within the body, after the front matter). */
function lineIndex(editor: Any, md: string) {
  const doc = editor.state.doc;
  const [front, body] = splitFront(md);
  const src = body.split('\n');
  const newlines = (s: string) => (s.replace(/\n+$/, '').match(/\n/g) || []).length;
  const real = (toks: Any[]) => toks.filter((t) => t.type !== 'space' && t.type !== 'checkbox');
  // task items come from Tiptap's own tokenizer: no raw of their own, nested lists in `nestedTokens`
  const rawOf = (t: Any): string =>
    t.type === 'taskItem'
      ? ['x', ...(t.nestedTokens || []).map((n: Any) => n.raw.replace(/\n+$/, ''))].join('\n')
      : t.raw;
  const kids = (t: Any): Any[] | null =>
    t.type === 'list' || t.type === 'taskList'
      ? t.items
      : t.type === 'list_item' || t.type === 'blockquote'
        ? t.tokens
        : t.type === 'taskItem'
          ? [{ type: 'paragraph', raw: 'x' }, ...(t.nestedTokens || [])]
          : null;
  const nonBlank = (l: number) => {
    while (l < src.length - 1 && !src[l].trim()) l++;
    return l;
  };
  /** [first, last] line (0-based, in body) of the block at `path`: at each level the i-th block is the i-th non-blank token.
   *  Token raws can't be trusted to hold their trailing newline (list items don't), so blocks are laid out line by line. */
  const find = (path: number[]) => {
    let toks = real(editor.markdown.instance.lexer(body));
    let start = 0;
    let node = doc,
      res: number[] | null = null;
    for (const i of path) {
      if (i >= toks.length) break;
      let line = nonBlank(start);
      for (const t of toks.slice(0, i)) line = nonBlank(line + newlines(rawOf(t)) + 1);
      const tok = toks[i];
      res = [line, line + newlines(rawOf(tok))];
      node = node.child(i);
      const sub = kids(tok);
      if (!sub || real(sub).length !== node.childCount) break;
      toks = real(sub);
      start = line;
    }
    return res;
  };
  return { find, base: (front.match(/\n/g) || []).length };
}

/** Source lines (1-based, inclusive) that the editor's selection covers in `md`, the markdown the document was parsed from; null if
 *  nothing is selected. Blocks of the document are matched with the markdown lexer's tokens, descending into lists and quotes
 *  while both sides agree on the structure, so selecting two list items gives those two lines rather than the whole list. */
function selectionLines(editor: Any, md: string) {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const doc = editor.state.doc;
  // the first and last block (textblock or leaf) that the selection really covers, as paths of child indexes from the doc
  const leaves: number[][] = [];
  doc.nodesBetween(from, to, (node: Any, pos: number) => {
    if (node.isTextblock ? to > pos + 1 && from < pos + node.nodeSize - 1 : node.isLeaf) {
      const $p = doc.resolve(pos);
      const path: number[] = [];
      for (let d = 0; d <= $p.depth; d++) path.push($p.index(d));
      leaves.push(path);
    }
    return !node.isTextblock;
  });
  if (!leaves.length) return null;

  const { find, base } = lineIndex(editor, md);
  const a = find(leaves[0]),
    b = find(leaves[leaves.length - 1]);
  if (!a || !b) return null;
  return [a[0] + base + 1, b[1] + base + 1];
}

/** Every leaf block of the document with the source lines it covers (1-based) and the position right after it. */
function blockAnchors(editor: Any, md: string) {
  const doc = editor.state.doc;
  const { find, base } = lineIndex(editor, md);
  const out: { first: number; last: number; end: number }[] = [];
  doc.descendants((node: Any, pos: number) => {
    if (!(node.isTextblock || (node.isLeaf && node.isBlock))) return true;
    const $p = doc.resolve(pos);
    const path: number[] = [];
    for (let d = 0; d <= $p.depth; d++) path.push($p.index(d));
    const r = find(path);
    if (r) out.push({ first: r[0] + base + 1, last: r[1] + base + 1, end: pos + node.nodeSize });
    return false;
  });
  return out;
}

/** Widgets (the host's ask boxes) placed after the block holding a source line; ProseMirror maps them through edits. */
const asksKey = new PluginKey('tawnyAsks');
const asksPlugin = new Plugin({
  key: asksKey,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr: Any, set: Any) => tr.getMeta(asksKey) ?? set.map(tr.mapping, tr.doc),
  },
  props: { decorations: (state: Any) => asksKey.getState(state) },
});

/** App-level shortcuts that Tiptap would otherwise claim (cmd+B is bold here, but the app uses it for the sidebar). */
const appKeys = (keys?: Record<string, () => void>) =>
  Extension.create({
    name: 'tawnyKeys',
    priority: 1000,
    addKeyboardShortcuts() {
      return Object.fromEntries(
        Object.entries(keys || {}).map(([k, fn]) => [
          k,
          () => {
            fn();
            return true;
          },
        ]),
      );
    },
  });

function create(
  host: HTMLElement,
  { markdown = '', onChange, onLink, onSelectionMenu, onAskLines, keys, baseDir = '' }: Any = {},
) {
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
  const imgSrc = (src?: string) =>
    !src || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)
      ? src
      : `file://${encodeURI(new URL(src, `file://${dir}/`).pathname)}`;
  const ImageRel = Image.extend({
    renderHTML({ HTMLAttributes }: Any) {
      return ['img', { ...HTMLAttributes, src: imgSrc(HTMLAttributes.src) }];
    },
  });
  // Mod-Alt-1..6 would turn into headings here, but they are the app's worktree-jump keys
  const HeadingNoKeys = Heading.extend({ addKeyboardShortcuts: () => ({}) });
  const out = () => front + editor.getMarkdown().replace(/\n*$/, '\n'); // files end with a newline
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
      Extension.create({ name: 'tawnyAsks', addProseMirrorPlugins: () => [asksPlugin] }),
    ],
    content: markdown,
    contentType: 'markdown',
    onUpdate: () => {
      if (!silent && onChange) onChange(out());
    },
    editorProps: {
      attributes: { spellcheck: 'true' },
      handleClick(_view: Any, _pos: number, ev: MouseEvent) {
        const a = (ev.target as Element).closest?.('a[href]');
        if (a && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          if (onLink) onLink(a.getAttribute('href'));
          return true;
        }
        return false;
      },
    },
  });

  // edits move the ask boxes with their blocks: tell the host which source line each one sits under now
  let askCount = 0;
  let askTimer = 0;
  editor.on('update', () => {
    if (!askCount || !onAskLines) return;
    clearTimeout(askTimer);
    askTimer = window.setTimeout(() => {
      const anchors = blockAnchors(editor, out());
      const found = (asksKey.getState(editor.state) as Any).find() as { from: number; spec: { key: string } }[];
      onAskLines(
        found.flatMap((d) => {
          const at = anchors.find((a) => a.end === d.from);
          return at ? [{ id: d.spec.key, line: at.last }] : [];
        }),
      );
    }, 250);
  });

  // the host sits inside the Monaco editor's DOM, whose own cmd+b (toggle sidebar) would otherwise fire a second time and undo the first
  // (same for cmd+option+o, send to agent, which Monaco binds too)
  wrap.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.altKey ? e.code === 'KeyO' : e.key === 'b')) e.stopPropagation();
  });
  // right-click on a selection: the host offers its own actions (send to agent); without one the native menu stays
  if (onSelectionMenu)
    wrap.addEventListener('contextmenu', (e) => {
      if (editor.state.selection.empty || !el.contains(e.target as globalThis.Node)) return;
      e.preventDefault();
      onSelectionMenu(e.clientX, e.clientY);
    });
  wrap.append(toolbar(editor), scroll);
  tableHandles(editor, scroll);
  host.append(wrap);

  return {
    el: wrap,
    getMarkdown: out,
    setBaseDir(d: string) {
      dir = d;
    },
    /** Replace the document without reporting a change (the caller is the source of this text). */
    setMarkdown(md: string, { reset = false } = {}) {
      silent = true;
      [front, md] = splitFront(md);
      try {
        editor.commands.setContent(md, { contentType: 'markdown', emitUpdate: false });
        if (reset) {
          editor.commands.setTextSelection(1);
          scroll.scrollTop = 0;
        }
      } finally {
        silent = false;
      }
    },
    /** [first, last] source line of the selection in `md` (what the document was last loaded from or written as), or null */
    selectionLines: (md: string) => selectionLines(editor, md),
    /** Put each ask box's element (`dom`) right after the block holding its source line `line` in `md`; ones not listed go. */
    setAsks(items: { id: string; dom: HTMLElement; line: number }[], md: string) {
      askCount = items.length;
      const anchors = blockAnchors(editor, md);
      const decos = items.flatMap(({ id, dom, line }) => {
        const at = anchors.find((a) => a.last >= line) ?? anchors[anchors.length - 1];
        return at
          ? [Decoration.widget(at.end, () => dom, { key: id, side: 1, stopEvent: () => true, ignoreSelection: true })]
          : [];
      });
      editor.view.dispatch(
        editor.state.tr.setMeta(asksKey, DecorationSet.create(editor.state.doc, decos)).setMeta('addToHistory', false),
      );
    },
    focus: () => editor.commands.focus(),
    hasFocus: () => editor.isFocused,
    destroy() {
      editor.destroy();
      wrap.remove();
    },
  };
}

(window as Any).tawnyRich = { create };
