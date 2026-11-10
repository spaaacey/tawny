import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { MermaidStage } from './MermaidStage';

export const MERMAID_EXPAND_EVENT = 'tawny:mermaid-expand';

/** Near-fullscreen viewer for chat mermaid diagrams. */
export function MermaidExpand() {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    const on = (e: Event) => setSvg((e as CustomEvent<string>).detail);
    window.addEventListener(MERMAID_EXPAND_EVENT, on);
    return () => window.removeEventListener(MERMAID_EXPAND_EVENT, on);
  }, []);

  return (
    <Dialog open={svg !== null} onOpenChange={(o) => !o && setSvg(null)}>
      <DialogContent
        className="h-[92vh] w-[94vw] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Diagram</DialogTitle>
        {svg !== null && (
          <MermaidStage svg={svg} hint="scroll/pinch to zoom · drag to pan · double-click to reset · esc to close" />
        )}
      </DialogContent>
    </Dialog>
  );
}
