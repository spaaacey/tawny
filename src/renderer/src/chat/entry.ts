import DOMPurify from 'dompurify';
import { common, createLowlight } from 'lowlight';
// Entry for the chat markdown bundle (marked + DOMPurify + lowlight).
// window.tawnyChatMd.render(markdown) → sanitized HTML (code blocks carry hljs-* classes, styled from the theme tokens)
import { Marked } from 'marked';

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
      return `<pre class="chat-code"><code>${body}</code></pre>`;
    },
  },
});

window.tawnyChatMd = {
  render: (text: string) => DOMPurify.sanitize(marked.parse(text || '') as string, { USE_PROFILES: { html: true } }),
};
