import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card, Inbox } from '@atlas/shared';
import { markLabel, markState } from './markState.ts';
import { Mark } from './Mark.tsx';

const inbox = (n: number) => ({ needsYou: Array.from({ length: n }, () => ({})) }) as unknown as Pick<Inbox, 'needsYou'>;
const card = (status: Card['status']) => ({ status });

describe('the sidebar mark (#310, Living Orb)', () => {
  it('is idle with nothing running and nothing waiting for Master', () => {
    expect(markState([card('ready'), card('done')], [{ working: false }], inbox(0))).toBe('idle');
    expect(markState([], [], null)).toBe('idle');
  });
  it('works while a task runs or a chat answers', () => {
    expect(markState([card('running')], [], inbox(0))).toBe('work');
    expect(markState([], [{ working: true }], inbox(0))).toBe('work');
  });
  it('needs you as soon as the Inbox has one, even while agents work', () => {
    expect(markState([], [], inbox(1))).toBe('need');
    expect(markState([card('running')], [{ working: true }], inbox(2))).toBe('need');
  });
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
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.lv \* \{ animation: none !important; \} \}/);
    expect(css).toContain('.lv-paused, .lv-paused * { animation-play-state: paused !important; }');
  });
});
