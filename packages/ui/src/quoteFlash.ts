// Lighting a quoted passage again (#368) where it is not a chat message (#367 marks those in its markdown): a tool
// row, the task's description, a document, a file's source. The passage is found in the element's text (white space
// counted as one space, as a selection reads it), lit with the CSS Highlight API for 2 s (no change to the DOM, so
// nothing re-renders) and scrolled into view. Not found: false, the caller says so.
import { useSyncExternalStore } from 'react';
import { findPassage, type CommentTarget } from '@atlas/shared';
export { findPassage };

type Registry = { set(name: string, h: unknown): void; delete(name: string): void };
const highlights = (): Registry | null => (typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as unknown as { highlights: Registry }).highlights : null);
let clear: ReturnType<typeof setTimeout> | null = null;

/** Light `passage` in `root` for 2 s and scroll to it; false when it is not there (the element still scrolls into view). */
export function flashPassage(root: Element, passage: string): boolean {
  const r = findPassage(root, passage);
  if (!r) {
    root.scrollIntoView({ block: 'center' });
    return false;
  }
  const reg = highlights();
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (reg && H) {
    reg.set('qt-flash', new H(r));
    if (clear) clearTimeout(clear);
    clear = setTimeout(() => reg.delete('qt-flash'), 2000);
  }
  (r.startContainer.parentElement ?? root).scrollIntoView({ block: 'center' });
  return true;
}

/**
 * A jump back to a pane passage (#368): the tab to open and the passage to light once it shows. The chat opens the
 * tab (ChatView), the tab's view lights it (its `usePaneFlash`) and says whether it found it.
 */
export interface PaneWant {
  target: CommentTarget;
  passage: string;
  lines: [number, number] | null;
  selector: string | null;
  t: number;
}
let want: PaneWant | null = null;
const listeners = new Set<() => void>();
/** Which jumps found nothing (the file or page changed): their chip or card says so. */
const gone = new Set<string>();
let results = 0;
/** The same tab: an artifact (any version), a file, a page at that address. */
export const sameTab = (a: CommentTarget, b: CommentTarget) =>
  a.kind === 'doc' ? b.kind === 'doc' && a.docId === b.docId : a.kind === 'file' ? b.kind === 'file' && a.path === b.path : b.kind === 'browser' && a.url === b.url;
const wantKey = (w: { target: CommentTarget; passage: string }) => JSON.stringify([w.target, w.passage]);

export const paneFlash = {
  ask(w: Omit<PaneWant, 't'>) {
    want = { ...w, t: Date.now() };
    for (const l of listeners) l();
  },
  current: () => want,
  /** The view lit it (true) or could not find it (false). */
  done(w: PaneWant, found: boolean) {
    if (want === w) want = null;
    if (found) gone.delete(wantKey(w));
    else gone.add(wantKey(w));
    results++;
    for (const l of listeners) l();
  },
  gone: (target: CommentTarget, passage: string) => gone.has(wantKey({ target, passage })),
  listen(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

/** The jump waiting for this view (its target matches), if any; it re-renders when one is asked. */
export function usePaneFlash(match: ((t: CommentTarget) => boolean) | null): PaneWant | null {
  const w = useSyncExternalStore(paneFlash.listen, paneFlash.current, () => null);
  return w && match?.(w.target) ? w : null;
}
/** Re-renders on every jump's result (a chip's or card's « no longer there » tooltip). */
export function usePaneGone(): (target: CommentTarget, passage: string) => boolean {
  useSyncExternalStore(paneFlash.listen, () => results, () => 0);
  return paneFlash.gone;
}

/** A tool row to open for a jump (#368): its row and its « N steps » group open while the id is wanted (2 s). */
let stepWant: string | null = null;
let stepTimer: ReturnType<typeof setTimeout> | null = null;
const stepListeners = new Set<() => void>();
const stepListen = (l: () => void) => {
  stepListeners.add(l);
  return () => void stepListeners.delete(l);
};
export function openStep(id: string) {
  stepWant = id;
  for (const l of stepListeners) l();
  if (stepTimer) clearTimeout(stepTimer);
  stepTimer = setTimeout(() => {
    stepWant = null;
    for (const l of stepListeners) l();
  }, 2000);
}
/** True while one of these steps is wanted open. */
export function useStepWanted(ids: string[]): boolean {
  const w = useSyncExternalStore(stepListen, () => stepWant, () => null);
  return w !== null && ids.includes(w);
}
