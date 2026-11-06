// Submit the pending review: verdict + optional summary in a dialog. Every draft stays its own inline comment.
import { SendIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';
import type { PrVerdict } from '../../../../shared/types';
import { H } from '../../lib/tawny';
import { prSnapshotChanged } from '../editor/prBus';

const VERDICTS: { value: PrVerdict; label: string }[] = [
  { value: 'COMMENT', label: 'Comment' },
  { value: 'APPROVE', label: 'Approve' },
  { value: 'REQUEST_CHANGES', label: 'Request changes' },
];

export function SubmitReview({ dir, drafts }: { dir: string; drafts: number }) {
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<PrVerdict>('COMMENT');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // GitHub rejects a Comment / Request changes review with neither a summary nor inline comments
  const empty = verdict !== 'APPROVE' && !drafts && !body.trim();
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      prSnapshotChanged(dir, await H.prSubmit(dir, verdict, body));
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
              Publishes the review on GitHub with {drafts} inline comment{drafts === 1 ? '' : 's'}.
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
