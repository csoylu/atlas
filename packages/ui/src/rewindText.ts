import type { FileChange, SideEffect } from '@atlas/shared';

/** The stop reason of a run ended by a rewind (engine rewind.ts). */
export const REWOUND = 'rewound by you';

/** « 3 files restored », « 1 file restored », « no files changed »: honest, files only. */
export function filesLine(files: FileChange[]): string {
  if (!files.length) return 'no files changed';
  return `${files.length} ${files.length === 1 ? 'file' : 'files'} restored`;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** How each kind of side effect starts its line (#138). */
export const EFFECT_KIND: Record<SideEffect['kind'], string> = {
  task: 'Task',
  task_change: 'Task changed',
  message: 'Message to',
  memory: 'Memory',
  memory_change: 'Memory',
  schedule: 'Schedule',
  schedule_delete: 'Schedule deleted',
  canvas: 'Canvas',
  push: 'Pushed',
};

const UNDONE_NOUN: Partial<Record<SideEffect['kind'], [string, string]>> = {
  task: ['task', 'tasks'],
  message: ['message', 'messages'],
  memory: ['memory', 'memories'],
  schedule: ['schedule', 'schedules'],
};

/**
 * What a rewind did besides files, in a few words (#138): « 1 task closed · 3 more undone · 2 kept ». Empty when the
 * rewound part did nothing elsewhere.
 */
export function effectsLine(effects: SideEffect[]): string {
  const undone = effects.filter((e) => e.outcome === 'undone');
  const kept = effects.length - undone.length;
  const groups = new Map<string, { n: number; text: (n: number) => string }>();
  for (const e of undone) {
    const [one, many] = UNDONE_NOUN[e.kind] ?? ['thing', 'things'];
    const key = `${e.action}\0${one}`;
    const g = groups.get(key) ?? { n: 0, text: (n: number) => `${plural(n, one, many)} ${e.action}` };
    g.n++;
    groups.set(key, g);
  }
  const phrases = [...groups.values()];
  const parts = phrases.length > 2 ? [phrases[0]!.text(phrases[0]!.n), `${undone.length - phrases[0]!.n} more undone`] : phrases.map((g) => g.text(g.n));
  if (kept) parts.push(`${kept} kept`);
  return parts.join(' · ');
}

/**
 * The whole outcome of a rewind in one line (note and chat marker): the files part, then what else was undone or kept.
 * « no files changed » never stands alone when something else happened: the rest follows it.
 */
export function outcomeLine(filesPart: string, effects: SideEffect[]): string {
  const rest = effectsLine(effects);
  return rest ? `${filesPart} · ${rest}` : filesPart;
}
