import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { markLabel } from './markState.ts';
import { Mark } from './Mark.tsx';

describe('the Atlas mark (#310, Living Orb)', () => {
  it('draws the four layers, the state as a class and a label; still on the login screen', () => {
    const live = renderToStaticMarkup(createElement(Mark, { state: 'need' }));
    expect(live).toContain('class="lv st-need"');
    expect(live).toContain(`aria-label="${markLabel('need')}"`);
    for (const l of ['lv-tile', 'lv-halo', 'lv-spin', 'lv-badge']) expect(live).toContain(l);
    expect(live).toContain('--s:20px');
    const still = renderToStaticMarkup(createElement(Mark, { size: 28 }));
    expect(still).toContain('lv-still');
    expect(still).not.toContain('lv-badge');
    expect(still).toContain('aria-hidden="true"');
  });
  it('animates with transform and opacity only, and stops for reduced motion', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    const frames = [...css.matchAll(/@keyframes lv-[\w-]+ \{(.*)\}/g)].map((m) => m[1]!);
    expect(frames.length).toBeGreaterThanOrEqual(4);
    for (const f of frames) for (const prop of f.matchAll(/([a-z-]+):/g)) expect(['opacity', 'transform']).toContain(prop[1]);
    // #405: the one reduce-motion rule stops it with everything else.
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation: none !important; transition: none !important; \} \}/);
    expect(css).toContain('.lv-paused, .lv-paused * { animation-play-state: paused !important; }');
  });
});
