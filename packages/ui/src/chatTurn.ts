import { currentToolName, type ContentBlock, type Message, type ToolCallDetail } from '@atlas/shared';
import { artifactOf, type Artifact } from './cardModal.ts';
import { canvasIdOf, thinkingRow, toolRow, type RowIcon, type RowModel, type ToolOutcome } from './toolRows.ts';

/**
 * An agent's turn in the chat (#59): its consecutive messages split into text, single steps, « N steps » groups and
 * pinned items that are never folded (the artifact card, the card_block question, the live plan).
 */

/** running: no result yet in a live turn · cut: no result and the run is over (stopped, interrupted). */
export type StepState = 'running' | 'done' | 'failed' | 'cut';

export interface Step {
  /** tool_use id, or `<message id>:<index>` for a thinking block. */
  id: string;
  kind: 'tool' | 'thinking';
  name: string;
  input: unknown;
  /** Thinking text. */
  text?: string;
  result?: ToolOutcome;
  /** What a file tool did, from the engine (#63). */
  detail?: ToolCallDetail;
  row: RowModel;
  state: StepState;
  /** When its message was written. */
  at: string;
}

export type Pin = 'doc' | 'ask' | 'plan';

export type Segment =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'step'; step: Step }
  | { kind: 'group'; key: string; steps: Step[] }
  | { kind: 'pin'; pin: Pin; step: Step };

type Use = Extract<ContentBlock, { type: 'tool_use' | 'server_tool_use' }>;

/**
 * Split a turn (one agent's consecutive messages) into segments. 2+ tool calls in a row (text breaks the row) fold
 * into a group; fewer stay single rows. `live`: the turn is still running (calls without a result are running, the
 * latest todo_write is pinned). `details`: the engine's file tool details by tool_use id.
 */
export function groupTurn(
  messages: Message[],
  results: Map<string, ToolOutcome>,
  opts: { live: boolean; details?: (id: string) => ToolCallDetail | undefined; canvasPage?: CanvasPage },
): Segment[] {
  const out: Segment[] = [];
  let pending: Step[] = [];
  const flush = () => {
    if (pending.filter((s) => s.kind === 'tool').length >= 2) out.push({ kind: 'group', key: pending[0]!.id, steps: pending });
    else for (const step of pending) out.push({ kind: 'step', step });
    pending = [];
  };
  const lastPlan = opts.live ? messages.flatMap((m) => m.content).filter((b): b is Use => (b.type === 'tool_use' || b.type === 'server_tool_use') && b.name === 'todo_write').at(-1)?.id : undefined;
  for (const m of messages)
    m.content.forEach((b, i) => {
      if (b.type === 'text') {
        if (!b.text.trim()) return;
        flush();
        out.push({ kind: 'text', key: `${m.id}:${i}`, text: b.text });
      } else if (b.type === 'thinking') {
        // Older answers kept only the signature (thinking display omitted): nothing to show.
        if (b.thinking.trim()) pending.push({ id: `${m.id}:${i}`, kind: 'thinking', name: 'thinking', input: null, text: b.thinking, row: thinkingRow(), state: 'done', at: m.at });
      } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        const result = results.get(b.id);
        const detail = opts.details?.(b.id);
        const row = toolRow(b.name, b.input, result, detail);
        const state: StepState = result ? (result.isError || row.tone === 'bad' ? 'failed' : 'done') : opts.live ? 'running' : 'cut';
        const step: Step = { id: b.id, kind: 'tool', name: b.name, input: b.input, result, ...(detail ? { detail } : {}), row, state, at: m.at };
        const pin = pinOf(step, b.id === lastPlan, opts.canvasPage);
        if (pin) {
          flush();
          out.push({ kind: 'pin', pin, step });
        } else pending.push(step);
      }
    });
  flush();
  return out;
}

/**
 * The streaming answer as segments (#80), in the model's order: a thinking part is the same row as the saved thinking
 * step (running while it's the last part, « Thought » once text follows), a text part is text. Keys are by position,
 * so a row keeps its state (open or not) while later parts stream in.
 */
export function draftSegments(parts: readonly { kind: 'thinking' | 'text'; text: string; at: string }[]): Segment[] {
  return parts.flatMap((p, i): Segment[] => {
    if (p.kind === 'text') return [{ kind: 'text', key: `draft:${i}`, text: p.text }];
    if (!p.text.trim()) return [];
    const running = i === parts.length - 1;
    return [{ kind: 'step', step: { id: `draft:${i}`, kind: 'thinking', name: 'thinking', input: null, text: p.text, row: thinkingRow(), state: running ? 'running' : 'done', at: p.at } }];
  });
}

/** The converted page of a canvas (cv_ id → its artifact, #174), if there is one. */
export type CanvasPage = (canvasId: string) => Artifact | undefined;

/**
 * The artifact a step shows as a chip: what artifact_create / artifact_update / panel_open made or opened, or, in old
 * chats, the page an old canvas_* call's canvas was converted to (#174). Null: the step stays a plain row.
 */
export function stepArtifact(s: Pick<Step, 'name' | 'input' | 'result'>, canvasPage?: CanvasPage): Artifact | null {
  if (!s.result || s.result.isError) return null;
  const art = artifactOf(s.name, s.input, s.result.content);
  if (art) return art;
  const cv = canvasPage && canvasIdOf(s.name, s.input, s.result);
  return (cv && canvasPage(cv)) || null;
}

function pinOf(s: Step, livePlan: boolean, canvasPage?: CanvasPage): Pin | null {
  if (currentToolName(s.name) === 'task_block') return 'ask';
  if (s.name === 'todo_write' && livePlan) return 'plan';
  if (stepArtifact(s, canvasPage)) return 'doc';
  return null;
}

const RANK = { edit: 0, shell: 1, write: 2, read: 3 } as const;

export interface GroupSummary {
  /** The kinds of steps, in order (a failure first), 4 at most. */
  icons: RowIcon[];
  /** The 2–3 key actions: "Edited CardPanel.tsx and styles.css, ran npm test". */
  text: string;
  add: number;
  del: number;
  failed: number;
  /** The step running now, if any. */
  running: Step | null;
  tools: number;
}

/** What a collapsed group says about its steps. */
export function groupSummary(steps: Step[]): GroupSummary {
  const tools = steps.filter((s) => s.kind === 'tool');
  const failed = tools.filter((s) => s.state === 'failed').length;
  const icons = [...new Set([...(failed ? ['x' as const] : []), ...steps.filter((s) => s.state !== 'failed').map((s) => s.row.icon)])].slice(0, 4);
  // Key actions: edits > shell > writes > reads, first come first within a kind, each said once, then in turn order.
  const good = tools.filter((s) => s.state !== 'failed');
  const pool = good.length ? good : tools;
  const seen = new Set<string>();
  const picked = pool
    .map((s, i) => ({ s, i }))
    .sort((a, b) => RANK[a.s.row.weight] - RANK[b.s.row.weight] || a.i - b.i)
    .filter(({ s }) => {
      const k = s.row.short.verb + '\u0000' + (s.row.short.obj ?? '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 3)
    .sort((a, b) => a.i - b.i);
  const phrases: { verb: string; objs: string[] }[] = [];
  for (const { s } of picked) {
    const last = phrases.at(-1);
    if (last && last.verb === s.row.short.verb && s.row.short.obj && last.objs.length) last.objs.push(s.row.short.obj);
    else phrases.push({ verb: s.row.short.verb, objs: s.row.short.obj ? [s.row.short.obj] : [] });
  }
  const sentence = phrases.map((p) => (p.objs.length ? `${p.verb} ${andList(p.objs)}` : p.verb)).join(', ');
  return {
    icons,
    text: sentence.charAt(0).toUpperCase() + sentence.slice(1),
    add: tools.reduce((n, s) => n + (s.state === 'failed' ? 0 : (s.row.add ?? 0)), 0),
    del: tools.reduce((n, s) => n + (s.state === 'failed' ? 0 : (s.row.del ?? 0)), 0),
    failed,
    running: tools.find((s) => s.state === 'running') ?? null,
    tools: tools.length,
  };
}

const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** A turn that ended on a failed step (no text after it): its group opens on that step. */
export function endedOnFailure(segments: Segment[]): Step | null {
  const last = segments.at(-1);
  if (last?.kind !== 'group') return null;
  const step = last.steps.at(-1);
  return step?.state === 'failed' ? step : null;
}

/** Messages → turns: one per user/system message, consecutive messages of one agent merged into one. */
export function turns(messages: Message[], isAgent: (m: Message) => boolean, breakAfter?: number | null): Message[][] {
  const out: Message[][] = [];
  for (const m of messages) {
    const prev = out.at(-1);
    // The « New » line (#338): the first message after `breakAfter` starts its own group, so the line sits right above it.
    const fresh = breakAfter != null && m.seq > breakAfter && !!prev && prev.at(-1)!.seq <= breakAfter;
    if (prev && !fresh && isAgent(m) && isAgent(prev[0]!) && prev[0]!.author === m.author) prev.push(m);
    else out.push([m]);
  }
  return out;
}
