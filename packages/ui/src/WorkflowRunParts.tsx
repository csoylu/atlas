import { useEffect, useMemo, useRef, useState } from 'react';
import { cardRef, type Card, type RunWorkflow, type TaskWorkflow, type Workflow, type WorkflowRun, type WorkflowRunContext } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { chipClass, prLabel, refOf, RUN_LABEL, startedBy, STATE_LABEL } from './workflowView.ts';

/**
 * Workflows v2 stage 1 (#259, mockup doc_bf5e40e1 « Workflows v2 »): what started a run, « What the run knows », the
 * loop guard banner, « Run on a task… / Run on a PR… », and the task view's « Workflows on this task ».
 */

export const PLAY = (
  <svg className="icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 3.2v9.6L12.6 8z" />
  </svg>
);

/** « #237 asks for review », « PR #74 finishes CI », « by hand »: what started the run, its subject a link. */
export function RunStart({ run, cards, onOpenCard }: { run: WorkflowRun; cards: Card[]; onOpenCard(id: string): void }) {
  const s = run.subject;
  const how = startedBy(run);
  if (!s) return <span className="wf-start">{how}</span>;
  return (
    <span className="wf-start">
      {s.prUrl ? (
        <a href={s.prUrl} target="_blank" rel="noreferrer">
          {prLabel(s.prUrl)}
        </a>
      ) : (
        <button className="linklike" onClick={() => onOpenCard(s.cardId)}>
          {refOf(s.cardId, cards)}
        </button>
      )}
      {run.trigger === 'manual' ? ' · by hand' : ' ' + how}
      {s.prUrl && (
        <>
          {' · '}
          <button className="linklike" onClick={() => onOpenCard(s.cardId)}>
            {refOf(s.cardId, cards)}
          </button>
        </>
      )}
    </span>
  );
}

/** « What the run knows » (#259): the run's context as Project / Task / Pull request lines, every field on demand, Copy as JSON. */
export function RunKnows({ run, onError }: { run: WorkflowRun; onError(e: unknown): void }) {
  const [ctx, setCtx] = useState<WorkflowRunContext | null>(null);
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  // Refetched when a step ends (its exit and summary join the context).
  const ended = (run.steps ?? []).filter((s) => s.endedAt).length;
  const err = useRef(onError);
  err.current = onError;
  useEffect(() => {
    api.workflowRunContext(run.id).then(setCtx, (e) => err.current(e));
  }, [run.id, ended]);
  if (!ctx) return null;
  const f = ctx.fields;
  const join = (...xs: (string | undefined)[]) => xs.filter(Boolean).join(' · ');
  const rows: [string, string][] = [];
  if (f['project.name']) rows.push(['Project', f['project.name']]);
  if (f['task.ref']) rows.push(['Task', join(`${f['task.ref']} ${f['task.title'] ?? ''}`.trim(), f['task.status'], f['task.assignee'] && '@' + f['task.assignee'])]);
  if (f['pr.url']) rows.push(['Pull request', join(f['pr.number'] ? `PR #${f['pr.number']}` : f['pr.url'], f['pr.ci'] && `CI ${f['pr.ci']}`, f['pr.state'], f['pr.head']?.slice(0, 7))]);
  if (f['event.name']) rows.push(['Event', join(f['event.name'], f['event.from'] && f['event.to'] ? `${f['event.from']} → ${f['event.to']}` : f['event.to'], f['event.by'] && 'by ' + f['event.by'])]);
  const keys = Object.keys(f).sort();
  return (
    <div className="wf-knows">
      <span className="lbl">What the run knows</span>
      {all ? (
        <dl className="wf-kv mono">
          {keys.map((k) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd title={f[k]}>{f[k] || '—'}</dd>
            </div>
          ))}
        </dl>
      ) : rows.length ? (
        <dl className="wf-kv">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd title={v}>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="wf-sum">No task, PR or project: a run by hand on nothing.</p>
      )}
      <div className="wf-knows-acts">
        <button
          className="btn ghost small"
          onClick={() =>
            navigator.clipboard.writeText(JSON.stringify(f, null, 2)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }, onError)
          }
        >
          {copied ? 'Copied' : 'Copy as JSON'}
        </button>
        <button className="btn ghost small" aria-pressed={all} onClick={() => setAll(!all)}>
          {all ? 'Fewer fields' : `All ${keys.length} fields`}
        </button>
      </div>
    </div>
  );
}

/** The canvas banner of a workflow the loop guard turned off (#258), with Turn back on and Change the limit. */
export function LoopGuardBanner({ w, onLimit, onError }: { w: Workflow; onLimit(): void; onError(e: unknown): void }) {
  return (
    <div className="wf-guard" role="alert">
      <b>Stopped by the loop guard.</b> {w.lastError?.replace(/^loop guard: /, '')}. It is off until you turn it back on.
      <div className="wf-guard-acts">
        <button className="btn primary small" onClick={() => api.updateWorkflow(w.id, { enabled: true }).catch(onError)}>
          Turn back on
        </button>
        <button className="btn ghost small" onClick={onLimit}>
          Change the limit
        </button>
      </div>
    </div>
  );
}

/** « Run on a task… » / « Run on a PR… »: pick what the run is about (the project's tasks, their linked PRs). */
export function RunOnPicker(props: { kind: 'task' | 'pr'; w: Workflow; cards: Card[]; onRun(on: RunWorkflow): void; onClose(): void }) {
  const { kind, w } = props;
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const out = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.wf-runbtn') && props.onClose();
    window.addEventListener('pointerdown', out);
    return () => window.removeEventListener('pointerdown', out);
  });
  const mine = (c: Card) => c.status !== 'archived' && (!w.projectId || c.projectId === w.projectId);
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    const cards = props.cards.filter(mine).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (kind === 'task')
      return cards
        .filter((c) => !t || c.title.toLowerCase().includes(t) || cardRef(c).includes(t))
        .slice(0, 8)
        .map((c) => ({ key: c.id, on: { task: c.id } as RunWorkflow, ref: cardRef(c), text: c.title }));
    return cards
      .flatMap((c) => (c.prs ?? []).filter((p) => p.state === 'open').map((p) => ({ c, p })))
      .filter(({ c, p }) => !t || `${p.number}`.includes(t.replace('#', '')) || c.title.toLowerCase().includes(t) || p.repo.includes(t))
      .slice(0, 8)
      .map(({ c, p }) => ({ key: p.url, on: { pr: p.url } as RunWorkflow, ref: `PR #${p.number}`, text: `${cardRef(c)} ${c.title}` }));
  }, [q, kind, props.cards, w.projectId]);
  return (
    <div className="wf-runon" ref={ref} role="dialog" aria-label={kind === 'task' ? 'Run on a task' : 'Run on a pull request'} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={kind === 'task' ? 'Search a task: #12 or words' : 'Search an open PR: number, repo or task'} aria-label="Search" />
      <div className="wf-runon-list">
        {items.map((x) => (
          <button key={x.key} onClick={() => props.onRun(x.on)}>
            <span className="ref">{x.ref}</span>
            <span className="tx">{x.text}</span>
          </button>
        ))}
        {!items.length && <p className="wf-sum">{kind === 'task' ? 'No task matches.' : 'No open pull request linked to a task here.'}</p>}
      </div>
      <button className="btn ghost small" onClick={() => props.onRun({})}>
        Run without a {kind === 'task' ? 'task' : 'PR'}
      </button>
    </div>
  );
}

/** The task view's « Workflows on this task » (#259): each workflow acting on it now, its current step, a link to the run. */
export function TaskWorkflows({ cardId, cards, stream, onOpenCard, onError }: { cardId: string; cards: Card[]; stream: MessageStream; onOpenCard(id: string): void; onError(e: unknown): void }) {
  const [list, setList] = useState<TaskWorkflow[]>([]);
  const [tick, setTick] = useState(0);
  const err = useRef(onError);
  err.current = onError;
  useEffect(() => {
    api.cardWorkflows(cardId).then(setList, (e) => err.current(e));
  }, [cardId, tick]);
  // Any run that starts, moves or ends may be about this task: read the list again.
  useEffect(() => stream.listen('workflow-runs', () => setTick((n) => n + 1)), [stream]);
  if (!list.length) return null;
  return (
    <section className="cm-wfnow" aria-label="Workflows on this task">
      <span className="lbl">Workflows on this task</span>
      {list.map((x) => (
        <div key={x.runId} className="row">
          <div className="main">
            <b>{x.workflowName}</b>
            <span className="muted"> · run {x.runNumber}</span>
            <div className="step">
              {x.step?.couldntRun ? (
                <span className="st-chip failed">Couldn't run</span>
              ) : (
                <span className={'st-chip ' + chipClass(x.state)}>{x.step?.state === 'waiting' ? STATE_LABEL.waiting : RUN_LABEL[x.state]}</span>
              )}
              {x.step && <span>{x.step.title}</span>}
              {x.step?.couldntRun && <span className="wf-couldnt-why">{x.step.couldntRun} · Retry now or follow its negative exit in the run</span>}
              {x.step?.cardId && x.step.cardId !== cardId && (
                <button className="linklike" onClick={() => onOpenCard(x.step!.cardId!)}>
                  {refOf(x.step.cardId, cards)}
                </button>
              )}
            </div>
          </div>
          <a className="wf-openrun" href={`#/workflows/${encodeURIComponent(x.workflowId)}/runs/${encodeURIComponent(x.runId)}`}>
            Open the run
          </a>
        </div>
      ))}
    </section>
  );
}
