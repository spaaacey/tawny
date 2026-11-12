// The gutter comment composer of review diffs (new comment on a line range, optional suggestion with a mini diff): the
// shared ComposeCard (also the editor's ask box) plus a suggestion editor; plus `Sized` (view zones follow their React content). The review source decides what submitting does
// (PR: a draft in the GitHub pending review; local review: a `user` item).
import type { Editor } from '@tiptap/core';
import { MessageSquareIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { CardTitle, ComposeCard, TargetChip } from './ComposeCard';

export type Side = 'LEFT' | 'RIGHT';

/** Calls `onSize` whenever its content resizes (view zones follow their React content). */
export function Sized({ onSize, children }: { onSize?: () => void; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || !onSize) return;
    const ro = new ResizeObserver(onSize);
    ro.observe(el.current);
    return () => ro.disconnect();
  }, [onSize]);
  return <div ref={el}>{children}</div>;
}

/** Selected lines struck out above the replacement, as GitHub renders a suggestion. */
export function SuggestionDiff({ old, text }: { old: string; text: string }) {
  const rows = (t: string) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
  return (
    <div className="overflow-x-auto rounded border font-mono text-xs leading-5">
      {rows(old).map((l, i) => (
        <div key={`o${i}`} className="whitespace-pre bg-red-500/10 px-2">
          <span className="select-none text-red-600">- </span>
          {l}
        </div>
      ))}
      {rows(text).map((l, i) => (
        <div key={`n${i}`} className="whitespace-pre bg-emerald-500/10 px-2">
          <span className="select-none text-emerald-600">+ </span>
          {l}
        </div>
      ))}
    </div>
  );
}

export interface ComposerState {
  body: string;
  suggest: boolean;
  suggestion: string;
}
export const emptyComposer = (): ComposerState => ({ body: '', suggest: false, suggestion: '' });

/** What the composer submits. `startLine` only for ranges; `suggestion` only when "Suggest a change" is on (RIGHT side). */
export interface ComposerSubmit {
  path: string;
  side: Side;
  line: number;
  startLine?: number;
  body: string;
  suggestion?: string;
}

/** New comment on `path` lines `startLine`..`line` of `side`. Suggestions only on RIGHT. Resolve `onSubmit` true to close. */
export function Composer({
  path,
  side,
  startLine,
  line,
  oldText,
  state,
  onState,
  onSubmit,
  onCancel,
  onDone,
  onSize,
  placeholder,
  target = 'Pending review',
}: {
  path: string;
  side: Side;
  startLine: number;
  line: number;
  /** text of the selected lines (the suggestion's starting point) */
  oldText: string;
  state: ComposerState;
  onState: (s: ComposerState) => void;
  onSubmit: (c: ComposerSubmit) => Promise<boolean>;
  onCancel: () => void;
  onDone: () => void;
  onSize: () => void;
  placeholder?: string;
  /** footer chip: where the comment goes */
  target?: string;
}) {
  const [busy, setBusy] = useState(false);
  const id = useId();
  const edRef = useRef<Editor | null>(null);
  // the owner keeps the draft (it survives zone redraws); `state` is only the initial value
  const [cur, setCur] = useState(state);
  const set = (p: Partial<ComposerState>) => {
    const next = { ...cur, ...p };
    setCur(next);
    onState(next);
  };
  const canSuggest = side === 'RIGHT';
  const suggest = canSuggest && cur.suggest;
  const canSubmit = !busy && (!!cur.body.trim() || suggest);
  const submit = async () => {
    setBusy(true);
    const ok = await onSubmit({
      path,
      line,
      startLine: startLine < line ? startLine : undefined,
      side,
      body: cur.body,
      suggestion: suggest ? cur.suggestion : undefined,
    });
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <Sized onSize={onSize}>
      <ComposeCard
        className="compose-flow"
        editorRef={edRef}
        title={
          <CardTitle
            icon={<MessageSquareIcon />}
            title="Comment"
            loc={`${path}:${startLine < line ? `${startLine}-${line}` : line}`}
            badges={<Badge variant="outline">{side === 'LEFT' ? 'Original' : 'Modified'}</Badge>}
          />
        }
        onClose={onCancel}
        closeTitle="Cancel (esc)"
        initial={cur.body}
        onChange={(body) => set({ body })}
        placeholder={() => placeholder ?? 'Leave a comment…'}
        autoFocus
        tools={
          <>
            <TargetChip>{target}</TargetChip>
            <div
              className="flex items-center gap-2"
              title={canSuggest ? undefined : 'Suggestions only work on the modified side'}
            >
              <Checkbox
                id={id}
                disabled={!canSuggest}
                checked={suggest}
                onCheckedChange={(c) => set({ suggest: c === true, suggestion: cur.suggestion || oldText })}
              />
              <Label htmlFor={id} className={canSuggest ? '' : 'opacity-50'}>
                Suggest a change
              </Label>
            </div>
          </>
        }
        extra={
          suggest && (
            <>
              <Textarea
                rows={Math.max(2, cur.suggestion.split('\n').length)}
                className="sugg font-mono text-xs"
                value={cur.suggestion}
                onChange={(e) => set({ suggestion: e.target.value })}
              />
              <SuggestionDiff old={oldText} text={cur.suggestion} />
            </>
          )
        }
        submitLabel="Comment"
        canSubmit={canSubmit}
        onSubmit={() => void submit()}
        onDiscard={onCancel}
      />
    </Sized>
  );
}
