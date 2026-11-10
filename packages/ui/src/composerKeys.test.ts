import { describe, expect, it, vi } from 'vitest';
import { submitOnEnter } from './composerKeys.ts';

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
