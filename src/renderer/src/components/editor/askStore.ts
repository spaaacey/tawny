// Open selection message boxes ("ask boxes"). A box belongs to a file and a line range, not to an editor: it stays until it
// is sent or closed (escape, its x, the secondary sidebar's Asks list), whatever you navigate to meanwhile. The editor
// showing the file renders its boxes and keeps `a`/`b` current as the file is edited.
import { create } from 'zustand';

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
  agents: AskTarget[];
  idx: number;
  focusTick: number;
}

export const useAsks = create<{ boxes: AskBox[] }>(() => ({ boxes: [] }));

let seq = 0;
export function openBox(path: string, a: number, b: number, agents: AskTarget[], idx: number) {
  const id = `ask${++seq}`;
  const box: AskBox = { id, path, a, b, draft: '', agents, idx, focusTick: 1 };
  useAsks.setState((s) => ({ boxes: [...s.boxes, box] }));
  return id;
}
export const patchBox = (id: string, patch: Partial<AskBox>) =>
  useAsks.setState((s) => {
    const cur = s.boxes.find((x) => x.id === id);
    if (!cur || Object.entries(patch).every(([k, v]) => cur[k as keyof AskBox] === v)) return s;
    return { boxes: s.boxes.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
  });
export const closeBox = (id: string) => {
  useAsks.setState((s) => ({ boxes: s.boxes.filter((x) => x.id !== id) }));
  zoneDoms.delete(id);
};
export const focusBox = (id: string) =>
  useAsks.setState((s) => ({ boxes: s.boxes.map((x) => (x.id === id ? { ...x, focusTick: x.focusTick + 1 } : x)) }));
export const cycleBox = (id: string) => {
  const cur = useAsks.getState().boxes.find((x) => x.id === id);
  if (cur && cur.agents.length > 1) patchBox(id, { idx: (cur.idx + 1) % cur.agents.length });
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
