import { RESUME_KICK, TRIAGE_KICK, USER, WORK_KICK, type EndedRun, type FileChange, type Message, type RewindEvent, type Timeline } from '@atlas/shared';
import type { RowTone } from './chatRow.ts';
import { REWOUND } from './rewindText.ts';
import type { RowIcon } from './toolRows.ts';

/**
 * System events as standalone rows between turns (#66, docs/chat-activity.md §1 « System », mockup §7): the prompts that
 * start a run, messages from other cards, scheduled runs, and what the timeline adds (stopped, failed, interrupted runs,
 * rewinds, the context summary point). Pure, so every event is unit-tested. The agent still got the full text; only the
 * display changes. Card reports (#58, chatRow.ts parseReport) are not here.
 */

export interface SysRow {
  /** Stable React key. */
  key: string;
  icon: RowIcon;
  tone: RowTone;
  verb: string;
  /** A card the row is about ("#58"): a link before the object (its title fills the object when known). */
  ref?: string;
  object?: string;
  mono?: boolean;
  rest?: string;
  meta?: string;
  /** ISO time at the right. */
  at?: string;
  body?: SysBody;
  /** Opens expanded (a failed last run, with its Retry). */
  open?: boolean;
}

export type SysBody =
  | { kind: 'markdown'; text: string }
  /** The run's error, then Retry when it is the latest run and nothing runs. */
  | { kind: 'error'; text: string; retry: boolean; agent: string }
  /** What a rewind put back, then Undo while it still works. */
  | { kind: 'files'; files: FileChange[]; error: string | null; undoId: string | null };

const firstLine = (s: string) => s.trim().split('\n')[0]!.trim();
const plain = (s: string) => firstLine(s).replace(/\*\*|`/g, '');
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const textOf = (m: Message) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
const quoted = (s: string) => `“${s}”`;

/** The engine's note that memory changed mid-conversation (memory.ts memoryDeltaNote). */
const MEMORY_NOTE = '[memory] ';
const FROM = /^\[from @([\w.-]+), (?:card|task) (#\d+|c_[0-9a-f]{8})\]\s*([\s\S]*)$/;
const SCHEDULE = /\n\n— from schedule (\S+?), ([\s\S]*?)\.?\s*$/;

/**
 * The row for a message the agent received from someone other than the user (a start prompt, a card's message, a
 * schedule), or null: it stays as it is (the user's own messages, card reports, other system notes).
 * `assignee`: the card's agent (« card assigned to @x »).
 */
export function messageRow(m: Message, assignee: string | null): SysRow | null {
  if (m.role !== 'user' || m.author === USER || m.author === 'tool') return null;
  const text = textOf(m).trim();
  const base = { key: m.id, at: m.at };
  if (m.author === 'system') {
    if (text === WORK_KICK) return { ...base, icon: 'play', tone: 'plain', verb: 'Started', object: assignee ? `task assigned to @${assignee}` : 'the task', rest: quoted(text) };
    if (text === TRIAGE_KICK) return { ...base, icon: 'play', tone: 'plain', verb: 'Started triage', object: 'new task', rest: quoted(text) };
    if (text === RESUME_KICK) return { ...base, icon: 'play', tone: 'plain', verb: 'Resumed', object: 'after a restart', rest: quoted(text) };
    if (text.startsWith(MEMORY_NOTE)) {
      // v3: memory changed since the chat started (another chat, the user, the background review).
      const lines = text.split('\n').slice(1).filter((l) => l.startsWith('- ['));
      const refs = lines.map((l) => /^- \[(m\d+)/.exec(l)?.[1]).filter(Boolean);
      return { ...base, icon: 'mem', tone: 'plain', verb: 'Memory changed', object: refs.join(', '), rest: lines.length === 1 ? cut(lines[0]!.replace(/^- \[[^\]]*\]\s*/, ''), 140) : `${lines.length} changes`, body: { kind: 'markdown', text: lines.join('\n') } };
    }
    return null;
  }
  if (m.author === 'schedule') {
    const s = SCHEDULE.exec(text);
    const prompt = s ? text.slice(0, s.index) : text;
    return { ...base, icon: 'clock', tone: 'acc', verb: 'Scheduled run', object: cut(plain(prompt), 120), rest: s?.[2], body: { kind: 'markdown', text: prompt } };
  }
  // Another agent wrote on this card (card_message).
  const f = FROM.exec(text);
  if (!f) return null;
  const [, from, card, said] = f as unknown as [string, string, string, string];
  return { ...base, icon: 'msg', tone: 'acc', verb: 'Message from', ref: card, object: `@${from}`, rest: cut(plain(said), 160), body: { kind: 'markdown', text: said } };
}

/** "engine shutting down" → "engine shut down". */
const interruptReason = (e: string | null) => (!e || e === 'engine shutting down' ? 'engine shut down' : e === 'engine stopped during the run' ? 'engine stopped' : e);

/**
 * The row for a run that ended without finishing, or null (a rewind's stop: the rewind row says it). `latest`: it is the
 * card's last run and nothing runs now (a failed one then offers Retry). `hhmm` formats the resume time.
 */
export function runRow(r: EndedRun, latest: boolean, hhmm: (iso: string) => string): SysRow | null {
  const base = { key: r.id, at: r.endedAt ?? r.startedAt };
  if (r.status === 'stopped') {
    if (r.error === REWOUND) return null;
    return r.error === 'stopped by you' || !r.error
      ? { ...base, icon: 'stop', tone: 'warn', verb: 'Stopped by you' }
      : { ...base, icon: 'stop', tone: 'warn', verb: 'Stopped', rest: r.error };
  }
  if (r.status === 'interrupted')
    return { ...base, icon: 'alert', tone: 'warn', verb: 'Interrupted', rest: interruptReason(r.error) + (r.next ? ` · resumed at ${hhmm(r.next)}` : '') };
  if (r.status === 'failed') {
    const error = r.error ?? 'the run failed';
    return { ...base, icon: 'alert', tone: 'bad', verb: 'Run failed', rest: firstLine(error), open: latest, body: { kind: 'error', text: error, retry: latest, agent: r.agentId } };
  }
  return null;
}

/** A rewind in effect: where the hidden messages were, what came back, Undo while it works. */
export function rewindRow(e: RewindEvent): SysRow {
  const files = e.filesError && !e.files?.length ? 'files not restored' : e.files === null ? 'putting files back…' : e.files.length ? `${plural(e.files.length, 'file')} put back` : 'no files changed';
  return {
    key: e.id,
    at: e.at,
    icon: 'rewind',
    tone: 'warn',
    verb: 'Rewound by you',
    object: `${plural(e.hidden, 'message')} hidden`,
    rest: files,
    body: e.files?.length || e.filesError || e.undoable ? { kind: 'files', files: e.files ?? [], error: e.filesError, undoId: e.undoable ? e.id : null } : undefined,
  };
}

/** The context summary point: `count` messages before it reach the model only through the summary. */
export function summaryRow(s: NonNullable<Timeline['summary']>, count: number): SysRow {
  return { key: 'summary', icon: 'compress', tone: 'plain', verb: 'Earlier messages summarized', rest: 'to fit the context', meta: `${plural(count, 'message')} → 1 summary`, body: { kind: 'markdown', text: s.text } };
}

/** A row and where it goes: after every message with seq ≤ `after`. */
export interface Placed {
  row: SysRow;
  after: number;
}

/**
 * Every timeline row with its place. Runs go after the last message stored before they ended, rewinds where their
 * messages were, the summary after the last message it covers. `messages`: all of the chat's (tool results too).
 */
export function timelineRows(t: Timeline, messages: Message[], o: { latestRunId: string | null; running: boolean; hhmm(iso: string): string }): Placed[] {
  const out: Placed[] = [];
  if (t.summary) {
    const upto = t.summary.uptoSeq;
    out.push({ row: summaryRow(t.summary, messages.filter((m) => m.seq <= upto && m.author !== 'tool').length), after: upto });
  }
  for (const r of t.runs) {
    const row = runRow(r, r.id === o.latestRunId && !o.running, o.hhmm);
    const end = r.endedAt ?? r.startedAt;
    if (row) out.push({ row, after: messages.filter((m) => m.at <= end).reduce((s, m) => Math.max(s, m.seq), 0) });
  }
  for (const e of t.rewinds) out.push({ row: rewindRow(e), after: e.fromSeq - 1 });
  // Same place: the summary first, then by time.
  return out.sort((a, b) => a.after - b.after || (a.row.at ?? '').localeCompare(b.row.at ?? ''));
}

/**
 * Splits placed rows between the chat's groups (each a run of messages, by first seq, ascending): `before` goes above
 * the first group, `after[i]` right after group i.
 */
export function distribute(firstSeqs: number[], placed: Placed[]): { before: SysRow[]; after: SysRow[][] } {
  const before: SysRow[] = [];
  const after: SysRow[][] = firstSeqs.map(() => []);
  for (const p of placed) {
    let i = -1;
    for (let k = 0; k < firstSeqs.length && firstSeqs[k]! <= p.after; k++) i = k;
    (i < 0 ? before : after[i]!).push(p.row);
  }
  return { before, after };
}
