import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Coherence pass 3/5 (#403): one working mark per meaning and one empty state. An agent at work is `.live-fly`, a task
 * status its StatusIcon, anything else in progress `.step-sq`; the round spinners and the old squares are gone. Every
 * empty state renders through <EmptyState> (Kit.tsx), never a hand-made `.state-empty`.
 */
const SRC = __dirname;
const sources = readdirSync(SRC)
  .filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
  .map((f) => [f, readFileSync(join(SRC, f), 'utf8')] as const);

describe('working marks and empty states (#403)', () => {
  it('no round spinner or old working square is left', () => {
    for (const [f, s] of sources) {
      expect(s, f).not.toMatch(/className="(spin|chat-row-spin|wb-spin|live-sq|pulse|wb-live)"/);
      expect(s, f).not.toMatch(/\.(spin|chat-row-spin|wb-spin|live-sq|pulse|wb-live)(?![\w-])/);
    }
  });

  it('only <EmptyState> draws an empty state', () => {
    const raw = sources.filter(([f, s]) => f !== 'Kit.tsx' && f.endsWith('.tsx') && /state-empty/.test(s)).map(([f]) => f);
    expect(raw).toEqual([]);
  });

  it('<EmptyState> takes a title and at most one action, no description', () => {
    const kit = sources.find(([f]) => f === 'Kit.tsx')![1];
    const sig = kit.slice(kit.indexOf('export function EmptyState'), kit.indexOf('{', kit.indexOf(') {', kit.indexOf('export function EmptyState'))));
    expect(sig).toContain('title: ReactNode');
    expect(sig).not.toContain('children');
    expect(sources.filter(([, s]) => /<EmptyState[^>]*>[^<]*\S[^<]*<\/EmptyState>/.test(s)).map(([f]) => f)).toEqual([]);
  });
});
