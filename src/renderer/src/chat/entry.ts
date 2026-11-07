import DOMPurify from 'dompurify';
import { common, createLowlight } from 'lowlight';
// Entry for the chat markdown bundle (marked + DOMPurify + lowlight).
// window.tawnyChatMd.render(markdown) → sanitized HTML (code blocks carry hljs-* classes, styled from the theme tokens)
import { Marked } from 'marked';
import { render as renderMermaid } from 'pele';

const lowlight = createLowlight(common);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** lowlight's hast tree → HTML */
// biome-ignore lint/suspicious/noExplicitAny: hast node
function toHtml(node: any): string {
  if (node.type === 'text') return esc(node.value);
  const inner = (node.children || []).map(toHtml).join('');
  if (node.type !== 'element') return inner;
  const cls = node.properties?.className;
  return `<${node.tagName}${cls ? ` class="${esc(cls.join(' '))}"` : ''}>${inner}</${node.tagName}>`;
}

const MODES: [string, string][] = [
  ['diagram', 'Diagram'],
  ['code', 'Code'],
  ['both', 'Both'],
];

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const l = (lang || '').trim().split(/\s/)[0];
      let body: string;
      try {
        body = l && lowlight.registered(l) ? toHtml(lowlight.highlight(l, text)) : esc(text);
      } catch {
        body = esc(text);
      }
      const pre = `<pre class="chat-code"><code>${body}</code></pre>`;
      if (l !== 'mermaid') return pre;
      // diagram by default (toggle Diagram/Code/Both); plain code while it doesn't parse (e.g. mid-stream)
      let svg: string;
      try {
        svg = renderMermaid(text).svg;
      } catch {
        return pre;
      }
      const btns =
        `<button type="button" data-expand title="Expand">⤢</button>` +
        MODES.map(([m, label]) => `<button type="button" data-mode="${m}">${label}</button>`).join('');
      return `<div class="chat-mermaid" data-mode="diagram"><div class="mermaid-modes">${btns}</div><div class="mermaid-view">${svg}</div>${pre}</div>`;
    },
  },
});

window.tawnyChatMd = {
  render: (text: string) =>
    DOMPurify.sanitize(marked.parse(text || '') as string, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
    }),
};

document.addEventListener('click', (e) => {
  const el = e.target as Element | null;
  const view = el?.closest?.('.chat-mermaid .mermaid-view');
  const exp = el?.closest?.('.chat-mermaid .mermaid-modes button[data-expand]');
  if (exp || (view && !window.getSelection()?.toString())) {
    const svg = (exp ? exp.closest('.chat-mermaid') : view)?.querySelector('.mermaid-view svg');
    if (svg) window.dispatchEvent(new CustomEvent('tawny:mermaid-expand', { detail: svg.outerHTML }));
    return;
  }
  const b = (e.target as Element | null)?.closest?.('.chat-mermaid .mermaid-modes button[data-mode]');
  const wrap = b?.closest('.chat-mermaid');
  if (b && wrap) wrap.setAttribute('data-mode', b.getAttribute('data-mode') || 'diagram');
});
