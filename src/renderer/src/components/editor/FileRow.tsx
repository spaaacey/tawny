// A file-match row (filename, then its folder dimmed) with the fuzzy-match hits bolded. Shared by the palette, the
// launcher and the chat @-mention list.
import type { FileMatch } from '../../lib/editor/fileIndex';

function Hl({ text, from, hit }: { text: string; from: number; hit: Set<number> }) {
  return (
    <>
      {[...text].map((c, j) => {
        const k = from + j;
        return hit.has(k) ? <b key={k}>{c}</b> : c;
      })}
    </>
  );
}

export function FileRow({ r }: { r: FileMatch }) {
  const hit = new Set(r.hits || []);
  const b = r.f.lastIndexOf('/') + 1;
  return (
    <>
      <span className="qf">
        <Hl text={r.f.slice(b)} from={b} hit={hit} />
      </span>
      <span className="r">
        <Hl text={r.f.slice(0, Math.max(0, b - 1))} from={0} hit={hit} />
      </span>
    </>
  );
}
