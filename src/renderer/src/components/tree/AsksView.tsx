// Secondary sidebar tab listing the open ask boxes (selection message boxes) of the worktree: click one to jump to it.
import { useState } from 'react';
import { askAgent, askNewAgent } from '../../lib/actions';
import { iconSrc } from '../../lib/fileicons';
import { models } from '../../lsp/models';
import { openFile } from '../editor/api';
import { type AskBox, closeBox, focusBox, isNote, NEW_AGENT, useAsks } from '../editor/askStore';
import { askContext } from '../editor/host';
import { Chevron } from '../icons';
import { focusedGroup } from '../workspace/layoutStore';
import { relTo, useTree } from './store';

export const useOpenAsks = () => {
  const root = useTree((s) => s.root);
  const boxes = useAsks((s) => s.boxes);
  return root ? boxes.filter((b) => b.path.startsWith(`${root}/`)) : [];
};

const savedAsks = (boxes: AskBox[]) => boxes.filter((b) => b.saved && !isNote(b));

/** Send every saved ask to its agent: one combined message per agent, all "new agent" asks to one shared new agent. Sent asks are removed. */
export function sendAllAsks(boxes: AskBox[]) {
  const byAgent = new Map<string, AskBox[]>();
  for (const b of savedAsks(boxes)) {
    const id = b.agents[b.idx]?.id ?? NEW_AGENT;
    byAgent.set(id, [...(byAgent.get(id) || []), b]);
  }
  const gid = focusedGroup();
  for (const [id, group] of byAgent) {
    const parts = group.sort((x, y) => x.path.localeCompare(y.path) || x.a - y.a);
    const refs = parts.map((b) => askContext(b.path, models.get(b.path)?.model ?? null, b.a, b.b));
    const last = parts.length - 1;
    const ref = parts.map((b, i) => (i < last ? `${refs[i]}Comment: ${b.saved}\n\n` : refs[i])).join('');
    for (const b of parts) closeBox(b.id);
    if (id === NEW_AGENT) askNewAgent(ref, parts[last].saved, gid ?? '');
    else askAgent(ref, parts[last].saved, id);
  }
}

/** Button sending all saved asks; hidden when there are none. */
export function SendAllAsks({ className }: { className?: string }) {
  const saved = savedAsks(useOpenAsks());
  const n = saved.length;
  if (!n) return null;
  return (
    <button
      type="button"
      className={className}
      title="Send every saved ask to its agent"
      onClick={() => sendAllAsks(saved)}
    >
      Send {n} {n === 1 ? 'ask' : 'asks'}
    </button>
  );
}

async function jump(b: AskBox) {
  await openFile(b.path);
  setTimeout(() => focusBox(b.id), 60); // the editor mounts the box once the file is shown
}

interface Row {
  key: string;
  depth: number;
  kind: 'dir' | 'file';
  name: string;
  open: boolean;
}

export function AsksView() {
  const root = useTree((s) => s.root);
  const boxes = useOpenAsks();
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!boxes.length)
    return (
      <div className="center-msg" style={{ position: 'static', padding: '40px 12px' }}>
        <div className="empty-title">No open asks</div>
        <div>Select code and press cmd+opt+l to message an agent about it.</div>
      </div>
    );

  const toggle = (k: string) =>
    setClosed((c) => {
      const n = new Set(c);
      if (!n.delete(k)) n.add(k);
      return n;
    });

  // Files sorted like the file tree: folders first, then names; each file's asks by line.
  const byFile = new Map<string, AskBox[]>();
  for (const b of boxes) byFile.set(b.path, [...(byFile.get(b.path) || []), b]);
  const files = [...byFile.keys()].map((p) => ({ p, parts: relTo(root, p).split('/') }));
  const cmp = (a: string[], b: string[]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      const ad = i < a.length - 1;
      const bd = i < b.length - 1;
      if (ad !== bd) return ad ? -1 : 1;
      return a[i].localeCompare(b[i]);
    }
    return a.length - b.length;
  };
  files.sort((x, y) => cmp(x.parts, y.parts));

  const out: (Row | AskBox)[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    let hidden = false;
    f.parts.forEach((name, i) => {
      if (hidden) return;
      const isFile = i === f.parts.length - 1;
      const key = isFile ? f.p : `d:${f.parts.slice(0, i + 1).join('/')}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ key, depth: i, kind: isFile ? 'file' : 'dir', name, open: !closed.has(key) });
      }
      if (closed.has(key)) hidden = true;
    });
    if (!hidden) out.push(...(byFile.get(f.p) as AskBox[]).sort((a, b) => a.a - b.a));
  }

  const depthOf = (b: AskBox) => relTo(root, b.path).split('/').length;
  return (
    <div className="asks-tree">
      <SendAllAsks className="asks-send" />
      {out.map((r) =>
        'kind' in r ? (
          <div
            key={r.key}
            className={`tn ${r.kind}`}
            style={{ paddingLeft: 8 + r.depth * 12 }}
            onClick={() => toggle(r.key)}
          >
            <span className={`tw${r.open ? ' open' : ''}`}>
              <Chevron />
            </span>
            <img className="ti" src={iconSrc(r.name, r.kind, r.open)} draggable={false} alt="" />
            <span className="tl">{r.name}</span>
          </div>
        ) : (
          <div
            key={r.id}
            className={`asks-row${isNote(r) ? ' note' : ''}`}
            style={{ marginLeft: 8 + depthOf(r) * 12 + 14 }}
            onClick={() => jump(r)}
            title={r.path}
          >
            <div className="asks-head">
              <span className="asks-lines">{r.a === r.b ? `L${r.a}` : `L${r.a}-${r.b}`}</span>
              <span className="asks-agent">{isNote(r) ? 'Note' : r.agents[r.idx]?.label}</span>
              <button
                type="button"
                className="asks-x"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeBox(r.id);
                }}
              >
                ✕
              </button>
            </div>
            {(r.saved || r.draft).trim() ? (
              <div
                className="asks-draft rich-doc"
                dangerouslySetInnerHTML={{ __html: window.tawnyChatMd.render((r.saved || r.draft).trim()) }}
              />
            ) : (
              <div className="asks-draft empty">No message yet</div>
            )}
          </div>
        ),
      )}
    </div>
  );
}
