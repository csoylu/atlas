import { useLayoutEffect, type RefObject } from 'react';

/** Share of the visible window height a composer may take before it scrolls inside (#102). */
export const GROW_MAX_SHARE = 0.4;

/** Height for a textarea whose content needs `content` px: at least its CSS min-height, at most `max`. */
export function grownHeight(content: number, min: number, max: number): number {
  return Math.max(min, Math.min(content, Math.max(min, max)));
}

/**
 * The textarea grows with its text (from its CSS min-height) up to 40% of the visible window,
 * then scrolls inside; it shrinks back when the text gets shorter (after sending). The visual
 * viewport is used so that on a phone the open keyboard leaves room for the send button.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, text: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const view = window.visualViewport?.height ?? window.innerHeight;
      const max = Math.round(view * GROW_MAX_SHARE);
      el.style.height = 'auto'; // measure the text, not the current box
      const min = parseFloat(getComputedStyle(el).minHeight) || 0;
      const content = el.scrollHeight; // border-box, padding included, no border on the composer
      const h = grownHeight(content, min, max);
      el.style.height = `${h}px`;
      el.style.overflowY = content > h ? 'auto' : 'hidden';
    };
    fit();
    const vv = window.visualViewport;
    window.addEventListener('resize', fit);
    vv?.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
      vv?.removeEventListener('resize', fit);
    };
  }, [ref, text]);
}
