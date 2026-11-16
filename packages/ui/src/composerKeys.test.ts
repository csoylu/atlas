import { describe, expect, it, vi } from 'vitest';
import { rewindKey, submitOnEnter, type RewindKeyEvent } from './composerKeys.ts';

function event(overrides: Partial<Parameters<typeof submitOnEnter>[0]> = {}) {
  const requestSubmit = vi.fn();
  const preventDefault = vi.fn();
  return {
    key: 'Enter', shiftKey: false, repeat: false,
    nativeEvent: { isComposing: false, keyCode: 13 },
    currentTarget: { form: { requestSubmit } } as unknown as HTMLTextAreaElement,
    preventDefault,
    ...overrides,
  };
}

describe('composer Enter shortcut', () => {
  it('submits on Enter and prevents a trailing newline', () => {
    const e = event();
    submitOnEnter(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.currentTarget.form!.requestSubmit).toHaveBeenCalledOnce();
  });

  it.each([
    { shiftKey: true },
    { key: 'a' },
    { nativeEvent: { isComposing: true, keyCode: 13 } },
    { nativeEvent: { isComposing: false, keyCode: 229 } },
  ])('leaves newline, non-Enter, and IME input alone: %j', (overrides) => {
    const e = event(overrides);
    submitOnEnter(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.currentTarget.form!.requestSubmit).not.toHaveBeenCalled();
  });

  it('does not submit repeated keydown events', () => {
    const e = event({ repeat: true });
    submitOnEnter(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.currentTarget.form!.requestSubmit).not.toHaveBeenCalled();
  });
});

describe('rewind keys', () => {
  const key = (o: Partial<RewindKeyEvent> = {}): RewindKeyEvent => ({ key: 'Escape', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false, isComposing: false, ...o });
  const idle = { running: false, undoable: false, text: '', filled: null, mac: true, inModal: false };

  it('Esc rewinds the turn while a run is going, and does nothing on an idle chat', () => {
    expect(rewindKey(key(), { ...idle, running: true })).toBe('rewind');
    expect(rewindKey(key(), idle)).toBeNull();
  });

  it('never rewinds from inside a modal: Esc there only closes it (card #78)', () => {
    expect(rewindKey(key(), { ...idle, running: true, inModal: true })).toBeNull();
    // ⌘Z still undoes a rewind in the card modal's composer.
    expect(rewindKey(key({ key: 'z', metaKey: true }), { ...idle, inModal: true, undoable: true, text: 'x', filled: 'x' })).toBe('undo');
  });

  it('leaves Esc alone when something else handled it, while composing, held down or with a modifier', () => {
    const running = { ...idle, running: true };
    expect(rewindKey(key({ defaultPrevented: true }), running)).toBeNull();
    expect(rewindKey(key({ isComposing: true }), running)).toBeNull();
    expect(rewindKey(key({ repeat: true }), running)).toBeNull();
    expect(rewindKey(key({ shiftKey: true }), running)).toBeNull();
  });

  it('⌘Z undoes while the composer holds exactly the text the rewind put back', () => {
    const after = { ...idle, undoable: true, text: 'fix the build', filled: 'fix the build' };
    expect(rewindKey(key({ key: 'z', metaKey: true }), after)).toBe('undo');
    expect(rewindKey(key({ key: 'Z', metaKey: true }), after)).toBe('undo'); // caps lock
    // Edited since: ⌘Z is the text field's own undo.
    expect(rewindKey(key({ key: 'z', metaKey: true }), { ...after, text: 'fix the build!' })).toBeNull();
    // Toast gone (no undo left), redo, or the wrong modifier for the platform.
    expect(rewindKey(key({ key: 'z', metaKey: true }), { ...after, undoable: false })).toBeNull();
    expect(rewindKey(key({ key: 'z', metaKey: true, shiftKey: true }), after)).toBeNull();
    expect(rewindKey(key({ key: 'z', ctrlKey: true }), after)).toBeNull();
    expect(rewindKey(key({ key: 'z', ctrlKey: true }), { ...after, mac: false })).toBe('undo');
  });
});
