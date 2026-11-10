// Body of a chat diagram tab ('g:<hash>', see chatDiagram.ts): the SVG on the shared zoom/pan stage.
import { MermaidStage } from '../MermaidStage';
import { isChatDiagramKey, useChatDiagrams } from './chatDiagram';

export function ChatDiagramPane({ k }: { k: string | null }) {
  const entry = useChatDiagrams((s) => (isChatDiagramKey(k) ? s.byKey[k] : undefined));
  if (!entry || !k) return null;
  return (
    <div className="absolute inset-0 bg-[var(--editor)]">
      <MermaidStage key={k} svg={entry.svg} hint="scroll/pinch to zoom · drag to pan · double-click to reset" />
    </div>
  );
}
