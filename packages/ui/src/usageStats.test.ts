import { describe, expect, it } from 'vitest';
import type { UsageSummary } from '@atlas/shared';
import { axisTicks, dayTotal, tok, usageHeadline } from './usageStats.ts';

const day = (d: string, p: Partial<Omit<UsageSummary['perDay'][number], 'day'>> = {}) => ({ day: d, anthropic: 0, chatgpt: 0, claude_plan: 0, claude_code: 0, openai_compat: 0, ...p });
const count = (calls: number, input: number, output: number) => ({ calls, input, output });

// The shape seen on 19 Nov 2026 (#228): today all on the Claude plan, the headline said « 0 · 43 calls ».
const summary: UsageSummary = {
  days: 3,
  perDay: [day('2026-11-17', { anthropic: 500 }), day('2026-11-18', { claude_code: 40 }), day('2026-11-19', { claude_plan: 2_400_000 + 677_000, chatgpt: 30 })],
  models: [
    { modelId: 'claude-opus', provider: 'claude_plan', today: count(30, 2_300_000, 100_000), week: count(30, 2_300_000, 100_000), month: count(30, 2_300_000, 100_000) },
    { modelId: 'claude-sonnet', provider: 'claude_plan', today: count(12, 600_000, 77_000), week: count(12, 600_000, 77_000), month: count(12, 600_000, 77_000) },
    { modelId: 'gpt', provider: 'chatgpt', today: count(1, 20, 10), week: count(1, 20, 10), month: count(1, 20, 10) },
    { modelId: 'old', provider: 'anthropic', today: count(0, 0, 0), week: count(3, 500, 0), month: count(3, 500, 0) },
  ],
  total: { calls: 46, input: 2_900_520, output: 177_010, cached: 0 },
};

describe('usageHeadline', () => {
  it('« Today » equals the sum of the table\'s Today column, every source counted', () => {
    const h = usageHeadline(summary);
    const table = summary.models.reduce((a, m) => a + m.today.input + m.today.output, 0);
    expect(h.today).toBe(table);
    expect(h.today).toBe(3_077_030);
    expect(h.todayCalls).toBe(43);
  });
  it('peak, active days and the chart scale count the plan and the removed integration too', () => {
    const h = usageHeadline(summary);
    expect(h).toMatchObject({ peak: 3_077_030, max: 3_077_030, active: 3 });
    expect(dayTotal(summary.perDay[1]!)).toBe(40);
  });
  it('an empty range gives zeros, and a chart scale of 1', () => {
    expect(usageHeadline({ days: 1, perDay: [day('2026-11-19')], models: [], total: { calls: 0, input: 0, output: 0, cached: 0 } })).toEqual({ today: 0, todayCalls: 0, peak: 0, active: 0, max: 1 });
  });
});

describe('tok', () => {
  it('writes billions as B', () => {
    expect(tok(999)).toBe('999');
    expect(tok(1234)).toBe('1.2k');
    expect(tok(3_400_000)).toBe('3.4M');
    expect(tok(999_000_000)).toBe('999M');
    expect(tok(1_266_000_000)).toBe('1.27B');
    expect(tok(12_340_000_000)).toBe('12.3B');
  });
});

describe('axisTicks', () => {
  it('labels today and every 7 days back, at each column\'s centre', () => {
    const days = Array.from({ length: 30 }, (_, i) => `d${i}`);
    const t = axisTicks(days, (d) => d.toUpperCase());
    expect(t.map((x) => x.label)).toEqual(['D1', 'D8', 'D15', 'D22', 'Today']);
    expect(t[4]!.at).toBeCloseTo((29.5 / 30) * 100);
    expect(t[0]!.at).toBeCloseTo((1.5 / 30) * 100);
  });
});
