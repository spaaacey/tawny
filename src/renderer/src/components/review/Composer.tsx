// The gutter comment composer of review diffs (new comment on a line range, optional suggestion with a mini diff),
// plus `Sized` (view zones follow their React content). The review source decides what submitting does
// (PR: a draft in the GitHub pending review; local review: a `user` item).
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader } from '@/ui/card';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';

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
  submitLabel = 'Add to review',
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
  submitLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const id = useId();
  // the owner keeps the draft (it survives zone redraws); `state` is only the initial value
  const [cur, setCur] = useState(state);
  const set = (p: Partial<ComposerState>) => {
    const next = { ...cur, ...p };
    setCur(next);
    onState(next);
  };
  const canSuggest = side === 'RIGHT';
  const suggest = canSuggest && cur.suggest;
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
      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-row items-center gap-2 px-3 py-1.5">
          <span className="text-xs font-medium">
            Comment on {startLine < line ? `lines ${startLine}-${line}` : `line ${line}`}
          </span>
          <Badge variant="outline">{side === 'LEFT' ? 'Original' : 'Modified'}</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 border-t px-3 py-2">
          <Textarea
            autoFocus
            rows={3}
            placeholder={placeholder}
            value={cur.body}
            onChange={(e) => {
              set({ body: e.target.value });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancel();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) void submit();
            }}
          />
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
          {suggest && (
            <>
              <Textarea
                rows={Math.max(2, cur.suggestion.split('\n').length)}
                className="font-mono text-xs"
                value={cur.suggestion}
                onChange={(e) => set({ suggestion: e.target.value })}
              />
              <SuggestionDiff old={oldText} text={cur.suggestion} />
            </>
          )}
          <div className="flex gap-2">
            <Button size="xs" disabled={busy || (!cur.body.trim() && !suggest)} onClick={submit}>
              {submitLabel}
            </Button>
            <Button size="xs" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </Sized>
  );
}
