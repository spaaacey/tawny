// PR files: full-PR and historical commit diffs, with saved per-file and per-commit review progress.
import { FileTextIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { ItemGroup } from '@/ui/item';
import { ScrollArea } from '@/ui/scroll-area';
import type { PrCommit, PrFiles, PrSnapshot } from '../../../../shared/types';
import { iconSrc } from '../../lib/fileicons';
import { H } from '../../lib/tawny';
import { useStore } from '../../store';
import { openDiff } from '../editor/api';
import { onPrSnapshot } from '../editor/prBus';
import { Chevron } from '../icons';
import { activeKey, revealKey, seedPrTab } from '../workspace/layoutStore';
import { PrActions } from '../workspace/PrActions';
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

/** Drop the viewed mark of files that changed in a new PR head. */
export function clearViewed(dir: string, paths: string[]) {
  const cur = useViewed.getState().by[dir] || [];
  const next = cur.filter((p) => !paths.includes(p));
  if (next.length === cur.length) return;
  const by = { ...useViewed.getState().by, [dir]: next };
  useViewed.setState({ by });
  H.saveUi({ prViewed: by });
}

/** PR identity -> reviewed SHAs. Rewritten commits naturally start unreviewed. */
const useReviewed = create<{ by: Record<string, string[]> }>(() => ({
  by: (useStore.getState().app.ui.prReviewedCommits as Record<string, string[]>) || {},
}));
// Modules load before the initial state IPC completes. Hydrate once that state arrives.
useStore.subscribe((state, previous) => {
  if (state.ready && !previous.ready) {
    useViewed.setState({ by: (state.app.ui.prViewed as Record<string, string[]>) || {} });
    useReviewed.setState({ by: (state.app.ui.prReviewedCommits as Record<string, string[]>) || {} });
  }
});
function setReviewed(pr: string, sha: string, on: boolean) {
  const cur = useReviewed.getState().by[pr] || [];
  const by = { ...useReviewed.getState().by, [pr]: on ? [...new Set([...cur, sha])] : cur.filter((s) => s !== sha) };
  useReviewed.setState({ by });
  H.saveUi({ prReviewedCommits: by });
}

/** Secondary text: --text mixed toward --bg (>=4.5:1 on both themes; raw --faint/--muted fail on latte). */
const DIM = 'text-[color-mix(in_srgb,var(--text)_85%,var(--bg))]';

export function PrFilesView({ dir }: { dir: string }) {
  const [files, setFiles] = useState<PrFiles | null>(null);
  const [snap, setSnap] = useState<PrSnapshot | null>(null);
  const [err, setErr] = useState('');
  const [commits, setCommits] = useState<PrCommit[]>([]);
  const [commitsOpen, setCommitsOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [commitFiles, setCommitFiles] = useState<PrFiles['files'] | null>(null);
  const pr = useStore((s) => s.app.repos.flatMap((r) => r.worktrees).find((w) => w.path === dir)?.pr);
  const identity = pr ? `${pr.host}/${pr.owner}/${pr.repo}#${pr.number}` : dir;
  const reviewed = useReviewed((s) => s.by[identity]);
  const reviewedSet = new Set(reviewed);
  const viewedKey = selected ? `${dir}:${selected}` : dir;
  const viewed = useViewed((s) => s.by[viewedKey]);
  useTree((s) => s.tick);

  useEffect(() => {
    let live = true;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      Promise.all([H.prFiles(dir), H.prCommits(dir), H.prFetch(dir)])
        .then(([changed, list, snapshot]) => {
          if (!live || request !== generation) return;
          setFiles(changed);
          setCommits(list);
          setSnap(snapshot);
          setSelected((sha) => (list.some((c) => c.sha === sha) ? sha : ''));
          setErr('');
        })
        .catch((e) => live && request === generation && setErr((e as Error).message));
    };
    setSelected('');
    setCommits([]);
    setFiles(null);
    setSnap(null);
    load();
    const off = onPrSnapshot((r) => r === dir && load());
    return () => {
      live = false;
      off();
    };
  }, [dir]);

  useEffect(() => {
    let live = true;
    setCommitFiles(null);
    if (selected)
      H.gitCommitFiles(dir, selected)
        .then((list) => live && setCommitFiles(list))
        .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [dir, selected]);

  const _index = commits.findIndex((c) => c.sha === selected);
  const shown = selected ? commitFiles : files?.files;
  const mode = selected ? 'c' : 'r';
  const ref = selected || files?.base;
  const seen = new Set(viewed);
  const mixedAuthors = new Set(commits.map((c) => c.author)).size > 1;
  const count = (p: string) => snap?.threads.filter((t) => t.path === p).length ?? 0;
  const active = activeKey();
  return (
    <>
      <div
        className="flex flex-wrap items-center justify-end gap-1 border-b px-2 py-1"
        role="toolbar"
        aria-label="Pull request actions"
      >
        {pr && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground"
            title="Open PR details"
            aria-label="Open PR details"
            onClick={() => {
              const key = `p:${pr.owner}/${pr.repo}#${pr.number}`;
              seedPrTab(dir, key);
              revealKey(key);
            }}
          >
            <FileTextIcon />
          </Button>
        )}
        <PrActions key={dir} dir={dir} snap={snap} />
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <ItemGroup className="p-2 text-foreground">
          {/* biome-ignore lint/a11y/useSemanticElements: styled like the Sources section headers */}
          <div
            className="cn-head"
            role="button"
            tabIndex={0}
            aria-expanded={commitsOpen}
            onClick={() => setCommitsOpen((o) => !o)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setCommitsOpen((o) => !o);
              }
            }}
          >
            <span className={`tw${commitsOpen ? ' open' : ''}`}>
              <Chevron />
            </span>
            Commits
          </div>
          {commitsOpen && (
            <>
              {/* biome-ignore lint/a11y/useSemanticElements: same row style as the commits below */}
              <div
                role="button"
                tabIndex={0}
                className={`cm text-[12.5px]${selected ? '' : ' bg-[var(--hover)] shadow-[inset_2px_0_0_var(--accent)]'}`}
                aria-pressed={!selected}
                onClick={() => setSelected('')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected('');
                  }
                }}
              >
                <span className="cm-sub">All changes</span>
              </div>
              {commits.map((c) => (
                // biome-ignore lint/a11y/useSemanticElements: row holds a nested checkbox, so it cannot be a <button>
                <div
                  key={c.sha}
                  role="button"
                  tabIndex={0}
                  className={`cm text-[12.5px]${selected === c.sha ? ' bg-[var(--hover)] shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
                  title={`${c.short} ${c.author}\n${c.subject}`}
                  aria-pressed={selected === c.sha}
                  onClick={() => setSelected(c.sha)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      setSelected(c.sha);
                    }
                  }}
                >
                  <Checkbox
                    checked={reviewedSet.has(c.sha)}
                    className="border-foreground"
                    aria-label={`Mark commit ${c.short} as reviewed`}
                    onClick={(e) => e.stopPropagation()}
                    onCheckedChange={(on) => setReviewed(identity, c.sha, on === true)}
                  />
                  <span className="cm-sub">{c.subject}</span>
                  {mixedAuthors && <span className={`shrink-0 text-xs ${DIM}`}>{c.author}</span>}
                  <span className={`cm-meta font-mono text-[10.5px] ${DIM}`}>{c.short}</span>
                </div>
              ))}
            </>
          )}
        </ItemGroup>
        {err ? (
          <div className="tree-empty">{err}</div>
        ) : !files || !shown ? (
          <div className="tree-empty">Loading…</div>
        ) : (
          <div id="changes">
            <div className="cn-head">
              {selected ? (
                <>
                  Commit <span className="font-mono normal-case tracking-normal">{selected.slice(0, 7)}</span>
                </>
              ) : (
                'PR files'
              )}
              <span className="cn-stat" title="Files marked viewed">
                {shown.filter((f) => seen.has(f.path)).length}/{shown.length} viewed
              </span>
            </div>
            {shown.map((f) => {
              const abs = `${dir}/${f.path}`;
              const name = baseName(f.path);
              const i = f.path.lastIndexOf('/');
              const n = selected ? 0 : count(f.path);
              const open = () => openDiff(mode, `${ref}:${abs}`, { preview: true });
              return (
                <div
                  key={f.path}
                  className={`cn s${f.status}${active === `d:${mode}:${ref}:${abs}` ? ' on' : ''}`}
                  title={f.orig ? `${f.orig} → ${f.path}` : f.path}
                  onClick={open}
                  onDoubleClick={() => openDiff(mode, `${ref}:${abs}`, { pin: true })}
                >
                  <Checkbox
                    className="border-foreground"
                    checked={seen.has(f.path)}
                    onClick={(e) => e.stopPropagation()}
                    onCheckedChange={(c) => setViewed(viewedKey, f.path, c === true)}
                    aria-label={`Mark ${f.path} as viewed`}
                  />
                  <img className="ti" src={iconSrc(name, 'file')} draggable={false} alt="" />
                  <span className="cn-name">{name}</span>
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
            {!shown.length && (
              <div className="tree-empty">
                {selected ? 'This commit has no file changes' : 'No changes against the base branch'}
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </>
  );
}
