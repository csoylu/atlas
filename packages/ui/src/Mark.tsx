import { useEffect, useId, useState } from 'react';
import { markLabel, type MarkState } from './markState.ts';

/**
 * The Atlas mark, F1 Living Orb (#310, paris's « pages/atlas-icon.html » v23): a glass orb with light swirling inside.
 * Source drawings: apps/desktop/icon/*.svg (mark.svg = the still mark; the layers below are its parts).
 *
 * Animated (the sidebar): four stacked layers, base · glow · swirl · badge, moved by CSS transform and opacity only
 * (styles.css, « Living Orb mark »). Still (`state` omitted: the login screen) = the same layers, no animation.
 * prefers-reduced-motion keeps it still; while the window is hidden every animation is paused.
 * Colours: the two accent tokens (--accent-dark, --accent-light: the same in both themes, it is the app's icon),
 * violet and amber from the icon's palette, the night tile.
 */
export function Mark({ size = 20, state }: { size?: number; state?: MarkState }) {
  const u = useId().replace(/:/g, '');
  const hidden = useHidden();
  const live = !!state;
  const cls = 'lv' + (live ? ' st-' + state : ' lv-still') + (hidden ? ' lv-paused' : '');
  return (
    <span className={cls} style={{ ['--s' as string]: size + 'px' }} role={live ? 'img' : undefined} aria-label={live ? markLabel(state) : undefined} aria-hidden={live ? undefined : true} title={live ? markLabel(state) : undefined} data-state={state}>
      <span className="lv-tile">
        <svg className="lv-l" viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <radialGradient id={u + 'b'} cx=".5" cy=".55" r=".6">
              <stop offset="0" stopColor="var(--accent-light)" />
              <stop offset="1" stopColor="#0b1a2a" />
            </radialGradient>
          </defs>
          <rect width="100" height="100" fill="#05080c" />
          <circle cx="50" cy="50" r="36" fill={`url(#${u}b)`} />
        </svg>
        <span className="lv-l lv-halo" />
        <svg className="lv-l lv-spin" viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <clipPath id={u + 'c'}>
              <circle cx="50" cy="50" r="36" />
            </clipPath>
            <filter id={u + 'f'} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" />
            </filter>
          </defs>
          <g clipPath={`url(#${u}c)`}>
            <g filter={`url(#${u}f)`}>
              <path d="M12 58 C 26 32 48 70 78 40 L 88 62 C 68 80 42 52 18 82 Z" fill="var(--accent-dark)" />
              <path d="M20 30 C 36 18 56 42 74 26 L 80 38 C 62 52 46 32 26 46 Z" fill="#8b7cf6" />
              <ellipse cx="64" cy="70" rx="18" ry="9" fill="#f5b971" />
            </g>
          </g>
        </svg>
      </span>
      {live && <i className="lv-badge" />}
    </span>
  );
}

/** True while the page is hidden (window minimised, another Space, tab in the background): the mark pauses. */
function useHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}
