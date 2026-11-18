import type { UsageSummary } from '@atlas/shared';

type Day = UsageSummary['perDay'][number];

/** Every source a day can count, so no sum forgets one (#228: the headline skipped claude_plan). */
export const SOURCE_KEYS = ['anthropic', 'claude_plan', 'claude_code', 'chatgpt', 'openai_compat'] as const satisfies readonly (keyof Omit<Day, 'day'>)[];

/** 1234 → "1.2k", 3_400_000 → "3.4M", 1_266_000_000 → "1.27B". */
export const tok = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${+(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${+(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${+(n / 1e9).toFixed(n < 1e10 ? 2 : n < 1e11 ? 1 : 0)}B`;
};

/** Tokens (in + out) of one day, all sources. */
export const dayTotal = (d: Day): number => SOURCE_KEYS.reduce((a, k) => a + d[k], 0);

/** The headline numbers of Settings → Usage. */
export function usageHeadline(s: UsageSummary) {
  const totals = s.perDay.map(dayTotal);
  return {
    today: totals.at(-1) ?? 0,
    todayCalls: s.models.reduce((a, m) => a + m.today.calls, 0),
    peak: Math.max(0, ...totals),
    active: totals.filter((t) => t > 0).length,
    /** The chart's scale: the tallest column. */
    max: Math.max(1, ...totals),
  };
}

/**
 * Axis labels under the chart: today, then every 7 days back (« Nov 12 », « Nov 5 »…). `at` is the column's
 * centre in percent of the chart width.
 */
export function axisTicks(days: string[], label: (day: string) => string): { day: string; label: string; at: number }[] {
  const n = days.length;
  const ticks: { day: string; label: string; at: number }[] = [];
  for (let i = n - 1; i >= 0; i -= 7) ticks.unshift({ day: days[i]!, label: i === n - 1 ? 'Today' : label(days[i]!), at: ((i + 0.5) / n) * 100 });
  return ticks;
}
