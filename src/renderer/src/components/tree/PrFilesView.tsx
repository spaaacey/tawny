// "PR files" tree view of a PR review session: files changed against the merge-base, with local "viewed" checkboxes.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Badge } from '@/ui/badge';
import { Checkbox } from '@/ui/checkbox';
import { ScrollArea } from '@/ui/scroll-area';
import type { PrFiles, PrSnapshot } from '../../../../shared/types';
import { iconSrc } from '../../lib/fileicons';
import { H } from '../../lib/tawny';
import { useStore } from '../../store';
import { openDiff } from '../editor/api';
import { onPrSnapshot } from '../editor/prThreads';
import { activeKey } from '../workspace/layoutStore';
import { baseName, useTree } from './store';

/** worktree path -> viewed file paths; persisted in the UI state */
const useViewed = create<{ by: Record<string, string[]> }>(() => ({
  by: (useStore.getState().app.ui.prViewed as Record<string, string[]>) || {},
}));
function setViewed(dir: string, path: string, on: boolean) {
  const cur = useViewed.getState().by[dir] || [];
  const next = on ? [...new Set([...cur, path])] : cur.filter((p) => p !== path);
  const by = { ...useViewed.getState().by, [dir]: next };
  useViewed.setState({ by });
  H.saveUi({ prViewed: by });
}

export function PrFilesView({ dir }: { dir: string }) {
  const [files, setFiles] = useState<PrFiles | null>(null);
  const [snap, setSnap] = useState<PrSnapshot | null>(null);
  const [err, setErr] = useState('');
  const viewed = useViewed((s) => s.by[dir]);
  useTree((s) => s.tick);

  useEffect(() => {
    let live = true;
    const load = () => {
      H.prFiles(dir)
        .then((f) => {
          if (!live) return;
          setFiles(f);
          setErr('');
        })
        .catch((e) => live && setErr((e as Error).message));
      H.prFetch(dir)
        .then((s) => live && setSnap(s))
        .catch(() => {});
    };
    setFiles(null);
    load();
    const off = onPrSnapshot((r) => r === dir && load());
    return () => {
      live = false;
      off();
    };
  }, [dir]);

  if (err) return <div className="tree-empty">{err}</div>;
  if (!files) return <div className="tree-empty">Loading…</div>;
  const seen = new Set(viewed);
  const count = (p: string) => snap?.threads.filter((t) => t.path === p).length ?? 0;
  const active = activeKey();
  return (
    <ScrollArea className="flex-1 min-h-0">
      <div id="changes">
        <div className="cn-head">
          PR files
          <span className="cn-stat" title="Files marked viewed">
            {files.files.filter((f) => seen.has(f.path)).length}/{files.files.length} viewed
          </span>
          <span className="cn-n">{files.files.length}</span>
        </div>
        {files.files.map((f) => {
          const abs = `${dir}/${f.path}`;
          const name = baseName(f.path);
          const i = f.path.lastIndexOf('/');
          const n = count(f.path);
          const open = () => openDiff('r', `${files.base}:${abs}`, { preview: true });
          return (
            <div
              key={f.path}
              className={`cn s${f.status}${active === `d:r:${files.base}:${abs}` ? ' on' : ''}`}
              title={f.orig ? `${f.orig} → ${f.path}` : f.path}
              onClick={open}
              onDoubleClick={() => openDiff('r', `${files.base}:${abs}`, { pin: true })}
            >
              <Checkbox
                checked={seen.has(f.path)}
                onClick={(e) => e.stopPropagation()}
                onCheckedChange={(c) => setViewed(dir, f.path, c === true)}
                aria-label={`Mark ${f.path} as viewed`}
              />
              <img className="ti" src={iconSrc(name, 'file')} draggable={false} alt="" />
              <span className={`cn-name${seen.has(f.path) ? ' opacity-50' : ''}`}>{name}</span>
              <span className="cn-dir">{i > 0 ? f.path.slice(0, i) : ''}</span>
              {n > 0 && (
                <Badge variant="outline" title={`${n} review thread${n > 1 ? 's' : ''}`}>
                  {n}
                </Badge>
              )}
              <span className="tg" onDoubleClick={(e) => e.stopPropagation()}>
                {f.status}
              </span>
            </div>
          );
        })}
        {!files.files.length && <div className="tree-empty">No changes against the base branch</div>}
      </div>
    </ScrollArea>
  );
}
