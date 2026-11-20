import { useSyncExternalStore } from 'react';
import type { WsFile } from '@atlas/shared';

/**
 * Unsaved edits of the Files tab (#303), kept while the app runs: switching tabs (or hiding the pane) keeps them, the
 * tab shows a dot, closing it asks first. Keyed by chat and path. Never stored: a reload loses them, like an editor
 * without autosave (the tab asks before closing; the window's own unload asks too, see FilesPane).
 */
export interface Draft {
  /** The file as loaded (or as last saved / taken): its hash is the save's base. */
  file: WsFile;
  /** The editor's text when it differs from `file.content`, else null (saved). */
  text: string | null;
  /** The agent wrote or deleted the file while it had unsaved edits: the banner decides (never a silent overwrite). */
  conflict: { kind: 'changed'; theirs: WsFile; at: number } | { kind: 'deleted'; at: number } | null;
}

const drafts = new Map<string, Draft>();
const subs = new Set<() => void>();
let version = 0;
const key = (chatId: string, path: string) => chatId + '\n' + path;

function emit() {
  version++;
  for (const s of subs) s();
}

export const fileDrafts = {
  get: (chatId: string, path: string): Draft | undefined => drafts.get(key(chatId, path)),
  set(chatId: string, path: string, d: Draft) {
    drafts.set(key(chatId, path), d);
    emit();
  },
  update(chatId: string, path: string, f: (d: Draft) => Draft) {
    const d = drafts.get(key(chatId, path));
    if (d) this.set(chatId, path, f(d));
  },
  drop(chatId: string, path: string) {
    if (drafts.delete(key(chatId, path))) emit();
  },
  dirty: (chatId: string, path: string): boolean => drafts.get(key(chatId, path))?.text != null,
  /** Any unsaved edit anywhere (the window's « leave the page? »). */
  anyDirty: (): boolean => [...drafts.values()].some((d) => d.text !== null),
  subscribe(f: () => void) {
    subs.add(f);
    return () => void subs.delete(f);
  },
};

/** Re-renders on every change of the drafts (the tabs' unsaved dots, the bar's state). */
export function useDrafts(): number {
  return useSyncExternalStore(fileDrafts.subscribe, () => version);
}
