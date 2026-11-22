import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { KIND_WORD, type Message, type ToolCallTiming, type parseDocRef } from '@atlas/shared';
import { useArtifactState } from './artifacts.ts';
import { ChatRow, PathObject, RowIconSvg, RowMeta } from './ChatRow.tsx';
import { isDangerous, todoList, type Artifact } from './cardModal.ts';
import { endedOnFailure, groupSummary, groupTurn, stepArtifact, type Segment, type Step } from './chatTurn.ts';
import { CardRefLink, cardDetail, type DetailContext, type TurnCards } from './CardStepDetail.tsx';
import { teamDetail } from './TeamStepDetail.tsx';
import { fileDetail, isLiveShell } from './FileStepDetail.tsx';
import { ImageThumbs } from './Images.tsx';
import { webDetail } from './WebStepDetail.tsx';
import { duration, type ToolOutcome } from './toolRows.ts';
import { SecretText, hiddenPill } from './SecretMarks.tsx';
import type { MessageStream } from './useMessages.ts';
import { KindIcon } from './Viewer.tsx';

/** A document part to show in the panel (CardPanel's MessageRef). */
type DocRef = NonNullable<ReturnType<typeof parseDocRef>>;

/**
 * One agent turn (#59): its text, tool calls as compact rows, « N steps » groups, and the pinned items (artifact
 * card, question, live plan). `live`: the turn's run is still going. `last`: no message after it (a group
 * that ended on a failure then opens on it).
 */
export function Turn(props: {
  messages: Message[];
  results: Map<string, ToolOutcome>;
  timings: Map<string, ToolCallTiming>;
  live: boolean;
  last: boolean;
  stream: MessageStream;
  renderText(text: string, key: string): ReactNode;
  onOpenArtifact?(ref: DocRef): void;
  /** Board cards: #N in a row opens its ticket, chips show the live status. */
  cards?: TurnCards;
  cardId?: string;
}) {
  const ctx = useMemo(() => ({ renderText: props.renderText, cards: props.cards, cardId: props.cardId }), [props.renderText, props.cards, props.cardId]);
  const segments = groupTurn(props.messages, props.results, { live: props.live, details: (id) => props.timings.get(id)?.detail });
  const failedEnd = props.last && !props.live ? endedOnFailure(segments) : null;
  const now = useNow(props.live);
  const at = props.messages[0]?.at;
  return (
    <TurnContext.Provider value={ctx}>
      {segments.map((s) => (
        <SegmentView key={keyOf(s)} s={s} {...props} now={now} at={at} failedEnd={failedEnd} />
      ))}
    </TurnContext.Provider>
  );
}

/** What a step's detail needs from the chat around it: markdown rendering and the board's cards. */
export const TurnContext = createContext<DetailContext>({ renderText: (t) => t });

const keyOf = (s: Segment) => (s.kind === 'text' || s.kind === 'group' ? s.key : s.step.id);

function SegmentView(p: Parameters<typeof Turn>[0] & { s: Segment; now: number; at?: string; failedEnd: Step | null }) {
  const { s } = p;
  if (s.kind === 'text') return <>{p.renderText(s.text, s.key)}</>;
  if (s.kind === 'group') return <StepsGroup steps={s.steps} timings={p.timings} now={p.now} at={s.steps[0]!.at} failedEnd={p.failedEnd} />;
  const plan = s.kind === 'pin' && s.pin === 'plan';
  const row = <StepRow step={s.step} timing={p.timings.get(s.step.id)} now={p.now} at={s.step.at} defaultOpen={plan} plan={plan} />;
  if (s.kind === 'step') return row;
  if (s.pin === 'doc') {
    // The artifact card alone (mockup #106): it says the kind, the version and « Updated to vN ».
    const art = stepArtifact(s.step);
    return art ? <ArtifactChip art={art} stream={p.stream} onOpen={p.onOpenArtifact} /> : row;
  }
  return row;
}

/** One tool call (or thinking block) as a row; nested inside a group's timeline. */
export function StepRow({ step, timing, now, at, nested, defaultOpen, forceOpen, plan }: { step: Step; timing?: ToolCallTiming; now: number; at?: string; nested?: boolean; defaultOpen?: boolean; forceOpen?: boolean; plan?: boolean }) {
  const { row } = step;
  const ctx = useContext(TurnContext);
  const { cards } = ctx;
  const running = step.state === 'running';
  const cut = step.state === 'cut';
  const plain = row.object === undefined ? undefined : row.dir !== undefined ? <PathObject dir={row.dir} name={row.object} /> : row.object;
  const object = row.ref ? (
    <>
      <CardRefLink ref_={row.ref} cards={cards} />
      {plain ? <> {plain}</> : null}
    </>
  ) : (
    plain
  );
  const hidden = timing?.secretsHidden ?? 0;
  const meta = [...row.meta, ...(hidden ? [{ pill: 'warn' as const, text: hiddenPill(hidden) }] : []), ...(cut ? [{ pill: 'warn' as const, text: 'not finished' }] : [])];
  return (
    <ChatRow
      icon={<RowIconSvg name={row.icon} />}
      verb={running ? row.running : row.verb}
      object={object}
      mono={row.mono}
      rest={row.rest}
      meta={<RowMeta meta={meta} time={elapsed(timing, now, running)} />}
      at={nested ? undefined : at}
      tone={cut ? 'warn' : row.tone}
      running={running}
      nested={nested}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      autoOpen={isLiveShell(step)}
      className={'step' + (plan ? ' plan' : '') + (step.kind === 'tool' && isDangerous(step.name, step.input) ? ' danger' : '')}
    >
      {ctx.cardId && step.result?.images?.length ? <ImageThumbs cardId={ctx.cardId} images={step.result.images} /> : null}
      {stepDetail(step, ctx, timing)}
    </ChatRow>
  );
}

/** « N steps »: icon stack, the key actions, +/− total, failures, duration; expands to a timeline of step rows. */
export function StepsGroup({ steps, timings, now, at, failedEnd }: { steps: Step[]; timings: Map<string, ToolCallTiming>; now: number; at: string; failedEnd: Step | null }) {
  const sum = groupSummary(steps);
  const running = !!sum.running;
  const opensOnFailure = !!failedEnd && steps.includes(failedEnd);
  const times = steps.flatMap((s) => {
    const t = timings.get(s.id);
    return t ? [t] : [];
  });
  const start = times.length ? Math.min(...times.map((t) => Date.parse(t.startedAt))) : NaN;
  const end = running ? now : times.length && times.every((t) => t.endedAt) ? Math.max(...times.map((t) => Date.parse(t.endedAt!))) : NaN;
  const time = duration(end - start);
  const icon = running ? null : (
    <span className="row-stack">
      {sum.icons.map((i) => (
        <span key={i} className={'row-stack-ic rowic-' + i}>
          <RowIconSvg name={i} />
        </span>
      ))}
    </span>
  );
  return (
    <ChatRow
      className="steps"
      icon={icon}
      verb={running ? 'Working' : `${sum.tools} steps`}
      rest={running ? `${sum.tools} steps · now: ${sum.running!.row.running} ${[sum.running!.row.ref, sum.running!.row.object].filter(Boolean).join(' ')}…` : sum.text}
      meta={<RowMeta meta={[{ add: sum.add, del: sum.del }, ...(sum.failed ? [{ pill: 'bad' as const, text: `${sum.failed} failed` }] : [])]} time={time} />}
      at={at}
      running={running}
      forceOpen={opensOnFailure || undefined}
      autoOpen={steps.some(isLiveShell)}
    >
      <div className="steps-tl">
        {steps.map((s) => (
          <StepRow key={s.id} step={s} timing={timings.get(s.id)} now={now} nested forceOpen={s === failedEnd || undefined} />
        ))}
      </div>
    </ChatRow>
  );
}

/**
 * A step's expanded view: web tools (#65), card & team tools (#62), files & shell (#63), memory and schedules (#64), the plan's
 * checklist, thinking text, else input JSON + output. null: nothing to expand.
 */
function stepDetail(step: Step, ctx: DetailContext, timing?: ToolCallTiming): ReactNode {
  if (step.kind === 'thinking') return <p className="step-thinking">{step.text}</p>;
  const web = webDetail(step);
  if (web !== undefined) return web;
  const card = step.result?.isError ? null : cardDetail(step, ctx);
  if (card) return card;
  const file = fileDetail(step, timing);
  if (file) return file;
  const other = step.result?.isError ? undefined : teamDetail(step, ctx);
  if (other !== undefined) return other;
  const todos = step.name === 'todo_write' ? todoList(step.input) : null;
  if (todos && !step.result?.isError)
    return (
      <ul className="todo-list">
        {todos.map((t, i) => (
          <li key={i} className={t.status}>
            <span className="todo-mark" aria-hidden="true">
              {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▸' : '☐'}
            </span>
            {t.content}
          </li>
        ))}
      </ul>
    );
  return (
    <>
      <pre className="step-in">{JSON.stringify(step.input, null, 2)}</pre>
      {step.result && (
        <pre className={'step-out' + (step.result.isError ? ' err' : '')}>
          <SecretText text={step.result.content} />
        </pre>
      )}
    </>
  );
}

/** Seconds the call took (≥ 1 s), or its live timer. */
function elapsed(t: ToolCallTiming | undefined, now: number, running: boolean): string | null {
  if (!t) return null;
  const end = t.endedAt ? Date.parse(t.endedAt) : running ? now : NaN;
  return duration(end - Date.parse(t.startedAt));
}

/** Date.now(), ticking every second while `on` (live timers). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/**
 * An artifact an agent created, updated or showed: a card in the thread (#120) that stays on its version. « Kind · vN »,
 * « Updated to vN · Kind » after an update, « · vM is the latest » once a newer version exists; clicking shows that
 * version in the panel.
 */
export function ArtifactChip({ art, stream, onOpen }: { art: Artifact; stream: MessageStream; onOpen?(ref: DocRef): void }) {
  const { latest, deleted } = useArtifactState(art.docId, stream);
  // Deleted for good (#242): the card stays in the thread, says so, and opens nothing.
  if (deleted)
    return (
      <div className="artifact deleted" title={`${art.title} was deleted`}>
        <span className={'art-icon ' + art.kind} aria-hidden="true">
          <KindIcon kind={art.kind} />
        </span>
        <span className="art-text">
          <span className="art-title">{art.title}</span>
          <span className="art-meta">Deleted artifact · {KIND_WORD[art.kind]} · v{art.version}</span>
        </span>
      </div>
    );
  const body = (
    <>
      <span className={'art-icon ' + art.kind} aria-hidden="true">
        <KindIcon kind={art.kind} />
      </span>
      <span className="art-text">
        <span className="art-title">{art.title}</span>
        <span className="art-meta">
          {art.updated ? (
            <>
              <span className="art-upd">Updated to v{art.version}</span> · {KIND_WORD[art.kind]}
            </>
          ) : (
            `${KIND_WORD[art.kind]} · v${art.version}`
          )}
          {art.section ? ` · #${art.section}` : ''}
          {latest !== null && latest > art.version && <span className="art-old"> · v{latest} is the latest</span>}
        </span>
      </span>
    </>
  );
  return onOpen ? (
    <button type="button" className="artifact" title={`Open v${art.version}`} onClick={() => onOpen({ docId: art.docId, version: art.version, section: art.section, label: art.title })}>
      {body}
      <span className="art-open">Open</span>
    </button>
  ) : (
    <div className="artifact">{body}</div>
  );
}
