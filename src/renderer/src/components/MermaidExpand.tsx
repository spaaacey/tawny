import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';

export const MERMAID_EXPAND_EVENT = 'tawny:mermaid-expand';
type T = { x: number; y: number; k: number };
const HOME: T = { x: 0, y: 0, k: 1 };

/** Near-fullscreen viewer for chat mermaid diagrams: wheel/pinch zoom at cursor, drag pan, double-click resets. */
export function MermaidExpand() {
  const [svg, setSvg] = useState<string | null>(null);
  const [t, setT] = useState<T>(HOME);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      setT(HOME);
      setSvg((e as CustomEvent<string>).detail);
    };
    window.addEventListener(MERMAID_EXPAND_EVENT, on);
    return () => window.removeEventListener(MERMAID_EXPAND_EVENT, on);
  }, []);

  // non-passive wheel so we can preventDefault (trackpad pinch arrives as ctrl+wheel)
  useEffect(() => {
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const cx = e.clientX - r.left - r.width / 2;
      const cy = e.clientY - r.top - r.height / 2;
      setT((p) => {
        const k = Math.min(20, Math.max(0.2, p.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
        const f = k / p.k;
        return { k, x: cx - (cx - p.x) * f, y: cy - (cy - p.y) * f };
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [stage]);

  return (
    <Dialog open={svg !== null} onOpenChange={(o) => !o && setSvg(null)}>
      <DialogContent
        className="h-[92vh] w-[94vw] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Diagram</DialogTitle>
        <div
          ref={setStage}
          className="mermaid-stage"
          onDoubleClick={() => setT(HOME)}
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) setT((p) => ({ ...p, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <div
            className="mermaid-view mermaid-canvas"
            style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.k})` }}
            dangerouslySetInnerHTML={{ __html: svg ?? '' }}
          />
        </div>
        <div className="mermaid-hint">scroll/pinch to zoom · drag to pan · double-click to reset · esc to close</div>
      </DialogContent>
    </Dialog>
  );
}
