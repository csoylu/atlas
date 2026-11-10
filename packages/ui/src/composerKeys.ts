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
