// The one card for every comment/ask box and PR-tab comment: a header (icon, title, mono location, badges, count, x), a body
// and a footer (target chip first, then tools; Save and the primary button on the right).
// Compose mode (default): the body is a small markdown editor (Tiptap, like the rich view: ``` makes a highlighted code
// block, enter is a newline). Keys: cmd+enter submits, escape discards, shift+tab cycles the target (if any).
// Read mode (`body` given): the body is rendered content (markdown, stacked comments) and `footer` replaces the footer.
// The x always means "get rid of this card" (discard, delete, dismiss). The owner decides what the buttons do and keeps
// the draft; this component only draws and routes keys.
import { Editor } from '@tiptap/core';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { ChevronRightIcon } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader } from '@/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';

const lowlight = createLowlight(common);
export const mdOf = (e: Editor) => e.getMarkdown().trim();

/** Header title: icon, action title, mono location (muted), then badges. */
export function CardTitle({
  icon,
  title,
  loc,
  onLoc,
  locTitle,
  badges,
}: {
  icon?: ReactNode;
  title: ReactNode;
  loc?: string;
  /** makes the location a link */
  onLoc?: () => void;
  locTitle?: string;
  badges?: ReactNode;
}) {
  return (
    <>
      {icon && <span className="text-muted-foreground flex-none [&>svg]:size-3.5">{icon}</span>}
      <span className="flex-none">{title}</span>
      {loc &&
        (onLoc ? (
          <button
            type="button"
            title={locTitle}
            className="text-muted-foreground min-w-0 cursor-pointer truncate font-mono font-normal underline-offset-2 hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onLoc();
            }}
          >
            {loc}
          </button>
        ) : (
          <span title={locTitle} className="text-muted-foreground min-w-0 truncate font-mono font-normal">
            {loc}
          </span>
        ))}
      {badges}
    </>
  );
}

/** Footer target chip: the ask box's agent picker (`onClick`, caret) or a static label such as "Pending review". */
export function TargetChip({
  children,
  dot,
  caret,
  onClick,
  title,
}: {
  children: ReactNode;
  /** status dot: idle / working / waiting */
  dot?: 'idle' | 'work' | 'wait';
  caret?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const cls = 'h-auto max-w-full min-w-0 gap-1.5 bg-accent px-2 py-0.5 text-[11.5px] font-normal text-muted-foreground';
  const inner = (
    <>
      {dot && <i className={`sdot${dot === 'wait' ? ' wait' : dot === 'work' ? ' work' : ''}`} />}
      <span className="truncate">{children}</span>
      {caret && <b className="text-[9px] font-normal">▾</b>}
    </>
  );
  if (!onClick)
    return (
      <Button asChild variant="ghost" size="xs" className={`${cls} pointer-events-none`}>
        <span title={title}>{inner}</span>
      </Button>
    );
  return (
    <Button variant="ghost" size="xs" className={cls} title={title} onClick={onClick}>
      {inner}
    </Button>
  );
}

export interface ComposeCardProps {
  /** header content after the chevron: a CardTitle */
  title: ReactNode;
  /** header, right before the x: comment count */
  count?: ReactNode;
  /** read mode: rendered content instead of the editor (the compose-only props below are then unused) */
  body?: ReactNode;
  /** read mode: the whole footer row (chip left, buttons right) */
  footer?: ReactNode;
  /** controlled collapse; omit for a card that is always open (no chevron) */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** one-line text shown in the header while collapsed */
  summary?: string;
  /** the x; omit for a card that can't be discarded */
  onClose?: () => void;
  closeTitle?: string;
  /** header hover (the owner lights the selected code) */
  onHover?: (on: boolean) => void;
  /** markdown the editor starts with each time it opens */
  initial?: string;
  onChange?: (md: string) => void;
  placeholder?: () => string;
  /** focus the editor (at the end) when it opens */
  autoFocus?: boolean;
  /** the live editor, for the owner (focus, setContent, getMarkdown) */
  editorRef?: RefObject<Editor | null>;
  /** the card element, for measuring and data attributes */
  cardRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  boxId?: string;
  /** footer, left: target chip, toggles */
  tools?: ReactNode;
  /** between the editor and the footer (a suggestion editor) */
  extra?: ReactNode;
  submitLabel?: string;
  canSubmit?: boolean;
  onSubmit?: () => void;
  onDiscard?: () => void;
  /** shift+tab */
  onCycle?: () => void;
}

export function ComposeCard(p: ComposeCardProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const domRef = useRef<HTMLDivElement>(null);
  const cur = useRef(p);
  cur.current = p;
  const collapsible = p.open !== undefined;
  const isOpen = p.open ?? true;

  // the markdown editor lives while the card is expanded
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !isOpen) return;
    const e = new Editor({
      element: host,
      extensions: [
        StarterKit.configure({ codeBlock: false, heading: false, link: { openOnClick: false, autolink: true } }),
        CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
        Markdown,
        Placeholder.configure({ placeholder: () => cur.current.placeholder?.() ?? '' }),
      ],
      content: cur.current.initial ?? '',
      contentType: 'markdown',
      onUpdate: ({ editor }) => cur.current.onChange?.(mdOf(editor)),
      editorProps: { attributes: { spellcheck: 'false' } },
    });
    if (cur.current.editorRef) cur.current.editorRef.current = e;
    if (cur.current.autoFocus) e.commands.focus('end');
    return () => {
      if (cur.current.editorRef) cur.current.editorRef.current = null;
      e.destroy();
    };
  }, [isOpen]);

  // native listeners: Monaco's own handlers sit above this node and must not see these events
  useEffect(() => {
    const d = domRef.current;
    const host = hostRef.current;
    if (!d || !host) return;
    const onDown = (e: MouseEvent) => {
      e.stopPropagation(); // Monaco's pointer handling would pull focus back into the editor
      const t = e.target as HTMLElement;
      if (!host.contains(t) && !t.closest('button, textarea, input')) e.preventDefault(); // keep focus where it is
    };
    const stop = (e: Event) => e.stopPropagation();
    // capture: our keys win over the editor's own (shift+tab would lift a list item)
    const onKeyCapture = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (cur.current.canSubmit !== false) cur.current.onSubmit?.();
      } else if (e.key === 'Tab' && e.shiftKey && cur.current.onCycle) {
        e.preventDefault();
        e.stopPropagation();
        cur.current.onCycle();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cur.current.onDiscard?.();
      }
    };
    d.addEventListener('mousedown', onDown);
    d.addEventListener('pointerdown', stop);
    host.addEventListener('keydown', onKeyCapture, true);
    host.addEventListener('keydown', stop);
    return () => {
      d.removeEventListener('mousedown', onDown);
      d.removeEventListener('pointerdown', stop);
      host.removeEventListener('keydown', onKeyCapture, true);
      host.removeEventListener('keydown', stop);
    };
  }, [isOpen]);

  const header = (
    <CardHeader
      className={`flex flex-row items-center gap-2 py-1 pr-1.5 pl-3 ${collapsible ? 'cursor-pointer' : ''}`}
      onMouseEnter={() => p.onHover?.(true)}
      onMouseLeave={() => p.onHover?.(false)}
    >
      {collapsible && (
        <ChevronRightIcon className={`size-3.5 flex-none transition-transform ${isOpen ? 'rotate-90' : ''}`} />
      )}
      <span className="flex min-w-0 flex-none items-center gap-2 text-xs font-medium">{p.title}</span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{isOpen ? '' : p.summary}</span>
      {p.count != null && <span className="text-muted-foreground flex-none text-xs">{p.count}</span>}
      {p.onClose ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground flex-none text-xs"
          title={p.closeTitle}
          aria-label={p.closeTitle ?? 'Close'}
          onClick={(e) => {
            e.stopPropagation();
            p.onHover?.(false);
            p.onClose?.();
          }}
        >
          ✕
        </Button>
      ) : (
        <span className="h-6" />
      )}
    </CardHeader>
  );

  return (
    <Collapsible open={isOpen} onOpenChange={p.onOpenChange}>
      <Card
        className={`rich-ask gap-0 py-0 ${p.className ?? ''}`}
        ref={(el) => {
          domRef.current = el;
          if (p.cardRef) p.cardRef.current = el;
        }}
        data-box={p.boxId}
      >
        {collapsible ? <CollapsibleTrigger asChild>{header}</CollapsibleTrigger> : header}
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-2 px-3.5 pt-0.5 pb-2.5">
            {p.body !== undefined ? (
              <div className="text-[14px] leading-[1.5]">{p.body}</div>
            ) : (
              <div className="ask-md rich-doc" data-compose-card ref={hostRef} />
            )}
            {p.extra}
            {p.footer !== undefined ? (
              p.footer && <div className="ask-foot">{p.footer}</div>
            ) : (
              <div className="ask-foot">
                {p.tools}
                <Button
                  size="xs"
                  className="ml-auto flex-none"
                  title={`${p.submitLabel} (cmd+enter)`}
                  disabled={p.canSubmit === false}
                  onClick={p.onSubmit}
                >
                  {p.submitLabel}
                </Button>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
