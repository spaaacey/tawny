import { useStore } from '../store';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div id="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.msg}
        </div>
      ))}
    </div>
  );
}
