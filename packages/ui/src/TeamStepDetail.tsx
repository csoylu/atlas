import type { ReactNode } from 'react';
import type { DetailContext } from './CardStepDetail.tsx';
import { humanTimes, memoryFoot, scheduleCreated, scheduleList, whenText } from './teamRows.ts';
import type { Step } from './chatTurn.ts';
import { EmptyState } from './Kit.tsx';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * The expanded view of a memory or schedule tool (#64, mockup pages/chat-activity.html §5): the memory quote, a
 * schedule's when/prompt, the schedule list.
 * undefined = not one of them (the caller decides); null = nothing to expand (the row doesn't open).
 */
export function teamDetail(step: Step, ctx: DetailContext): ReactNode | null | undefined {
  const o = (step.input && typeof step.input === 'object' ? step.input : {}) as Record<string, unknown>;
  const out = step.result && !step.result.isError ? step.result.content : null;
  switch (step.name) {
    case 'memory_add':
    case 'memory_update':
      return <blockquote className="step-quote">{ctx.renderText(str(o.text), 'm')}</blockquote>;
    case 'memory_edit':
      return (
        <>
          <blockquote className="step-quote">{ctx.renderText(str(o.text), 'm')}</blockquote>
          <div className="step-foot">{memoryFoot(o)}</div>
        </>
      );
    case 'schedule_create': {
      if (out === null) return undefined;
      const s = scheduleCreated(out);
      const when = s ? humanTimes(s.when) : str(o.cron) ? `cron "${str(o.cron)}"` : `once at ${whenText(str(o.at))}`;
      return (
        <div className="step-kv">
          {s && (
            <>
              <span>id</span>
              <span className="mono">{s.id}</span>
            </>
          )}
          <span>when</span>
          <span>{when}</span>
          {s && (
            <>
              <span>first run</span>
              <span>{whenText(s.first)}</span>
              <span>agent</span>
              <span>@{s.agent}</span>
            </>
          )}
          <span>task</span>
          <span>{o.new_task_each_time === true || o.new_card_each_time === true ? 'a new task each run' : 'its own task, reopened each run'}</span>
          <span>prompt</span>
          <span className="step-kv-long">{str(o.prompt)}</span>
        </div>
      );
    }
    case 'schedule_list': {
      if (out === null) return undefined;
      const list = scheduleList(out);
      if (!list.length) return <EmptyState inline title="No schedules" />;
      return (
        <div className="step-list">
          {list.map((s) => (
            <div key={s.id} className={'step-list-row' + (s.failed ? ' bad' : '')}>
              <span className="step-list-t">
                {s.title} <span className="step-list-m">@{s.agent}</span>
              </span>
              <span className="step-list-m">{humanTimes([s.when, s.more].filter(Boolean).join(' · '))}</span>
            </div>
          ))}
        </div>
      );
    }
    case 'schedule_delete':
      return out === null ? undefined : null;
  }
  return undefined;
}
