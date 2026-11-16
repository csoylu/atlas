import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Unsent composer text, per conversation and per device (localStorage `atlas.draft.<kind>.<id>`), so switching views
 * or reloading never loses what the user was writing. UI state only: not in SQLite, no API.
 */
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const draftKey = (kind: 'card' | 'new', id = '') => `atlas.draft.${kind}${id ? '.' + id : ''}`;

/** Never throws: a missing, corrupt or unreadable entry reads as no draft. */
export function readDraft(key: string, store: Store = localStorage): string {
  try {
    const v: unknown = JSON.parse(store.getItem(key) ?? '""');
    return typeof v === 'string' ? v : '';
  } catch {
    return ''; // a corrupt entry is not worth an error: an empty composer is right
  }
}

/** Saves the text; an empty (or whitespace-only) draft removes its key so stale keys don't pile up. */
export function writeDraft(key: string, text: string, store: Store = localStorage): void {
  if (text.trim()) store.setItem(key, JSON.stringify(text));
  else store.removeItem(key);
}

export const clearDraft = (key: string, store: Store = localStorage) => store.removeItem(key);

/** useState for a composer whose text lives in its draft: restored on mount and when `key` changes, saved on change. */
export function useDraft(key: string): [string, Dispatch<SetStateAction<string>>] {
  const [state, setState] = useState(() => ({ key, text: readDraft(key) }));
  let text = state.text;
  if (state.key !== key) {
    // Another conversation in the same composer: show its own draft (adjusting state during render, React's pattern).
    text = readDraft(key);
    setState({ key, text });
  }
  useEffect(() => writeDraft(key, text), [key, text]);
  const set: Dispatch<SetStateAction<string>> = (v) =>
    // Bound to this render's conversation: a late update (a failed send) never lands in another one's draft.
    setState((s) => (s.key !== key ? s : { key, text: typeof v === 'function' ? v(s.text) : v }));
  return [text, set];
}
