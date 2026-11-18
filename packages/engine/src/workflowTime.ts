import * as CronParser from 'cron-parser';
import type { ScheduleKind, TriggerConfig, Workflow, WorkflowNode } from '@atlas/shared';
import { InvalidError } from './kanban.ts';

/** When a time trigger fires: a cron in a time zone, or once at an instant. */
export interface When {
  kind: ScheduleKind;
  cron: string | null;
  at: string | null;
  timezone: string;
}

/** The engine machine's time zone: the default for triggers made without one (e.g. Europe/Paris). */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The next `n` firings strictly after `from` (fewer for a one-shot). Throws InvalidError on a bad cron expression. */
export function upcoming(s: When, from: Date, n = 1): string[] {
  if (s.kind === 'at') return s.at && new Date(s.at) > from ? [new Date(s.at).toISOString()] : [];
  let expr;
  try {
    expr = CronParser.CronExpressionParser.parse(s.cron ?? '', { tz: s.timezone, currentDate: from });
  } catch (e) {
    throw new InvalidError(`cron "${s.cron}": ${e instanceof Error ? e.message : String(e)}`);
  }
  return Array.from({ length: n }, () => expr.next().toDate().toISOString());
}

export function describeWhen(s: When): string {
  return s.kind === 'cron' ? `cron "${s.cron}" (${s.timezone})` : `once at ${s.at}`;
}

/** A time trigger as a When; null for a manual one. */
export function triggerWhen(t: TriggerConfig): When | null {
  return t.kind === 'time' ? { kind: t.repeat, cron: t.cron, at: t.at, timezone: t.timezone } : null;
}
export const describeTrigger = (t: TriggerConfig) => (t.kind === 'time' ? describeWhen(triggerWhen(t)!) : 'by hand only');

/** "Mon 10 Nov, 09:00" in a zone (date only with `short`). */
export function stamp(d: Date, timeZone: string, short = false): string {
  return d.toLocaleString('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', ...(short ? {} : { hour: '2-digit', minute: '2-digit' }) });
}

export function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]!.trim();
  return line.length > 80 ? line.slice(0, 79) + '…' : line;
}

export const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** How a step is named in run reasons and task titles. */
export function stepTitle(n: WorkflowNode): string {
  if (n.kind === 'trigger') return 'Trigger';
  if (n.config.title) return n.config.title;
  if (n.kind === 'agent') return firstLine(n.config.prompt) || `@${n.config.agentId ?? '?'}`;
  if (n.kind === 'approval') return firstLine(n.config.question) || 'Approval';
  return n.config.test === 'ranFewer' ? `${n.config.node} ran fewer than ${n.config.times} times?` : `Summary contains « ${n.config.text} »?`;
}

/** The trigger and the single agent step of a « trigger → one agent step » workflow (what a schedule was), or null. */
export function oneStep(w: Pick<Workflow, 'nodes' | 'edges'>): { trigger: Extract<WorkflowNode, { kind: 'trigger' }>; step: Extract<WorkflowNode, { kind: 'agent' }> } | null {
  const trigger = w.nodes.find((n) => n.kind === 'trigger');
  const step = w.nodes.find((n) => n.kind === 'agent');
  if (!trigger || !step || w.nodes.length !== 2 || w.edges.length !== 1) return null;
  if (w.edges[0]!.from !== trigger.id || w.edges[0]!.to !== step.id) return null;
  return { trigger, step } as never;
}

/** An approval answer in the user's words: the Inbox options, or their own. */
export const APPROVE = /^\s*(approve[ds]?|yes|ok|okay|go|lgtm|ship it)\b/i;
export const REJECT = /^\s*(reject(ed)?|no|stop|deny|denied)\b/i;
