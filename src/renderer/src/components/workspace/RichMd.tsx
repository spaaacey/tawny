// Inline rich markdown editor (the Tiptap bundle behind the markdown file view) as a controlled-on-mount field.
import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    tawnyRich: {
      // biome-ignore lint/suspicious/noExplicitAny: Tiptap bundle options
      create(host: HTMLElement, opts: any): { focus(): void; destroy(): void };
    };
  }
}

/** `value` seeds the editor on mount only; edits are reported through `onChange` as markdown. */
export function RichMd({
  value,
  onChange,
  label,
  autoFocus = false,
}: {
  value: string;
  onChange: (md: string) => void;
  label: string;
  autoFocus?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const view = window.tawnyRich.create(el, { markdown: value, onChange: (md: string) => cb.current(md) });
    const pm = el.querySelector('.ProseMirror');
    pm?.setAttribute('aria-label', label);
    pm?.setAttribute('aria-multiline', 'true');
    pm?.setAttribute('role', 'textbox');
    if (autoFocus) view.focus();
    return () => view.destroy();
  }, []);
  return <div ref={host} className="rich-inline" />;
}
