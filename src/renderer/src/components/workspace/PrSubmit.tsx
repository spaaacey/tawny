// Submit the pending review: verdict + optional summary in a dialog. Every draft stays its own inline comment.
import { SendIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader } from '@/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';
import type { PrVerdict } from '../../../../shared/types';
import { usePrGeneral } from '../../lib/prAsk';
import { H } from '../../lib/tawny';
import { prSnapshotChanged } from '../editor/prBus';
import { Md } from './prParts';

const VERDICTS: { value: PrVerdict; label: string }[] = [
  { value: 'COMMENT', label: 'Comment' },
  { value: 'APPROVE', label: 'Approve' },
  { value: 'REQUEST_CHANGES', label: 'Request changes' },
];

const NONE: never[] = [];

/** General comment drafts (comments on files outside the PR diff), posted as conversation comments on submit. */
export function GeneralDrafts({ dir }: { dir: string }) {
  const list = usePrGeneral((s) => s.by[dir]) ?? NONE;
  if (!list.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-medium">General comments ({list.length}), posted on submit</h3>
      {list.map((d) => (
        <Card key={d.id} className="gap-0 py-0">
          <CardHeader className="flex flex-row items-center px-3 py-1.5">
            <span className="flex-1 font-mono text-xs">
              {d.path}:{d.a}
              {d.b > d.a ? `-${d.b}` : ''}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Delete draft"
              onClick={() => usePrGeneral.getState().remove(dir, d.id)}
            >
              <Trash2Icon />
            </Button>
          </CardHeader>
          <CardContent className="border-t px-3 py-3">
            <Md text={d.body} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function SubmitReview({ dir, drafts }: { dir: string; drafts: number }) {
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<PrVerdict>('COMMENT');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // GitHub rejects a Comment / Request changes review with neither a summary nor inline comments
  const general = usePrGeneral((s) => s.by[dir]) ?? NONE;
  const empty = verdict !== 'APPROVE' && !drafts && !body.trim() && !general.length;
  // general drafts alone are posted as conversation comments, without a review
  const reviewless = verdict === 'COMMENT' && !drafts && !body.trim();
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      for (const d of general) {
        prSnapshotChanged(dir, await H.prComment(dir, d.body));
        usePrGeneral.getState().remove(dir, d.id);
      }
      if (!(reviewless && general.length)) prSnapshotChanged(dir, await H.prSubmit(dir, verdict, body));
      setOpen(false);
      setBody('');
      setVerdict('COMMENT');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <SendIcon />
        Submit review
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit review</DialogTitle>
            <DialogDescription>
              Publishes the review on GitHub with {drafts} inline comment{drafts === 1 ? '' : 's'}
              {general.length ? ` and ${general.length} general comment${general.length === 1 ? '' : 's'}` : ''}.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>Verdict</FieldLabel>
              <Select value={verdict} onValueChange={(v) => setVerdict(v as PrVerdict)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VERDICTS.map((v) => (
                    <SelectItem key={v.value} value={v.value}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Summary</FieldLabel>
              <Textarea
                value={body}
                rows={5}
                placeholder="Optional summary of the review"
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
              {empty && (
                <FieldDescription>
                  Add a summary (or pending comments) to {verdict === 'COMMENT' ? 'comment' : 'request changes'}.
                </FieldDescription>
              )}
              {err && <FieldDescription className="text-destructive">{err}</FieldDescription>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || empty} onClick={submit}>
              {busy ? <Spinner /> : <SendIcon />}
              Submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
