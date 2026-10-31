// Open selection message boxes ("ask boxes"). A box belongs to a file and a line range, not to an editor: it stays until it
// is sent or closed (escape, its x, the secondary sidebar's Asks list), whatever you navigate to meanwhile. The editor
// showing the file renders its boxes and keeps `a`/`b` current as the file is edited.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Pseudo target: start a new agent in the pane right of the editor. */
export const NEW_AGENT = '+new';
export interface AskTarget {
  id: string;
  label: string;
  working: boolean;
  waiting: boolean;
}
export interface AskBox {
  id: string;
  path: string;
  a: number; // first and last line (1-based) of the selection
  b: number;
  draft: string;
  saved: string; // last committed text (enter / blur); '' for a box that was never saved
  open: boolean; // expanded; otherwise a gutter icon
  agents: AskTarget[];
  idx: number;
  focusTick: number;
}

/** Pseudo target: keep the box as a static comment, never sent to an agent. */
export const NOTE = '+note';
const NOTE_SLOT: AskTarget = { id: NOTE, label: 'Note (not sent)', working: false, waiting: false };
export const isNote = (b: AskBox) => b.agents[b.idx]?.id === NOTE;

const NEW_SLOT: AskTarget = { id: NEW_AGENT, label: 'New agent (split right)', working: false, waiting: false };

// Persisted in localStorage so boxes survive closing the window. Agent targets are live and stale after a restart, so a
// restored box only offers "new agent" and "note" (a note stays a note); focusTick resets so restoring doesn't steal focus.
export const useAsks = create<{ boxes: AskBox[] }>()(
  persist(() => ({ boxes: [] as AskBox[] }), {
    name: 'tawny.asks',
    version: 1,
    partialize: (s) => ({ boxes: s.boxes.map((b) => ({ ...b, agents: [], idx: isNote(b) ? 1 : 0, focusTick: 0 })) }),
    merge: (saved, cur) => {
      const boxes = (saved as { boxes?: AskBox[] } | undefined)?.boxes;
      if (!Array.isArray(boxes)) return cur;
      return {
        ...cur,
        boxes: boxes.map((b) => ({ ...b, agents: [NEW_SLOT, NOTE_SLOT], idx: b.idx === 1 ? 1 : 0, focusTick: 0 })),
      };
    },
  }),
);

/** Target id last picked with shift+tab; new boxes start on it when still offered. */
let lastTarget: string | undefined;
let seq = 0;
export function openBox(path: string, a: number, b: number, agents: AskTarget[], idx: number) {
  const all = [...agents, NOTE_SLOT];
  const last = all.findIndex((t) => t.id === lastTarget);
  if (last >= 0) idx = last;
  const id = `ask${Date.now().toString(36)}${++seq}`; // unique across restarts: boxes are persisted
  const box: AskBox = {
    id,
    path,
    a,
    b,
    draft: '',
    saved: '',
    open: true,
    agents: all,
    idx,
    focusTick: 1,
  };
  useAsks.setState((s) => ({ boxes: [...s.boxes, box] }));
  return id;
}
export const patchBox = (id: string, patch: Partial<AskBox>) =>
  useAsks.setState((s) => {
    const cur = s.boxes.find((x) => x.id === id);
    if (!cur || Object.entries(patch).every(([k, v]) => cur[k as keyof AskBox] === v)) return s;
    return { boxes: s.boxes.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
  });
/** Boxes deleted by the user, most recent last, for cmd+z. Cleared by any other keystroke (see bridge). */
let deleted: AskBox[] = [];
export const clearDeletedBoxes = () => {
  if (deleted.length) deleted = [];
};
/** Remove a box. `keep`: remember it so cmd+z can bring it back (deleting; not sending). */
export const closeBox = (id: string, keep = false) => {
  const cur = useAsks.getState().boxes.find((x) => x.id === id);
  if (keep && cur && (cur.saved || cur.draft.trim())) deleted.push(cur);
  useAsks.setState((s) => ({ boxes: s.boxes.filter((x) => x.id !== id) }));
  zoneDoms.delete(id);
};
/** Bring back the most recently deleted box (minimised; its agent is re-picked from the live list). */
export const restoreBox = () => {
  const b = deleted.pop();
  if (!b) return false;
  useAsks.setState((s) => ({ boxes: [...s.boxes, { ...b, open: false, focusTick: 0 }] }));
  return true;
};
/** Expand the boxes and move into the first one's text. */
export const focusBox = (...ids: string[]) =>
  useAsks.setState((s) => ({
    boxes: s.boxes.map((x) =>
      ids.includes(x.id) ? { ...x, open: true, focusTick: x.focusTick + (x.id === ids[0] ? 1 : 0) } : x,
    ),
  }));
/** Commit the text and collapse to the icon. Empty: a never-saved box goes away, a saved one reverts to its text. */
export const minimiseBox = (id: string) => {
  const cur = useAsks.getState().boxes.find((x) => x.id === id);
  if (!cur) return;
  const text = cur.draft.trim() || cur.saved;
  if (!text) closeBox(id);
  else patchBox(id, { draft: text, saved: text, open: false });
};
export const pickBox = (id: string, idx: number) => {
  const cur = useAsks.getState().boxes.find((x) => x.id === id);
  if (!cur?.agents[idx]) return;
  lastTarget = cur.agents[idx].id;
  patchBox(id, { idx });
};
export const cycleBox = (id: string) => {
  const cur = useAsks.getState().boxes.find((x) => x.id === id);
  if (!cur || cur.agents.length < 2) return;
  const idx = (cur.idx + 1) % cur.agents.length;
  lastTarget = cur.agents[idx].id;
  patchBox(id, { idx });
};

const zoneDoms = new Map<string, HTMLElement>(); // box id -> the element a view zone (or a rich-view widget) shows
export const zoneDom = (id: string) => {
  let z = zoneDoms.get(id);
  if (!z) {
    z = document.createElement('div');
    z.className = 'ask-zone';
    z.contentEditable = 'false';
    zoneDoms.set(id, z);
  }
  return z;
};
