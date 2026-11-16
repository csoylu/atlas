import { useEffect, useState, type ReactNode } from 'react';
import type { Canvas } from '@atlas/shared';
import { api } from './api.ts';
import type { DetailContext } from './CardStepDetail.tsx';
import { canvasIdOf, canvasList, humanTimes, memoryFoot, scheduleCreated, scheduleList, thumbLayout, whenText } from './canvasRows.ts';
import type { Step } from './chatTurn.ts';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const canvasHref = (id: string) => '#/canvas/' + encodeURIComponent(id);

/**
 * The expanded view of a canvas, memory or schedule tool (#64, mockup pages/chat-activity.html §5): a canvas thumbnail
 * with Open, the canvas list, the memory quote, a schedule's when/prompt, the schedule list.
 * undefined = not one of them (the caller decides); null = nothing to expand (the row doesn't open).
 */
export function canvasDetail(step: Step, ctx: DetailContext): ReactNode | null | undefined {
  const o = (step.input && typeof step.input === 'object' ? step.input : {}) as Record<string, unknown>;
  const out = step.result && !step.result.isError ? step.result.content : null;
  switch (step.name) {
    case 'canvas_create':
    case 'canvas_write':
    case 'canvas_read': {
      const id = canvasIdOf(step.name, step.input, out);
      return id && out !== null ? <CanvasThumb id={id} /> : undefined;
    }
    case 'canvas_list': {
      if (out === null) return undefined;
      const list = canvasList(out);
      if (!list.length) return <p className="step-empty">No canvases.</p>;
      return (
        <div className="step-list">
          {list.map((c) => (
            <a key={c.id} className="step-list-row" href={canvasHref(c.id)} title="Open the canvas">
              <span className="step-list-t">{c.name}</span>
              <span className="step-list-m">
                {c.id} · v{c.version}
                {c.by ? ` · ${c.by}` : ''}
              </span>
            </a>
          ))}
        </div>
      );
    }
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
          <span>card</span>
          <span>{o.new_card_each_time === true ? 'a new card each run' : 'its own card, reopened each run'}</span>
          <span>prompt</span>
          <span className="step-kv-long">{str(o.prompt)}</span>
        </div>
      );
    }
    case 'schedule_list': {
      if (out === null) return undefined;
      const list = scheduleList(out);
      if (!list.length) return <p className="step-empty">No schedules.</p>;
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

const KINDS = new Set(['markdown', 'html', 'url', 'drawing']);

/** A canvas as boxes where its nodes are (fetched when the row opens), its id and version, and Open canvas. */
function CanvasThumb({ id }: { id: string }) {
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    api.canvas(id).then(
      (c) => on && setCanvas(c),
      (e) => on && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      on = false;
    };
  }, [id]);
  if (error) return <p className="step-empty err">Couldn’t load canvas {id}: {error}</p>;
  const layout = canvas && thumbLayout(canvas.nodes);
  const titles = canvas?.nodes.map((n) => n.title).filter(Boolean) ?? [];
  return (
    <div className="cv-step">
      <div className={'cv-thumb' + (canvas ? '' : ' loading')}>
        {layout ? (
          <svg viewBox={layout.viewBox} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`${canvas!.name}: ${canvas!.nodes.length} nodes`}>
            {layout.boxes.map((b) => (
              <rect key={b.id} className={'cv-k-' + (KINDS.has(b.kind) ? b.kind : 'other')} x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(b.w, b.h) * 0.06} vectorEffect="non-scaling-stroke">
                <title>{b.title || b.kind}</title>
              </rect>
            ))}
          </svg>
        ) : (
          canvas && <span className="cv-empty">Empty canvas</span>
        )}
      </div>
      <div className="cv-foot">
        <span className="cv-meta" title={titles.join(', ')}>
          {id}
          {canvas ? ` · v${canvas.version}` : ''}
          {titles.length ? ` · ${titles.join(', ')}` : ''}
        </span>
        <a className="chat-row-open" href={canvasHref(id)}>
          Open canvas ↗
        </a>
      </div>
    </div>
  );
}

/** Canvas names by id, from one list shared by every row; refetched once when a newer canvas isn't in it. */
let names: Promise<Map<string, string>> | null = null;
const refetched = new Set<string>();
const loadNames = () => (names ??= api.canvases().then((l) => new Map(l.map((c) => [c.id, c.name]))));
async function canvasName(id: string): Promise<string | undefined> {
  const m = await loadNames();
  if (m.has(id) || refetched.has(id)) return m.get(id);
  refetched.add(id);
  names = null;
  return (await loadNames()).get(id);
}

/** A row's canvas id shown as the canvas name (the id stays on hover); a failed lookup keeps the id and says why. */
export function CanvasName({ id }: { id: string }) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    canvasName(id).then(
      (n) => on && setName(n ?? null),
      (e) => {
        names = null;
        if (on) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      on = false;
    };
  }, [id]);
  return <span title={error ? `${id} (couldn’t load its name: ${error})` : id}>{name ?? id}</span>;
}
