/**
 * Memory and schedule tools in the chat (#64, mockup pages/chat-activity.html §5): the pure part. Reads the engine's
 * tool outputs (teamTools.ts).
 */

/** memory_edit: what it did, for the quote's footer: « appended · own memory ». */
export function memoryFoot(input: unknown): string {
  const o = (input ?? {}) as { mode?: unknown; scope?: unknown };
  return `${o.mode === 'replace' ? 'replaced' : 'appended'} · ${o.scope === 'shared' ? 'shared memory' : 'own memory'}`;
}

export interface ScheduleLine {
  id: string;
  agent: string;
  title: string;
  when: string;
  /** « next 2026-… · own card #12 · LAST RUN FAILED: … » */
  more: string;
  failed: boolean;
}

/** schedule_list output (ids sch_… or, since #170, wf_…): « sch_x @atlas "title": when · next … · … » per line. */
export function scheduleList(out: string): ScheduleLine[] {
  return out.split('\n').flatMap((l) => {
    const m = /^((?:sch|wf)_\w+) @(\S+) "(.*)": (.*)$/.exec(l.trim());
    if (!m) return [];
    const [when, ...more] = m[4]!.split(' · ');
    return [{ id: m[1]!, agent: m[2]!, title: m[3]!, when: when!, more: more.join(' · '), failed: more.some((p) => p.startsWith('LAST RUN FAILED')) }];
  });
}

/** schedule_create output: « scheduled sch_x "title" for @atlas: when, first run ISO ». */
export function scheduleCreated(out: string): { id: string; title: string; agent: string; when: string; first: string } | null {
  const m = /^scheduled ((?:sch|wf)_\w+) "(.*)" for @(\S+): (.*), first run (\S+)$/.exec(out.trim());
  return m ? { id: m[1]!, title: m[2]!, agent: m[3]!, when: m[4]!, first: m[5]! } : null;
}

/** "2026-11-12T00:35:00+01:00" → "Thu 12 Nov 00:35" (local time); anything else as is. */
export function whenText(iso: string): string {
  const d = new Date(iso);
  if (!/^\d{4}-\d\d-\d\dT/.test(iso) || Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  return `${day} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Every ISO time in a line made readable: « once at 2026-11-12T00:35:00.000Z » → « once at Thu 12 Nov 01:35 ». */
export const humanTimes = (s: string) => s.replace(/\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)?/g, whenText);
