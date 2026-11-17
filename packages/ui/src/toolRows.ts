import { currentToolName, type ImageBlock, type ToolCallDetail } from '@atlas/shared';
import { boardMeta, cardLine } from './cardRows.ts';
import { diffCount, diffLines } from './fileRows.ts';
import type { RowTone } from './chatRow.ts';
import { whenText } from './canvasRows.ts';
import { charsText, domainOf, fetchedPage, searchHits, shortUrl, webError } from './webRows.ts';

/**
 * Tool call → compact chat row (#59, docs/chat-activity.md §1–2): icon · verb · object · rest · meta. Pure: the same
 * call always gives the same row, so every tool is unit-tested. Unknown tools get a generic row (fail loudly: never hidden).
 */

export type RowIcon =
  | 'read' | 'write' | 'edit' | 'search' | 'folder' | 'term' | 'bg' | 'stop' | 'globe' | 'link' | 'card' | 'cardp' | 'msg'
  | 'board' | 'canvas' | 'panel' | 'mem' | 'todo' | 'clock' | 'think' | 'check' | 'x' | 'alert' | 'hand' | 'inbox'
  | 'history' | 'wrench' | 'play' | 'rewind' | 'compress';

/** A piece of the faint, tabular meta slot: plain text, a status pill, or a +/− line count. */
export type Meta = { text: string } | { pill: 'ok' | 'bad' | 'warn'; text: string } | { add: number; del: number };

/** How the row expands. Generic (input JSON + output) until the family cards (#62–#66) fill in the others. */
export type DetailKind =
  | 'generic' | 'code' | 'diff' | 'terminal' | 'matches' | 'files' | 'card' | 'quote' | 'board' | 'canvas' | 'doc'
  | 'checklist' | 'schedule' | 'results' | 'excerpt' | 'thinking';

/** What a step weighs in a group's summary: edits > shell > writes > reads. */
export type Weight = 'edit' | 'shell' | 'write' | 'read';

export interface RowModel {
  icon: RowIcon;
  tone: RowTone;
  /** Past tense ("Edited"), or the failure ("Couldn't edit"). */
  verb: string;
  /** Present tense while it runs ("Editing"). */
  running: string;
  /** The bright part: a file name, a command, a card. */
  object?: string;
  /** A card the row is about ("#58"): shown before the object as a link that opens the ticket. */
  ref?: string;
  /** Faint prefix of the object (a path's folder). */
  dir?: string;
  /** Commands and patterns in the mono font. */
  mono?: boolean;
  /** Muted text after the object (cut to fit). */
  rest?: string;
  meta: Meta[];
  detail: DetailKind;
  weight: Weight;
  /** This step in a group's summary: verb "edited", object "CardPanel.tsx" (same verbs merge: "edited A and B"). */
  short: Short;
  /** Lines added / removed (files): summed in a group's +/− total. */
  add?: number;
  del?: number;
}

export interface Short {
  verb: string;
  obj?: string;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** Pictures the tool returned (read_file / web_fetch of an image). */
  images?: ImageBlock[];
}

type Input = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const firstLine = (s: string) => s.trim().split('\n')[0]!.trim();
/** A message's first line without its bold and code marks (a row shows plain text). */
const plainLine = (s: string) => firstLine(s).replace(/\*\*|`/g, '');
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const lines = (s: string) => (s ? s.replace(/\n$/, '').split('\n').length : 0);
const quoted = (s: string) => `“${s}”`;

/** The command that matters: "export PATH=…; cd x && npm test" → "npm test" (the full one shows when expanded). */
export function commandCore(cmd: string): string {
  const first = firstLine(cmd);
  const parts = first.split(/\s*(?:&&|;)\s*/);
  const setup = /^(export\s|cd\s|[A-Z_][A-Z0-9_]*=\S*$|source\s|\.\s|set\s-)/;
  const i = parts.findIndex((p) => p && !setup.test(p));
  return i <= 0 ? first : parts.slice(i).join(first.includes('&&') ? ' && ' : '; ');
}

/** "packages/ui/src/ChatRow.tsx" → dir "packages/ui/src/", name "ChatRow.tsx" (a trailing / is kept on the name). */
export function splitPath(p: string): { dir: string; name: string } {
  const i = p.replace(/\/$/, '').lastIndexOf('/');
  return { dir: p.slice(0, i + 1), name: p.slice(i + 1) || p };
}

/** What a card_update changed: "status → ready, title". */
export function cardChanges(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([k, v]) => k !== 'id' && v !== undefined)
    .map(([k, v]) => ((k === 'status' || k === 'priority' || k === 'assignee') && (typeof v === 'string' || typeof v === 'number') ? `${k} → ${k === 'priority' ? 'P' + v : k === 'assignee' ? '@' + v : v}` : k === 'assignee' && v === null ? 'unassigned' : k))
    .join(', ');
}
export const cardRef = (v: unknown) => (typeof v === 'number' ? `#${v}` : typeof v === 'string' && v ? (/^\d+$/.test(v) ? `#${v}` : v) : undefined);

type Spec = Omit<RowModel, 'tone' | 'meta' | 'short' | 'detail' | 'weight'> & Partial<Pick<RowModel, 'tone' | 'meta' | 'detail' | 'weight' | 'short'>>;

/** The failure wording of each tool: "Couldn't edit". */
const FAILED: Record<string, string> = {
  read_file: 'Couldn’t read', write_file: 'Couldn’t write', edit_file: 'Couldn’t edit', list_files: 'Couldn’t list',
  grep: 'Couldn’t search', glob: 'Couldn’t find files', shell: 'Couldn’t run', shell_output: 'Couldn’t check',
  shell_kill: 'Couldn’t stop', web_fetch: 'Couldn’t fetch', web_search: 'Couldn’t search the web',
  task_create: 'Couldn’t create', task_update: 'Couldn’t update', task_message: 'Couldn’t message', task_show: 'Couldn’t open',
  task_list: 'Couldn’t list tasks', task_block: 'Couldn’t ask you', task_request_review: 'Couldn’t send for review',
  task_complete: 'Couldn’t finish the task', history_search: 'Couldn’t search its history', canvas_create: 'Couldn’t create canvas',
  canvas_write: 'Couldn’t update canvas', canvas_read: 'Couldn’t read canvas', canvas_list: 'Couldn’t list canvases',
  panel_open: 'Couldn’t open', panel_close: 'Couldn’t close', memory_edit: 'Couldn’t save to memory', memory_add: 'Couldn’t save to memory', memory_update: 'Couldn’t update memory', memory_forget: 'Couldn’t forget', memory_search: 'Couldn’t search memory', todo_write: 'Couldn’t save the plan',
  schedule_create: 'Couldn’t schedule', schedule_list: 'Couldn’t list schedules', schedule_delete: 'Couldn’t delete schedule',
};

/**
 * The row for one tool call. `result` undefined = no result yet (running, or cut short: the caller decides). `detail`:
 * what a file tool did, from the engine (created or rewrote, where an edit landed); older calls have none.
 */
export function toolRow(called: string, input: unknown, result?: ToolOutcome | null, detail?: ToolCallDetail): RowModel {
  const name = currentToolName(called);
  const o: Input = input && typeof input === 'object' && !Array.isArray(input) ? (input as Input) : {};
  const out = result && !result.isError ? result.content : '';
  const spec = describe(name, o, out, !!result && !result.isError, detail);
  const model: RowModel = {
    tone: 'plain',
    meta: [],
    detail: 'generic',
    weight: 'read',
    short: shortOf(spec.verb, spec.object),
    ...spec,
  };
  if (result?.isError) {
    model.tone = 'bad';
    model.icon = 'x';
    model.verb = FAILED[name] ?? `Couldn’t run ${name}`;
    model.rest = name === 'web_fetch' || name === 'web_search' ? webError(result.content) : firstLine(result.content);
    model.meta = [];
    delete model.add;
    delete model.del;
    // The call never ran (#55): its arguments were bad JSON or didn't fit the tool's schema; the model got the error.
    const bad = badInput(name, result.content);
    if (bad) {
      model.verb = 'Couldn’t call';
      model.object = name;
      delete model.dir;
      delete model.ref;
      model.mono = true;
      model.rest = `${bad}, sent back to the model`;
      model.short = { verb: 'couldn’t call', obj: name };
    }
  }
  return model;
}

/**
 * Why a call didn't run because of its input, from the engine's error (tools.ts « invalid input for x: <zod issues> »,
 * providers/types.ts invalidToolInput), or null for any other failure: « invalid input: context: Too big… ».
 */
export function badInput(name: string, error: string): string | null {
  if (error.startsWith('Your arguments were not valid JSON')) return 'arguments weren’t valid JSON';
  const prefix = `invalid input for ${name}: `;
  if (!error.startsWith(prefix)) return null;
  const raw = error.slice(prefix.length);
  try {
    const issues = JSON.parse(raw) as { path?: unknown[]; message?: string }[];
    const parts = issues.map((i) => [i.path?.join('.'), i.message].filter(Boolean).join(': '));
    if (parts.length) return 'invalid input: ' + parts.join('; ');
  } catch {
    // Not zod's JSON list (an older message): its first line says it.
  }
  return 'invalid input: ' + firstLine(raw);
}

const shortOf = (verb: string, obj?: string): Short => ({ verb: verb.toLowerCase(), obj });
const path = (p: string | undefined, fallback = '.') => {
  const { dir, name } = splitPath(p ?? fallback);
  return { object: name, dir };
};

function describe(name: string, o: Input, out: string, ok: boolean, detail?: ToolCallDetail): Spec {
  switch (name) {
    /* ── files ── */
    case 'read_file': {
      const nums = [...out.matchAll(/^ *(\d+)\|/gm)].map((m) => Number(m[1]));
      const range = nums.length ? `lines ${nums[0]}–${nums.at(-1)}` : num(o.offset) ? `from line ${o.offset}` : undefined;
      return { icon: 'read', verb: 'Read', running: 'Reading', ...path(str(o.path)), rest: range, detail: 'code', weight: 'read' };
    }
    case 'write_file': {
      // Created / Rewrote come from the engine (older calls: « Wrote »); a rewrite counts its diff to the previous text.
      const content = typeof o.content === 'string' ? o.content : '';
      const w = detail?.kind === 'write' ? detail : undefined;
      const d = w && !w.created && w.before !== null ? diffCount(diffLines(w.before, content)) : { add: lines(content), del: 0 };
      const verb = !w ? 'Wrote' : w.created ? 'Created' : 'Rewrote';
      return { icon: 'write', verb, running: 'Writing', ...path(str(o.path)), meta: [d], ...d, detail: w?.created === false && w.before !== null ? 'diff' : 'code', weight: 'edit', short: shortOf(verb, path(str(o.path)).object) };
    }
    case 'edit_file': {
      const one = diffCount(diffLines(str(o.old_text) ?? '', typeof o.new_text === 'string' ? o.new_text : ''));
      const times = detail?.kind === 'edit' ? Math.max(1, detail.lines.length) : 1;
      const d = { add: one.add * times, del: one.del * times };
      return { icon: 'edit', verb: 'Edited', running: 'Editing', ...path(str(o.path)), meta: [d], ...d, detail: 'diff', weight: 'edit' };
    }
    case 'list_files': {
      const n = ok && out !== '(empty)' ? lines(out) : 0;
      return { icon: 'folder', verb: 'Listed', running: 'Listing', ...path(str(o.path), './'), meta: ok ? [{ text: plural(n, 'entry', 'entries') }] : [], detail: 'files' };
    }
    case 'grep': {
      const pattern = str(o.pattern) ?? '';
      const where = str(o.path) && o.path !== '.' ? `in ${o.path}` : undefined;
      let meta: Meta[] = [];
      if (ok) {
        const ls = out === 'no matches' ? [] : out.split('\n').filter((l) => l && !l.startsWith('['));
        if (o.mode === 'files') meta = [{ text: plural(ls.length, 'file') }];
        else if (o.mode === 'count') meta = [{ text: plural(ls.reduce((s, l) => s + (Number(/:(\d+)$/.exec(l)?.[1]) || 0), 0), 'match', 'matches') }];
        else meta = [{ text: plural(ls.filter((l) => /^.+?:\d+:/.test(l)).length, 'match', 'matches') }];
      }
      return { icon: 'search', verb: 'Searched', running: 'Searching', object: quoted(pattern), mono: true, rest: where, meta, detail: 'matches', short: { verb: 'searched', obj: quoted(cut(pattern, 24)) } };
    }
    case 'glob': {
      const pattern = str(o.pattern) ?? '';
      const n = ok && out !== 'no matches' && out !== 'no files' ? out.split('\n').filter((l) => l && !l.startsWith('[')).length : 0;
      return { icon: 'folder', verb: 'Found', running: 'Finding', object: ok ? plural(n, 'file') : 'files', rest: pattern, detail: 'files', short: { verb: 'found', obj: pattern } };
    }
    /* ── shell ── */
    case 'shell': {
      const command = commandCore(str(o.command) ?? '');
      if (o.background === true) {
        const id = /started (bg_\w+)/.exec(out)?.[1];
        return { icon: 'bg', tone: 'acc', verb: 'Started in background', running: 'Starting', object: command, mono: true, meta: id ? [{ text: id.slice(0, 7) }] : [], detail: 'terminal', weight: 'shell', short: { verb: 'started', obj: cut(command, 30) } };
      }
      const exit = /^exit (\S+)/.exec(out)?.[1];
      const good = exit === '0';
      const meta: Meta[] = exit ? [{ pill: good ? 'ok' : 'bad', text: `exit ${exit}` }] : [];
      return { icon: 'term', tone: exit ? (good ? 'ok' : 'bad') : 'plain', verb: 'Ran', running: 'Running', object: command, mono: true, meta, detail: 'terminal', weight: 'shell', short: { verb: 'ran', obj: cut(command, 30) } };
    }
    case 'shell_output': {
      const state = /^bg_\w+: (\w+)/.exec(out)?.[1];
      return { icon: 'bg', verb: 'Checked', running: 'Checking', object: str(o.id) ?? '', mono: true, meta: state ? [{ text: state }] : [], detail: 'terminal' };
    }
    case 'shell_kill':
      return { icon: 'stop', verb: 'Stopped', running: 'Stopping', object: str(o.id) ?? '', mono: true, rest: ok && /SIGTERM/.test(out) ? 'SIGTERM · log kept' : undefined, weight: 'write' };
    /* ── web ── */
    case 'web_fetch': {
      const page = ok ? fetchedPage(out, str(o.url)) : undefined;
      const url = shortUrl(str(o.url) ?? '');
      return { icon: 'link', verb: 'Fetched', running: 'Fetching', object: url, rest: page?.title, meta: page ? [{ text: charsText(page.chars) }] : [], detail: 'excerpt', short: { verb: 'fetched', obj: cut(domainOf(str(o.url) ?? ''), 30) } };
    }
    case 'web_search': {
      const q = str(o.query) ?? '';
      const n = ok ? searchHits(out).length : 0;
      return { icon: 'globe', verb: 'Searched the web', running: 'Searching the web', object: quoted(q), meta: ok ? [{ text: plural(n, 'result') }] : [], detail: 'results', short: { verb: 'searched the web for', obj: quoted(cut(q, 24)) } };
    }
    /* ── cards & team ── */
    case 'task_create': {
      const c = cardLine(out);
      return { icon: 'cardp', tone: 'acc', verb: 'Created', running: 'Creating', ref: c?.ref, object: c?.title ?? str(o.title) ?? '', meta: c ? [{ text: [c.who, c.prio].filter(Boolean).join(' · ') }] : [], detail: 'card', weight: 'write', short: { verb: 'created', obj: c?.ref ?? 'a task' } };
    }
    case 'task_update': {
      const c = cardLine(out);
      const ref = c?.ref ?? cardRef(o.id);
      return { icon: 'card', verb: 'Updated', running: 'Updating', ref, object: c?.title, rest: cardChanges(o) || undefined, detail: 'card', weight: 'write', short: { verb: 'updated', obj: ref } };
    }
    case 'task_message': {
      const ref = cardRef(o.id);
      return { icon: 'msg', verb: 'Messaged', running: 'Messaging', ref, rest: plainLine(str(o.text) ?? ''), detail: 'quote', weight: 'write', short: { verb: 'messaged', obj: ref } };
    }
    case 'task_show': {
      const c = cardLine(out);
      const ref = c?.ref ?? cardRef(o.id);
      return { icon: 'card', verb: 'Looked at', running: 'Opening', ref, object: c?.title, meta: c ? [{ text: c.status }] : [], detail: 'card', short: { verb: 'looked at', obj: ref } };
    }
    case 'task_list':
      return { icon: 'board', verb: 'Listed the board', running: 'Listing the board', rest: str(o.status) && `${o.status} tasks`, meta: ok ? [{ text: boardMeta(out) }] : [], detail: 'board' };
    case 'task_block':
      return { icon: 'hand', tone: 'warn', verb: 'Asked you', running: 'Asking you', object: plainLine(str(o.question) ?? ''), rest: str(o.kind)?.replace('_', ' '), detail: 'quote', weight: 'write', short: { verb: 'asked you' } };
    case 'task_request_review':
      return { icon: 'inbox', tone: 'warn', verb: 'Sent for your review', running: 'Sending for your review', rest: plainLine(str(o.summary) ?? ''), detail: 'quote', weight: 'write', short: { verb: 'sent it for your review' } };
    case 'task_complete':
      return { icon: 'check', tone: 'ok', verb: 'Finished the task', running: 'Finishing the task', rest: plainLine(str(o.summary) ?? ''), detail: 'quote', weight: 'write', short: { verb: 'finished the task' } };
    case 'history_search': {
      const q = str(o.query);
      const hits = ok ? (out.startsWith('no message') ? 0 : (out.match(/^#\d+ /gm) ?? []).length) : 0;
      return { icon: 'history', verb: 'Searched its history', running: 'Searching its history', object: q ? quoted(q) : num(o.seq) !== undefined ? `message #${o.seq}` : '', mono: !!q, meta: ok && q ? [{ text: plural(hits, 'hit') }] : [], detail: 'matches' };
    }
    /* ── canvas & panel ── */
    case 'canvas_create': {
      const id = /created (cv_\w+)/.exec(out)?.[1];
      return { icon: 'canvas', verb: 'Created canvas', running: 'Creating canvas', object: str(o.name) ?? '', meta: id ? [{ text: id.slice(0, 7) }] : [], detail: 'canvas', weight: 'write' };
    }
    case 'canvas_write': {
      const m = /is now v(\d+) with (\d+) nodes?/.exec(out);
      return { icon: 'canvas', tone: 'acc', verb: 'Updated canvas', running: 'Updating canvas', object: str(o.id) ?? '', meta: m ? [{ text: `${plural(Number(m[2]), 'node')} · v${m[1]}` }] : [], detail: 'canvas', weight: 'write', short: { verb: 'updated', obj: 'a canvas' } };
    }
    case 'canvas_read': {
      let canvas: { name?: unknown; version?: unknown; nodes?: unknown } = {};
      try {
        canvas = ok ? JSON.parse(out) : {};
      } catch {
        canvas = {}; // not JSON: the row keeps the id, the output shows when expanded
      }
      const nodes = Array.isArray(canvas.nodes) ? canvas.nodes.length : undefined;
      return { icon: 'canvas', verb: 'Read canvas', running: 'Reading canvas', object: str(canvas.name) ?? str(o.id) ?? '', meta: nodes !== undefined ? [{ text: `v${canvas.version} · ${plural(nodes, 'node')}` }] : [], detail: 'canvas' };
    }
    case 'canvas_list': {
      const n = out.split('\n').filter((l) => /^cv_/.test(l)).length;
      return { icon: 'canvas', verb: 'Listed canvases', running: 'Listing canvases', meta: ok ? [{ text: plural(n, 'canvas', 'canvases') }] : [], detail: 'board' };
    }
    case 'panel_open': {
      const { name: file } = splitPath(str(o.path) ?? str(o.canvas) ?? '');
      const v = /, v(\d+)\)/.exec(out)?.[1];
      return { icon: 'panel', tone: 'acc', verb: 'Opened in the panel', running: 'Opening in the panel', object: file, meta: v ? [{ text: `v${v}` }] : [], detail: 'doc', short: { verb: 'opened', obj: file } };
    }
    case 'panel_close': {
      const target = str(o.path) ?? str(o.canvas);
      return { icon: 'panel', verb: target ? 'Closed in the panel' : 'Closed the panel', running: 'Closing', object: target ? splitPath(target).name : undefined, detail: 'generic' };
    }
    /* ── memory, plan, schedules ── */
    case 'memory_edit': {
      const usage = /\((\d+\/\d+) chars\)/.exec(out)?.[1];
      const scope = o.scope === 'shared' ? 'shared' : 'mine';
      return { icon: 'mem', verb: o.mode === 'replace' ? 'Rewrote memory' : 'Saved to memory', running: 'Saving to memory', rest: plainLine(str(o.text) ?? ''), meta: [{ text: usage ? `${scope} · ${usage}` : scope }], detail: 'quote', weight: 'write' };
    }
    /* Memory v2 (#81): output « saved m12 (rule, shared) · always-on 1509/3000 chars ». */
    case 'memory_add':
    case 'memory_update': {
      const id = /\b(m\d+)\b/.exec(out)?.[1];
      const usage = /always-on (\d+\/\d+) chars/.exec(out)?.[1];
      // A refusal (similar memories, over budget) is an error: the generic failure row shows its first line.
      const verb = name === 'memory_update' || str(o.update) || typeof o.update === 'number' ? 'Updated memory' : 'Saved to memory';
      const meta = [str(o.kind), name === 'memory_add' ? (o.scope === 'shared' ? 'shared' : 'mine') : undefined, id, usage].filter((x): x is string => !!x);
      return { icon: 'mem', verb, running: 'Saving to memory', rest: plainLine(str(o.text) ?? ''), meta: [{ text: meta.join(' · ') }], detail: 'quote', weight: 'write' };
    }
    case 'memory_forget':
      return { icon: 'mem', verb: 'Forgot memory', running: 'Forgetting', object: String(o.id ?? ''), detail: 'generic', weight: 'write' };
    case 'memory_search': {
      const n = out.split('\n').filter((l) => /^- \[m\d+/.test(l)).length;
      return { icon: 'mem', verb: 'Searched memory', running: 'Searching memory', object: str(o.query) ?? '', meta: ok ? [{ text: plural(n, 'match', 'matches') }] : [], detail: 'generic' };
    }
    case 'todo_write': {
      const todos = Array.isArray(o.todos) ? (o.todos as { content?: unknown; status?: unknown }[]) : [];
      const done = todos.filter((t) => t?.status === 'completed').length;
      const now = todos.find((t) => t?.status === 'in_progress');
      return { icon: 'todo', tone: 'acc', verb: 'Plan', running: 'Planning', object: `${done} of ${todos.length} done`, rest: now && str(now.content) ? `now: ${firstLine(now.content as string)}` : undefined, detail: 'checklist', short: { verb: 'updated the plan' } };
    }
    case 'schedule_create': {
      const when = str(o.cron) ? `cron ${o.cron}` : str(o.at) ? `once · ${whenText(o.at as string)}` : undefined;
      return { icon: 'clock', verb: 'Scheduled', running: 'Scheduling', object: quoted(str(o.title) ?? cut(firstLine(str(o.prompt) ?? ''), 40)), rest: [when, str(o.agent) && `@${o.agent}`].filter(Boolean).join(' · ') || undefined, detail: 'schedule', weight: 'write' };
    }
    case 'schedule_list': {
      const n = out.split('\n').filter((l) => /^sch_/.test(l)).length;
      return { icon: 'clock', verb: 'Listed schedules', running: 'Listing schedules', meta: ok ? [{ text: plural(n, 'schedule') }] : [], detail: 'board' };
    }
    case 'schedule_delete':
      return { icon: 'clock', verb: 'Deleted schedule', running: 'Deleting schedule', object: str(o.id) ?? '', mono: true, weight: 'write' };
  }
  // Unknown tool: its name and first argument, the raw JSON when expanded.
  const first = Object.values(o).find((v) => typeof v === 'string' && v) as string | undefined;
  return { icon: 'wrench', verb: 'Called', running: 'Calling', object: name, mono: true, rest: first ? cut(firstLine(first), 80) : undefined, detail: 'generic', short: { verb: 'called', obj: name } };
}

/** A thinking block as a row (#65 adds its duration). */
export function thinkingRow(): RowModel {
  return { icon: 'think', tone: 'plain', verb: 'Thought', running: 'Thinking', meta: [], detail: 'thinking', weight: 'read', short: { verb: 'thought' } };
}

/** 900 ms → null (under a second isn't shown), 4200 → "4.2 s", 72000 → "1 m 12 s". */
export function duration(ms: number): string | null {
  if (!(ms >= 1000)) return null;
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}
