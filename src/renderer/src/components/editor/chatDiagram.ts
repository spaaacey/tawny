// Read-only tab for a chat mermaid diagram: key 'g:<hash of the rendered SVG>'. The SVG lives in this in-memory store only
// (session scope): layoutStore's revive() drops 'g:' keys on restore, so a reloaded app never shows one.
import { create } from 'zustand';
import { openKey } from '../workspace/layoutStore';

export const CHAT_DIAGRAM_EVENT = 'tawny:mermaid-open-tab';
export const isChatDiagramKey = (k: string | null | undefined): k is string => !!k?.startsWith('g:');

type Entry = { svg: string; title: string };
export const useChatDiagrams = create<{ byKey: Record<string, Entry>; seq: number }>(() => ({ byKey: {}, seq: 0 }));

/** FNV-1a, base36. */
function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export function openChatDiagram(svg: string) {
  const key = `g:${hash(svg)}`;
  if (!useChatDiagrams.getState().byKey[key])
    useChatDiagrams.setState((s) => ({
      seq: s.seq + 1,
      byKey: { ...s.byKey, [key]: { svg, title: `Diagram ${s.seq + 1}` } },
    }));
  return openKey(key, { pin: true });
}

/** Drop a closed tab's content. */
export function dropChatDiagram(key: string) {
  useChatDiagrams.setState((s) => {
    const { [key]: _gone, ...byKey } = s.byKey;
    return { byKey };
  });
}

window.addEventListener(CHAT_DIAGRAM_EVENT, (e) => openChatDiagram((e as CustomEvent<string>).detail));
