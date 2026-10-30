import { CheckIcon } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { FormAnswer, FormQuestion } from '../../../../shared/chat-model';
import { Button } from '../ui/button';
import type { ChatController } from './controller';
import type { PermRequest } from './types';

/** Single-select questions start on their option marked "(Recommended)". */
function recommended(qs: FormQuestion[]) {
  const p: Record<string, string[]> = {};
  for (const q of qs) {
    const o = q.multi ? undefined : q.options.find((o) => /\(recommended\)/i.test(o.label));
    if (o) p[q.key] = [o.value];
  }
  return p;
}

/** AskUserQuestion: each question lists numbered options plus a free-text "Other" box. */
export function QuestionCard({ r, ctl }: { r: PermRequest; ctl: ChatController }) {
  const qs = r.form?.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>(() => recommended(qs));
  const [custom, setCustom] = useState<Record<string, string>>({});
  const instant = qs.length === 1 && !qs[0].multi; // a lone single-select answers on click

  const submit = (p: Record<string, string[]>, c: Record<string, string>) => {
    const a: FormAnswer = {};
    for (const q of qs) {
      const v = p[q.key] ?? [];
      if (v.length) a[q.key] = q.multi ? v : v[0];
      const text = c[q.key]?.trim();
      if (text) a[`${q.key}_custom`] = text;
    }
    ctl.answer(r.reqId, a);
  };
  const pick = (key: string, multi: boolean, value: string) => {
    const cur = picked[key] ?? [];
    const next = multi ? (cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]) : [value];
    const p = { ...picked, [key]: next };
    if (instant) submit(p, custom);
    else setPicked(p);
  };
  const ready = qs.some((q) => picked[q.key]?.length || custom[q.key]?.trim());

  return (
    <div className="ask">
      {qs.map((q) => (
        <div key={q.key} className="ask-q">
          {q.header ? <span className="ask-head">{q.header}</span> : null}
          <div className="ask-text">{q.question}</div>
          <div className="ask-opts">
            {q.options.map((o, i) => {
              const on = picked[q.key]?.includes(o.value);
              return (
                <Fragment key={o.value}>
                  <button
                    type="button"
                    className={`ask-opt${on ? ' on' : ''}`}
                    onClick={() => pick(q.key, q.multi, o.value)}
                  >
                    <kbd>{q.multi ? on ? <CheckIcon /> : '' : i + 1}</kbd>
                    <span className="ask-label">{o.label}</span>
                    {o.description ? <span className="ask-desc">{o.description}</span> : null}
                  </button>
                  {on && o.preview ? <pre className="ask-preview">{o.preview}</pre> : null}
                </Fragment>
              );
            })}
            <input
              className="ask-other"
              placeholder={q.multi ? 'Add your own answer…' : 'Other — type your own answer…'}
              value={custom[q.key] ?? ''}
              onChange={(e) => {
                setCustom({ ...custom, [q.key]: e.target.value });
                // typed text is the answer of a single-select, not a note on the preselected option
                if (!q.multi && e.target.value) setPicked({ ...picked, [q.key]: [] });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && (instant || ready)) {
                  e.preventDefault();
                  submit(picked, custom);
                } else if (e.key === 'Escape') ctl.answer(r.reqId, null);
              }}
            />
          </div>
        </div>
      ))}
      <div className="ask-foot">
        <Button size="sm" disabled={!ready} onClick={() => submit(picked, custom)}>
          Submit
        </Button>
        <Button size="sm" variant="secondary" onClick={() => ctl.answer(r.reqId, {})}>
          Skip
        </Button>
      </div>
    </div>
  );
}
