import type { CSSProperties } from 'react';

/**
 * Each agent gets its own pale tint (avatar, @name on cards): identity, not data. Hues are handed out in agent order
 * from a list arranged so the first agents sit far apart on the wheel (the first four are 70°+ apart); an agent the
 * list doesn't know yet falls back to a hash of its name. No violet (house rule), no teal (the accent = "running").
 * styles.css sets saturation and lightness per theme.
 */
const PALETTE = [210, 25, 140, 335, 75, 185, 0, 105, 45, 240];
let order: string[] = [];
export function registerAgents(ids: string[]) {
  order = [...ids].sort();
}
export function agentHue(id: string): number {
  const i = order.indexOf(id);
  if (i >= 0) return PALETTE[i % PALETTE.length]!;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
export function tint(id: string): CSSProperties {
  return { '--hue': agentHue(id) } as CSSProperties;
}
