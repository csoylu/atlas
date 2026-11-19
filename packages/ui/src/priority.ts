/**
 * Priority names (#265, approved by Master 19 Nov 2026): the engine keeps 0–3 (higher runs first: `ORDER BY priority
 * DESC`), the interface never prints « P2 », only these names.
 */
export const PRIORITY_NAME = ['None', 'Low', 'Medium', 'High'] as const;
const RUNS = ['runs last', 'runs after Medium', 'runs after High', 'runs first'];

/** « High » for 3, « None » for 0; an unknown value is shown as it is, never hidden. */
export const priorityName = (p: number): string => PRIORITY_NAME[p] ?? String(p);

/** The mark's tooltip: « Priority High: runs first ». */
export const priorityHint = (p: number): string => `Priority ${priorityName(p)}${RUNS[p] ? ': ' + RUNS[p] : ''}`;

/** Highest first, as the menus list them. */
export const PRIORITIES = [3, 2, 1, 0] as const;
