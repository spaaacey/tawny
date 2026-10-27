/** Disclosure arrow used everywhere (points right; `.open > .chev` / expanded rows rotate it down). */
export function Chevron() {
  return (
    <svg className="chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
