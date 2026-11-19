import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #294: a page or raw file in a frame (side panel, Library tile) paints its own background. In dark theme the frame
 * inherits `color-scheme: dark`, so a raw JSON or text file (and any page declaring `color-scheme: light dark`) renders
 * with light text on a transparent canvas: a literal white behind it made the text invisible. The frames and the
 * boxes around them only take theme tokens.
 */
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** [selector, declarations] of every rule whose selector names a frame or a tile preview box. */
const frameRules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => [m[1]!.trim(), m[2]!] as const)
  .filter(([sel]) => /\.doc-frame\b|\.lib-pv(?![\w-])|iframe/.test(sel));

describe('frame backgrounds (#294)', () => {
  it('finds the frame rules', () => {
    expect(frameRules.some(([sel]) => sel.includes('.doc-frame'))).toBe(true);
    expect(frameRules.some(([sel]) => /\.lib-pv(?![\w-])/.test(sel))).toBe(true);
  });

  it('never puts a literal colour behind a frame', () => {
    const bad = frameRules.flatMap(([sel, body]) =>
      [...body.matchAll(/background(?:-color)?\s*:\s*([^;]+)/g)]
        .map((m) => m[1]!.trim())
        .filter((v) => !/^(var\(--[\w-]+\)|transparent|none)$/.test(v))
        .map((v) => `${sel} { background: ${v} }`),
    );
    expect(bad).toEqual([]);
  });
});
