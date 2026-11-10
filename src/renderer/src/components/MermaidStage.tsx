import { useEffect, useRef, useState } from 'react';

type T = { x: number; y: number; k: number };
const HOME: T = { x: 0, y: 0, k: 1 };

/** Zoom/pan stage for a rendered mermaid SVG (chat dialog + chat diagram tab): wheel/pinch zoom at cursor, drag pan, double-click resets. */
export function MermaidStage({ svg, hint }: { svg: string; hint: string }) {
  const [t, setT] = useState<T>(HOME);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

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
    <>
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
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="mermaid-hint">{hint}</div>
    </>
  );
}
