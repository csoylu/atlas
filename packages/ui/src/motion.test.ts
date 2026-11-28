import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Coherence pass 5/5 (#405): one motion family. Durations are the tokens --t-1/2/3/loop (--fast = --t-2), easings
 * --ease, --ease-io or --ease-lin; three shared keyframes plus the four that draw (fly, fly-flash, blink, the lv-*
 * mark); one reduce-motion rule. The Living Orb mark (.lv) keeps its own timings, the overshoot curve stays in fly.
 */
const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
const KEPT = ['x-in', 'x-pulse', 'x-flash', 'fly', 'fly-flash', 'blink', 'lv-breath', 'lv-breath-fast', 'lv-spin', 'lv-knock'];

/** Every `animation` / `transition` declaration value, with the selector it sits in. */
function declarations(): { sel: string; prop: string; value: string }[] {
  const out: { sel: string; prop: string; value: string }[] = [];
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const d of rule[2]!.matchAll(/(?:^|;)\s*((?:-webkit-)?(?:animation|transition)(?:-[a-z-]+)?)\s*:\s*([^;]+)/g))
      out.push({ sel: rule[1]!.trim(), prop: d[1]!, value: d[2]!.trim() });
  }
  return out;
}

describe('motion tokens (#405)', () => {
  it('defines the four durations and three easings', () => {
    for (const t of ['--t-1: 120ms', '--t-2: 160ms', '--t-3: 240ms', '--t-loop: 1.6s', '--fast: var(--t-2) var(--ease)', '--ease-io: cubic-bezier(0.45, 0, 0.55, 1)', '--ease-lin: linear'])
      expect(css).toContain(t);
  });

  it('keeps only the keyframes of the motion spec', () => {
    const names = [...css.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]!);
    expect(names.filter((n) => !KEPT.includes(n))).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
    const used = declarations().filter((d) => d.prop === 'animation' && !d.value.startsWith('none')).map((d) => d.value.split(/\s+/)[0]!);
    for (const n of used) expect(KEPT, n).toContain(n);
  });

  it('every duration and easing is a token (the .lv mark and fly’s overshoot aside)', () => {
    const bad = declarations()
      .filter((d) => !/^\.st-(idle|work|need) \.lv-/.test(d.sel))
      .filter((d) => !['animation-play-state', 'animation-iteration-count'].includes(d.prop) && !d.value.startsWith('none') && d.value !== '0s')
      .map((d) => ({ ...d, bare: d.value.replace(/calc\([^)]*\)|var\(--[\w-]+\)/g, '').replace(d.sel === '.live-fly i' ? 'cubic-bezier(0.34, 1.4, 0.5, 1)' : /^$/, '') }))
      .filter((d) => /\d*\.?\d+m?s\b|\b(ease|ease-in|ease-out|ease-in-out|linear)\b|cubic-bezier/.test(d.bare))
      .map(({ sel, value }) => `${sel}: ${value}`);
    expect(bad).toEqual([]);
  });

  it('has one reduce-motion rule, which stops everything', () => {
    const rules = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([^}]*\}) \}/g)];
    expect(css.match(/prefers-reduced-motion/g)).toHaveLength(1);
    expect(rules[0]![1]!.trim()).toBe('*, *::before, *::after { animation: none !important; transition: none !important; }');
  });

  it('the TSX keeps no hand-typed timing', () => {
    for (const f of readdirSync(__dirname).filter((f) => f.endsWith('.tsx'))) {
      const s = readFileSync(join(__dirname, f), 'utf8');
      expect(s, f).not.toMatch(/(transition|animation)['"]?\s*:\s*['"][^'"]*\d+m?s\b/);
    }
  });
});
