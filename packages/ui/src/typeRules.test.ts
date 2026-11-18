import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The UI type rules (CLAUDE.md « UI type rules », #112): every font-size, font-weight, line-height and font-family in
 * packages/ui/src goes through the tokens in styles.css; nothing under 13 px; text colours for information reach 4.5:1
 * on the surfaces in both themes. Rules without a test drift.
 */
const SRC = __dirname;
const CSS = readFileSync(join(SRC, 'styles.css'), 'utf8');
const TOKENS_START = CSS.indexOf('/* type tokens');
const TOKENS_END = CSS.indexOf('/* end type tokens */');

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

/** A value that is a token (var(--…)), a keyword, or made of them. */
const tokenOnly = (v: string) => v.replace(/var\(--[\w-]+\)/g, '').replace(/\b(inherit|initial|unset|normal)\b|!important/g, '').replace(/[\s/]/g, '') === '';

/** Literal type declarations in a CSS text: [line, declaration]. A line marked « type-exception: why » is allowed. */
function literals(css: string, offset = 0): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const lines = css.split('\n');
  lines.forEach((line, i) => {
    if (/type-exception:\s*\S/.test(line)) return;
    for (const m of line.matchAll(/(?<![\w-])(font-size|font-weight|line-height|font-family|font)\s*:\s*([^;}]+)/g)) {
      const [, prop, raw] = m as unknown as [string, string, string];
      const value = raw.replace(/\/\*.*?\*\//g, '').trim();
      // font shorthand: tokens plus the family tokens; nothing literal.
      if (!tokenOnly(value)) out.push([offset + i + 1, `${prop}: ${value}`]);
    }
  });
  return out;
}

describe('UI type rules', () => {
  it('has the token block', () => {
    expect(TOKENS_START).toBeGreaterThan(0);
    expect(TOKENS_END).toBeGreaterThan(TOKENS_START);
    const block = CSS.slice(TOKENS_START, TOKENS_END);
    for (const t of ['--fs-small: 13px', '--fs-base: 14px', '--fs-large: 16px', '--fs-xl: 20px', '--fw-regular: 440', '--fw-medium: 530', '--fw-bold: 670', '--lh-tight: 130%', '--lh-normal: 150%', '--lh-long: 180%'])
      expect(block).toContain(t);
  });

  it('styles.css uses only tokens for font-size, font-weight, line-height and font-family (outside the token block)', () => {
    const before = CSS.slice(0, TOKENS_START);
    const after = CSS.slice(TOKENS_END);
    const afterLine = CSS.slice(0, TOKENS_END).split('\n').length - 1;
    // The family tokens themselves (--font, --mono) are the one place a family is named.
    const bad = [...literals(before), ...literals(after, afterLine)].filter(([, d]) => !/^font-family: var\(--(font|mono)\)$/.test(d));
    expect(bad).toEqual([]);
  });

  it('the allowed exceptions say why, and no text is under 13 px except them', () => {
    for (const line of CSS.split('\n').filter((l) => /type-exception/.test(l))) {
      expect(line).toMatch(/type-exception:\s*\S{3,}/);
      expect(line).toMatch(/font-size: (16px|1[0-2]px)/);
    }
  });

  it('@font-face lives in one place only (the fontsource imports in main.tsx)', () => {
    const faces = files(SRC).filter((f) => /\.(css|tsx?)$/.test(f) && !f.endsWith('.test.ts') && /@font-face/.test(readFileSync(f, 'utf8')));
    expect(faces).toEqual([]);
    expect(readFileSync(join(SRC, 'main.tsx'), 'utf8')).toMatch(/@fontsource/);
  });

  it('no literal font styles inline in tsx', () => {
    const bad: string[] = [];
    // The HTML renderer's starter page runs in its own sandboxed iframe (a user document, not Atlas UI): no tokens there.
    const EXEMPT = ['canvas/renderers/html.tsx'];
    for (const f of files(SRC).filter((f) => f.endsWith('.tsx') && !EXEMPT.includes(f.slice(SRC.length + 1)))) {
      const src = readFileSync(f, 'utf8');
      // style={{ fontSize: 13 }}, fontWeight, lineHeight, fontFamily, and SVG attributes fontSize="…"
      for (const m of src.matchAll(/\b(fontSize|fontWeight|lineHeight|fontFamily)\s*[:=]\s*([^,}\n]+)/g)) {
        if (!/var\(--/.test(m[2]!)) bad.push(`${f.slice(SRC.length + 1)}: ${m[0]}`);
      }
      // CSS inside template strings (e.g. an iframe's <style>)
      for (const [line, d] of literals(src)) bad.push(`${f.slice(SRC.length + 1)}:${line}: ${d}`);
    }
    expect(bad).toEqual([]);
  });
});

// ── Contrast ─────────────────────────────────────────────────────────────────────────────────────────────────────────
type Theme = Record<string, string>;
/** The custom properties set at the top level for :root (dark, the default) and for :root[data-theme='light']. */
function themes(): { dark: Theme; light: Theme } {
  const top = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '');
  const dark: Theme = {};
  const light: Theme = {};
  for (const m of top.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sels = m[1]!.split(',').map((s) => s.trim());
    const props = [...m[2]!.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((p) => [p[1]!, p[2]!.trim()] as const);
    const isLight = sels.includes(":root[data-theme='light']");
    const isDark = sels.includes(':root') || sels.includes(":root[data-theme='dark']");
    for (const [k, v] of props) {
      if (isDark) dark[k] = v;
      if (isLight) light[k] = v;
    }
  }
  return { dark, light: { ...dark, ...light } };
}
function resolve(t: Theme, v: string, seen = 0): string {
  const m = /^var\(--([\w-]+)\)$/.exec(v);
  return m && seen < 5 ? resolve(t, t[m[1]!]!, seen + 1) : v;
}
function rgb(v: string, under: number[] = [0, 0, 0]): number[] {
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  const p = /rgba?\(([^)]*)\)/.exec(v)![1]!.split(',').map(Number);
  const a = p[3] ?? 1;
  return [0, 1, 2].map((i) => p[i]! * a + under[i]! * (1 - a));
}
const lum = (c: number[]) => {
  const [r, g, b] = c.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: number[], b: number[]) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

describe('text contrast (4.5:1 for information, both themes)', () => {
  const { dark, light } = themes();
  // Text colours that carry information; placeholders and disabled text may stay lower (not listed).
  const TEXT = ['text', 'muted', 'faint', 'accent', 'neg-ink', 'warn-ink', 'pos-ink'];
  const SURFACES = ['app', 'panel', 'raised'];
  // Inks on their own tint (chips, notices), the tint laid over the panel.
  const PAIRS: Array<[string, string]> = [['wk-ink', 'wk-bg'], ['bk-ink', 'bk-bg'], ['dn-ink', 'dn-bg'], ['neg-ink', 'neg-bg'], ['warn-ink', 'warn-bg'], ['pos-ink', 'pos-bg'], ['bk-ink', 'panel'], ['bk-ink', 'raised']];
  for (const [name, t] of [['dark', dark], ['light', light]] as const) {
    it(`${name}: text tokens on every surface`, () => {
      const low: string[] = [];
      for (const fg of TEXT)
        for (const bg of SURFACES) {
          const b = rgb(resolve(t, t[bg]!));
          const r = contrast(rgb(resolve(t, t[fg]!), b), b);
          if (r < 4.5) low.push(`--${fg} on --${bg}: ${r.toFixed(2)}`);
        }
      expect(low).toEqual([]);
    });
    it(`${name}: inks on their tints`, () => {
      const low: string[] = [];
      const panel = rgb(resolve(t, t.panel!));
      for (const [fg, bg] of PAIRS) {
        const b = rgb(resolve(t, t[bg]!), panel);
        const r = contrast(rgb(resolve(t, t[fg]!), b), b);
        if (r < 4.5) low.push(`--${fg} on --${bg}: ${r.toFixed(2)}`);
      }
      expect(low).toEqual([]);
    });
  }
});
