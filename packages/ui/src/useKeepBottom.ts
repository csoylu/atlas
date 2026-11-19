import { useEffect, type RefObject } from 'react';

/**
 * A scroller that was at its bottom stays there when its own height changes (the toast row appearing above it on a
 * phone, #265; the composer growing). Scrolled up, it keeps its scrollTop: the same messages stay in view.
 */
export function useKeepBottom(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const near = () => el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    let atBottom = near();
    let height = el.clientHeight;
    const onScroll = () => {
      // A scroll caused by the resize itself is not the user's: judge only when the height is unchanged.
      if (el.clientHeight === height) atBottom = near();
    };
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === height) return;
      height = el.clientHeight;
      if (atBottom) el.scrollTop = el.scrollHeight;
    });
    el.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [ref]);
}
