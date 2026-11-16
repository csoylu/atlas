import type { KeyboardEvent } from 'react';

type ComposerKeyEvent = Pick<KeyboardEvent<HTMLTextAreaElement>, 'key' | 'shiftKey' | 'repeat' | 'preventDefault' | 'currentTarget'> & {
  nativeEvent: Pick<KeyboardEvent['nativeEvent'], 'isComposing' | 'keyCode'>;
};

/** Share the send shortcut across new chats and existing conversations. */
export function submitOnEnter(e: ComposerKeyEvent): void {
  // Safari can end composition before dispatching the final Enter; 229 still identifies that IME event.
  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
  e.preventDefault();
  if (!e.repeat) e.currentTarget.form?.requestSubmit();
}

/**
 * The keys of a rewind (card #34): Esc during a run rewinds the turn; ⌘Z (Ctrl+Z) undoes a rewind while the composer still holds the text it put back.
 * Inside a modal (card #78), Esc only closes the modal: it never rewinds; the card modal's Stop button stops a run.
 */
export type RewindKeyEvent = Pick<globalThis.KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'repeat' | 'defaultPrevented' | 'isComposing'>;

export function rewindKey(
  e: RewindKeyEvent,
  s: { running: boolean; undoable: boolean; text: string; filled: string | null; mac: boolean; inModal: boolean },
): 'rewind' | 'undo' | null {
  if (e.defaultPrevented || e.isComposing || e.repeat) return null;
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) return s.running && !s.inModal ? 'rewind' : null;
  const cmd = s.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (e.key.toLowerCase() === 'z' && cmd && !e.shiftKey && !e.altKey && s.undoable && s.filled !== null && s.text === s.filled) return 'undo';
  return null;
}
