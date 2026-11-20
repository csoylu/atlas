import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Each screen's 44px header (design §16): App draws the breadcrumb; a screen puts its own actions on the right with
 * <HeaderActions>, portalled into the header's slot, so the header stays one row whatever the screen.
 */
export const HeaderSlot = createContext<HTMLElement | null>(null);

export function HeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlot);
  return slot ? createPortal(children, slot) : null;
}

const svg = (d: ReactNode, size = 16) => () => (
  <svg className="icon" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

/** The shell's line icons (16px grid, 1.4 stroke, as in the mockup). */
export const Icon = {
  inbox: svg(<><path d="M2 9.5 3.5 3h9L14 9.5V13H2z" /><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14" /></>),
  dots: svg(<><circle cx="3.5" cy="8" r=".6" /><circle cx="8" cy="8" r=".6" /><circle cx="12.5" cy="8" r=".6" /></>, 14),
  back: svg(<path d="m10 4-4 4 4 4" />, 14),
  grid: svg(<><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></>, 14),
  board: svg(<><rect x="2" y="2.5" width="3.5" height="11" rx="1" /><rect x="6.25" y="2.5" width="3.5" height="7" rx="1" /><rect x="10.5" y="2.5" width="3.5" height="9" rx="1" /></>),
  library: svg(<><path d="M3 2.5h3v11H3zM7 2.5h3v11H7z" /><path d="m11 3.2 2.6-.6 1.4 10.6-2.6.5z" /></>),
  pin: svg(<><path d="M6 2.5h4l-.6 4 2.1 2H4.5l2.1-2z" /><path d="M8 8.5v5" /></>, 14),
  ext: svg(<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v4H2.5V4h4" />, 14),
  folder: svg(<path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" />, 14),
  folder16: svg(<path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" />),
  stack: svg(<><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M2.5 6.5h11M6.5 6.5v7" /></>),
  expand: svg(<path d="M9.5 2.5h4v4M13.5 2.5l-4.5 4.5M6.5 13.5h-4v-4M2.5 13.5 7 9" />, 14),
  shrink: svg(<path d="M13.5 6.5h-4v-4M9.5 6.5l4-4M2.5 9.5h4v4M6.5 9.5l-4 4" />, 14),
  restore: svg(<path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5v2.5h2.5" />, 14),
  code: svg(<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />, 14),
  check: svg(<path d="M3.5 8.5l3 3 6-7" />, 14),
  chevDown: svg(<path d="m4 6 4 4 4-4" />, 12),
  ask: svg(<path d="M2.5 3.5h11v7.5H7l-3 2.5v-2.5H2.5z" />, 14),
  clock: svg(<><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>),
  workflows: svg(<><rect x="1.75" y="2.5" width="4.5" height="3.5" rx="1" /><rect x="9.75" y="2.5" width="4.5" height="3.5" rx="1" /><rect x="9.75" y="10" width="4.5" height="3.5" rx="1" /><path d="M6.25 4.25h3.5M12 6v4" /></>),
  search: svg(<><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>, 14),
  edit: svg(<path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" />, 14),
  plus: svg(<path d="M8 3v10M3 8h10" />, 14),
  gear: svg(<><path d="M6.63 3.51 6.87 1.6A6.5 6.5 0 0 1 9.13 1.6l.24 1.91A4.7 4.7 0 0 1 11.21 4.56l1.77-.74A6.5 6.5 0 0 1 14.11 5.78L12.58 6.94A4.7 4.7 0 0 1 12.58 9.06l1.53 1.16A6.5 6.5 0 0 1 12.98 12.18L11.21 11.44A4.7 4.7 0 0 1 9.37 12.49L9.13 14.4A6.5 6.5 0 0 1 6.87 14.4L6.63 12.49A4.7 4.7 0 0 1 4.79 11.44L3.02 12.18A6.5 6.5 0 0 1 1.89 10.22L3.42 9.06A4.7 4.7 0 0 1 3.42 6.94L1.89 5.78A6.5 6.5 0 0 1 3.02 3.82L4.79 4.56A4.7 4.7 0 0 1 6.63 3.51z" /><circle cx="8" cy="8" r="1.9" /></>),
  sun: svg(<><circle cx="8" cy="8" r="2.6" /><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" /></>),
  moon: svg(<path d="M13.2 9.6A5.5 5.5 0 1 1 6.4 2.8a5 5 0 0 0 6.8 6.8z" />),
  chev: svg(<path d="m6 4 4 4-4 4" />, 14),
  menu: svg(<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />),
  trash: svg(<path d="M2.8 4.4h10.4M6.4 2.4h3.2l.8 2H5.6zM4.4 4.4l.6 8.8h6l.6-8.8M6.8 6.8v4M9.2 6.8v4" />, 15),
  doc: svg(<><path d="M3.5 2.5h6l3 3v8h-9z" /><path d="M9.5 2.5v3h3" /></>),
  filter: svg(<path d="M2.5 4h11M4.5 8h7M6.5 12h3" />, 14),
  list: svg(<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />, 14),
  x: svg(<path d="M4 4l8 8M12 4l-8 8" />, 14),
  archive: svg(<><rect x="2" y="3" width="12" height="3" rx="0.8" /><path d="M3 6v7h10V6M6.5 8.5h3" /></>, 14),
  undo: svg(<path d="M5.5 3.5 2.5 6.5l3 3M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7" />, 14),
  memory: svg(<><path d="M8 2.5a3.5 3.5 0 0 0-3.5 3.5c0 1.3.6 2.1 1.4 2.8.6.5.9 1.1.9 1.7h2.4c0-.6.3-1.2.9-1.7.8-.7 1.4-1.5 1.4-2.8A3.5 3.5 0 0 0 8 2.5z" /><path d="M6.5 12.5h3M7 14h2" /></>),
  panel: svg(<><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M9.5 2.5v11" /></>, 14),
  globe: svg(<><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.7 2.3 3.5 2.3 5.5S9.6 11.8 8 13.5C6.4 11.8 5.7 10 5.7 8S6.4 4.2 8 2.5z" /></>, 12),
  logout: svg(<path d="M6 2.5H3v11h3M10.5 5l3 3-3 3M13.5 8H6.5" />, 14),
  fwd: svg(<path d="m6 4 4 4-4 4" />, 14),
  reload: svg(<path d="M12.5 5.5A5 5 0 1 0 13 9 M13 2.5v3h-3" />, 14),
  stop: svg(<path d="M4 4l8 8M12 4l-8 8" />, 14),
  lock: svg(<path d="M4.5 7.5h7v6h-7z M6 7.5V5.5a2 2 0 0 1 4 0v2" />, 13),
  warn: svg(<path d="M8 2.5l6 10.5H2z M8 6.5v3M8 11.3v.1" />, 14),
  crash: svg(<path d="M3 3h10v10H3z M5.5 6l1.5 1.5M5.5 7.5 7 6M9 6l1.5 1.5M9 7.5 10.5 6M5.5 11c1.5-1.3 3.5-1.3 5 0" />),
  wifiOff: svg(<path d="M2.5 2.5l11 11 M1.5 6.5c1.4-1.3 3-2.1 4.7-2.4 M14.5 6.5a9 9 0 0 0-4-2.3 M4 9c.8-.7 1.7-1.2 2.7-1.4 M8 12.5v.1" />),
  up: () => (
    <svg className="icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13V3M4 7l4-4 4 4" />
    </svg>
  ),
};
