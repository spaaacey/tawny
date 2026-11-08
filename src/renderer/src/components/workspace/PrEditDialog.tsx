// Edit the PR's title, base branch and description (only offered to the PR's author).
import { PencilIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';
import type { PrSnapshot } from '../../../../shared/types';
import { H } from '../../lib/tawny';
import { prSnapshotChanged } from '../editor/prBus';

export function EditPr({ dir, snap }: { dir: string; snap: PrSnapshot }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [base, setBase] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const show = () => {
    setTitle(snap.title);
    setBase(snap.baseRef);
    setBody(snap.body);
    setErr('');
    setOpen(true);
  };
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      prSnapshotChanged(dir, await H.prEdit(dir, { title, body, base }));
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="ghost" onClick={show}>
        <PencilIcon />
        Edit
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit pull request</DialogTitle>
            <DialogDescription>Updates the title, base branch and description on GitHub.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>Title</FieldLabel>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            </Field>
            <Field>
              <FieldLabel>Base branch</FieldLabel>
              <Input value={base} onChange={(e) => setBase(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <FieldDescription>Merging {snap.headRef} into this branch.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Textarea
                value={body}
                rows={10}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
              {err && <FieldDescription className="text-destructive">{err}</FieldDescription>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !title.trim() || !base.trim()} onClick={save}>
              {busy ? <Spinner /> : <PencilIcon />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
