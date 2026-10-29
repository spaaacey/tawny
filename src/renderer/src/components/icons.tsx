import type { SVGProps } from 'react';

const base = { viewBox: '0 0 16 16', xmlns: 'http://www.w3.org/2000/svg' } as const;
type P = SVGProps<SVGSVGElement>;

export const Chevron = (p: P) => (
  <svg className="chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...p}>
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

export const Plus = ({ size = 13 }: { size?: number }) => (
  <svg {...base} width={size} height={size} aria-hidden="true">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const X = ({ size = 11 }: { size?: number }) => (
  <svg {...base} width={size} height={size} aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const Scratch = () => (
  <svg
    {...base}
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3.5 2.5h7l2 2v9h-9zM10.5 2.5v2h2M5.5 7.5h5M5.5 10h3.5" />
  </svg>
);

export const Folder = () => (
  <svg
    {...base}
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
  </svg>
);

export const Branch = () => (
  <svg
    {...base}
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5.5" r="1.5" />
    <path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6.2 4.2" />
  </svg>
);

export const Tree = () => (
  <svg
    {...base}
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 14V10.5M8 1.5 4 6.5h2L3.5 10h9L10 6.5h2z" />
  </svg>
);

export const Trash = () => (
  <svg
    {...base}
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </svg>
);

export const Chip = () => (
  <svg
    {...base}
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="4.5" width="12" height="6" rx="1" />
    <path d="M4.5 12.5v1.5M8 12.5v1.5M11.5 12.5v1.5M4.5 7.5v0M8 7.5v0M11.5 7.5v0" />
  </svg>
);

export const Refresh = () => (
  <svg
    {...base}
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v2.5h-2.5" />
  </svg>
);

export const Plug = () => (
  <svg
    {...base}
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 2v3M10 2v3M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5V14" />
  </svg>
);

export const ReplaceAll = () => (
  <svg
    {...base}
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.5 5.5h8.5M8.5 3l2.5 2.5L8.5 8M13.5 10.5H5M7.5 8 5 10.5 7.5 13" />
  </svg>
);
