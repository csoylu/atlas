import { Fragment, forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentFace } from './AgentFace.tsx';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { USER, parseDocRef, type Agent, type Card, type Message, type Model, type Run, type Timeline, type ToolCallTiming } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { submitOnEnter } from './composerKeys.ts';
import { ComposerMeta, useChatUsage } from './Usage.tsx';
import { CARD_HREF, findCard, linkCardIds, linkCardRefsMd } from './cardModal.ts';
import { StepRow, Turn } from './ChatActivity.tsx';
import { draftSegments, turns, type Segment } from './chatTurn.ts';
import type { ToolOutcome } from './toolRows.ts';
import { sysLine } from './chatPins.ts';
import { webSearchResult } from './webRows.ts';
import { ChatPins } from './ChatPins.tsx';
import { ChatRow } from './ChatRow.tsx';
import { parseReport, rowTime } from './chatRow.ts';
import { HeaderActions, Icon } from './ScreenHeader.tsx';
import { StatusIcon } from './StatusIcon.tsx';
import type { Quote } from './DocPanel.tsx';
import { draftKey, readDraft, useDraft, writeDraft } from './drafts.ts';
import { useAutoGrow } from './useAutoGrow.ts';
import { RewindConfirm, RewindIcon, RewindNote, useRewind, type Rewind } from './Rewind.tsx';
import { distribute, messageRow, timelineRows, type SysRow } from './sysRows.ts';
import { SystemRow } from './SystemRow.tsx';
import { focusSeqFor, groupForSeq } from './memoryView.ts';
import { NO_DRAFT, addDelta, draftMarkdown, rehypeCaret, useThrottledDraft, type Draft } from './streamDraft.ts';

/** The message `?msg=<seq>` in the URL asks this conversation to show (a memory's source link), followed live. */
function useFocusSeq(cardId: string): number | null {
  const [seq, setSeq] = useState(() => (typeof location === 'undefined' ? null : focusSeqFor(location.hash, cardId))); // no location: server render in tests
  useEffect(() => {
    const on = () => setSeq(focusSeqFor(location.hash, cardId));
    on();
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [cardId]);
  return seq;
}

/** A document reference in a message (« ❝ Doc › Section »). */
export type MessageRef = NonNullable<ReturnType<typeof parseDocRef>>;

/** Live state of a card's conversation: messages, the streaming draft (thinking and text, in order), the latest run, tool results and timings by id. */
export function useCardConversation(card: Card, stream: MessageStream, onError: (e: unknown) => void) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [draft, setDraft] = useState<Draft>(NO_DRAFT);
  const [timings, setTimings] = useState<Map<string, ToolCallTiming>>(new Map());
  const [timeline, setTimeline] = useState<Timeline>(NO_TIMELINE);
  const lastRun = useRef('');
  // Messages that arrived live (stream), not with the history load: a card report among them gets the arrival animation (#104).
  const live = useRef(new Set<string>());
  useEffect(() => {
    live.current = new Set();
    setTimings(new Map());
    setTimeline(NO_TIMELINE);
    // Ended runs, rewinds, the summary point (#66): reloaded when a run starts or ends and after a rewind or its undo.
    const reloadTimeline = () => api.timeline(card.id).then(setTimeline, onError);
    const offMsg = stream.listen(card.conversationId, (e) => {
      if (e.type === 'message') {
        setMessages((ms) => {
          if (ms.some((x) => x.id === e.message.id)) return ms;
          live.current.add(e.message.id);
          return [...ms, e.message];
        });
        if (e.message.role === 'assistant') setDraft(NO_DRAFT);
      } else if (e.type === 'delta' || e.type === 'thinking') setDraft((d) => addDelta(d, e.type === 'delta' ? 'text' : 'thinking', e.text));
      else if (e.type === 'rewound') {
        // Hidden (or brought back) by a rewind: the server's list is the truth.
        setDraft(NO_DRAFT);
        api.messages(card.id).then(setMessages, onError);
        void reloadTimeline();
      }
    });
    const offRun = stream.listen(card.id, (e) => {
      if (e.type === 'toolcall') setTimings((t) => new Map(t).set(e.call.toolUseId, e.call));
      if (e.type !== 'run') return;
      const key = e.run.id + ':' + e.run.status;
      if (lastRun.current !== key) void reloadTimeline();
      lastRun.current = key;
      setRun(e.run);
      if (e.run.status !== 'running') setDraft(NO_DRAFT);
    });
    api.messages(card.id).then((ms) => setMessages((live) => merge(ms, live)), onError);
    api.runs(card.id).then((rs) => setRun((live) => live ?? rs[0] ?? null), onError);
    void reloadTimeline();
    // Live events win over the initial load (a call that ended meanwhile).
    api.toolCalls(card.id).then((cs) => setTimings((live) => new Map([...cs.map((c) => [c.toolUseId, c] as const), ...live])), onError);
    return () => {
      offMsg();
      offRun();
    };
  }, [card.id, card.conversationId, stream, onError]);
  const results = useMemo(() => {
    const map = new Map<string, ToolOutcome>();
    for (const m of messages)
      for (const b of m.content) {
        if (b.type === 'tool_result') map.set(b.tool_use_id, { content: b.content, isError: !!b.is_error });
        else if (b.type === 'web_search_tool_result') map.set(b.tool_use_id, webSearchResult(b.content));
      }
    return map;
  }, [messages]);
  const isLive = useCallback((id: string) => live.current.has(id), []);
  return { messages, run, draft, results, timings, timeline, isLive };
}

const NO_TIMELINE: Timeline = { runs: [], rewinds: [], summary: null };

type Conversation = ReturnType<typeof useCardConversation>;

/** The direct chat pane (ChatView): the conversation with the chat's agent, no card fields. Cards open in CardModal. */
export function CardPanel(props: {
  card: Card;
  /** Opens a card (links in system lines) in the ticket modal. */
  onOpen(id: string): void;
  agents: Agent[];
  stream: MessageStream;
  onClose(): void;
  onError(e: unknown): void;
  /** The card's agent runs on the user's ChatGPT plan: say so by the composer (OpenAI's guidelines). */
  plan?: boolean;
  /** All models, for the model chooser above the composer. */
  models: Model[];
  /** The user's name, shown above their messages. */
  userName?: string | null;
  /** All board cards: the ones this chat created are pinned at its top-left. */
  cards: Card[];
  /** « Ask about this » from the side panel: shown as a chip in the composer, sent with the message. */
  quote?: Quote | null;
  onQuoteClear?(): void;
  /** `/clear` typed in a direct chat's composer: start a fresh main chat with the agent. */
  onClear?(agentId: string): void;
  /** Tabs open in a hidden side panel (overlay mode): a button brings it back. */
  hiddenDocs?: number;
  onShowDocs?(): void;
  /** The side panel is on screen: a header button hides it (⌘\ toggles). */
  onHideDocs?(): void;
  /** A quote chip in a message was clicked: open that document part in the panel. */
  onOpenRef?(ref: MessageRef): void;
}) {
  const { card, stream, onError } = props;
  const convo = useCardConversation(card, stream, onError);
  const rw = useRewind(card, convo.run, onError, { globalEsc: true });
  return (
    <aside className={'panel chat-pane' + (props.hiddenDocs ? ' has-docs' : '')}>
      <HeaderActions>
        {!!props.hiddenDocs && (
          <button type="button" className="head-btn doc-reopen" onClick={props.onShowDocs} title="Show the documents panel (⌘\)">
            <Icon.doc /> Documents · {props.hiddenDocs}
          </button>
        )}
        {props.onHideDocs && (
          <button type="button" className="icon-btn doc-hide" onClick={props.onHideDocs} aria-label="Hide the documents panel" title="Hide the documents panel (⌘\)">
            <Icon.panel />
          </button>
        )}
        <button
          type="button"
          className="icon-btn danger chat-delete"
          aria-label="Delete chat"
          title="Delete chat"
          onClick={() => {
            if (confirm(`Delete the chat “${card.title}”?`)) api.deleteCard(card.id).then(props.onClose, onError);
          }}
        >
          <Icon.trash />
        </button>
      </HeaderActions>
      <ChatPins chatId={card.id} cards={props.cards} stream={stream} onOpen={props.onOpen} onError={onError} />
      <CardNotices card={card} onError={onError} />
      <div className="chat">
        <Activity
          convo={convo}
          card={card}
          stream={stream}
          userName={props.userName}
          onOpenCard={props.onOpen}
          cards={props.cards}
          onOpenRef={props.onOpenRef}
          onRewind={rw.ask}
          onUndo={rw.undoById}
          onError={onError}
          empty={`Ask @${card.assignee} anything. For work to track, it creates tasks.`}
        />
      </div>
      <RewindNote rw={rw} />
      {!rw.hideRun && <RunLine run={convo.run} onStop={() => void rw.stopTurn()} />}
      <CardComposer card={card} agents={props.agents} models={props.models} plan={!!props.plan} stream={stream} onError={onError} quote={props.quote} onQuoteClear={props.onQuoteClear} onClear={props.onClear} rewind={rw} />
      <RewindConfirm rw={rw} />
    </aside>
  );
}

/** The plain-words reason a card isn't moving (a question or review shows in the conversation, see AskMessage). */
export function CardNotices({ card, onError }: { card: Card; onError(e: unknown): void }) {
  if (!card.waiting || card.block || card.status === 'review') return null;
  return (
    <div className="waiting-line">
      {card.waiting}
      {card.waiting.includes('Retry') && (
        <button className="ghost retry" onClick={() => api.retry(card.id).catch(onError)}>
          Retry
        </button>
      )}
    </div>
  );
}

const msgText = (m: Message | undefined) => m?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim() ?? '';

/**
 * What the card waits on from the user: its block question (with the suggested answers) or a review. Shown as the
 * last message of the conversation, highlighted, not as a separate box. When the question is the agent's last
 * message (a run that ended with text), that message is the one highlighted, not repeated.
 */
const AskMessage = forwardRef<HTMLDivElement, { card: Card; children?: ReactNode; onError(e: unknown): void }>(function AskMessage({ card, children, onError }, ref) {
  const send = (t: string) => api.postMessage(card.id, t).catch(onError);
  const b = card.block;
  return (
    <div ref={ref} className={'msg assistant asking ' + (b ? b.kind : 'review')}>
      <div className="who">
        {card.assignee && <><AgentFace id={card.assignee} />{card.assignee} · </>}
        <span className="ask-kind">{b ? blockLabel[b.kind] : 'Waiting for your review'}</span>
      </div>
      <div className="msg-body">
        {children}
        <div className="options">
          {b?.options.map((o, i) => (
            <button key={o} className={i === 0 ? 'option recommended' : 'option'} onClick={() => send(o)}>
              {o}
              {i === 0 && <span className="rec">recommended</span>}
            </button>
          ))}
          {!b && (
            <button className="option recommended" onClick={() => api.updateCard(card.id, { status: 'done' }).catch(onError)}>
              Approve → done
            </button>
          )}
          {b && b.kind !== 'needs_input' && (
            <button className="option" onClick={() => api.retry(card.id).catch(onError)}>
              Retry now
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

/** The conversation: messages, tool calls as quiet lines (dangerous ones red), system lines with card links. */
export function Activity(props: {
  convo: Conversation;
  card: Card;
  stream: MessageStream;
  userName?: string | null;
  empty: string;
  onOpenCard?(id: string): void;
  onOpenRef?(ref: MessageRef): void;
  /** Board cards: #N references to them in messages become links that open the card. */
  cards?: Card[];
  /** « Rewind to here » on the user's messages. */
  onRewind?(seq: number): void;
  /** Undo on a rewind's row (the chat's rewind state, so the composer empties too); else the API directly. */
  onUndo?(rewindId: string): Promise<unknown>;
  /** Failed answers from the question's buttons (option, approve, retry). */
  onError(e: unknown): void;
}) {
  const { messages, results, timings, run, timeline } = props.convo;
  // The streaming reply, re-rendered as markdown at most every few dozen ms (#79): its thinking rows above its text (#80).
  const shownDraft = useThrottledDraft(props.convo.draft);
  const draftSegs = useMemo(() => draftSegments(shownDraft), [shownDraft]);
  const draft = draftSegs.length > 0;
  const { cards, onOpenCard } = props;
  // A reference opens the card it names (by id); unknown ones stay plain text.
  const cardLinks = useMemo(
    () =>
      cards && onOpenCard
        ? { known: (ref: string) => !!findCard(cards, ref), open: (ref: string) => onOpenCard(findCard(cards, ref)?.id ?? ref), card: (ref: string) => findCard(cards, ref) }
        : undefined,
    [cards, onOpenCard],
  );
  const end = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLDivElement>(null);
  const { card } = props;
  const shown = messages.filter((m) => m.author !== 'tool');
  const asking = !!card.block || card.status === 'review';
  // The question is the agent's last message: highlight that one instead of repeating it.
  const last = shown.at(-1);
  const inline = !!card.block && !draft && last?.role === 'assistant' && msgText(last) === card.block.reason.trim();
  const list = inline ? shown.slice(0, -1) : shown;
  // Opens at the question's start (a long one is read from its top), else at the end of the conversation.
  // Block body on purpose: scrollIntoView returns a Promise in recent Chromium, which must not become the cleanup.
  useEffect(() => {
    if (askRef.current) askRef.current.scrollIntoView({ block: 'start' });
    else end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, shownDraft, asking, card.block?.reason]);
  // A memory's source link (?msg=<seq>, #82): scroll to that message once it is loaded and flash it.
  const focusSeq = useFocusSeq(card.id);
  const focusDone = useRef<number | null>(null);
  const listBox = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (focusSeq === null) return void (focusDone.current = null);
    if (focusDone.current === focusSeq || !messages.length) return;
    const root = listBox.current?.parentElement;
    const els = [...(root?.querySelectorAll<HTMLElement>('[data-seq]') ?? [])];
    const el = els[groupForSeq(els.map((e) => Number(e.dataset.seq)), focusSeq)];
    if (!el) return;
    focusDone.current = focusSeq;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }, [focusSeq, messages.length]);
  const text = (t: string, key?: string, user?: boolean) => <TextBlock key={key} text={t} onOpenRef={user ? props.onOpenRef : undefined} quotes={user} cardLinks={cardLinks} />;
  const renderText = useCallback((t: string, key: string) => <TextBlock key={key} text={t} cardLinks={cardLinks} />, [cardLinks]);
  const renderTurn = (ms: Message[], live: boolean, last: boolean) => (
    <Turn messages={ms} results={results} timings={timings} live={live} last={last} stream={props.stream} renderText={renderText} onOpenArtifact={props.onOpenRef} cards={cardLinks} />
  );
  const isAgent = (m: Message) => m.role === 'assistant';
  const groups = turns(list, isAgent);
  const running = run?.status === 'running';
  // System events between turns (#66): ended runs, rewinds, the summary point, each after the group it follows.
  const placed = distribute(
    groups.map((g) => g[0]!.seq),
    timelineRows(timeline, messages, { latestRunId: run?.id ?? null, running, hhmm: (iso) => rowTime(iso) }),
  );
  // Where the streaming reply shows: inside the last group when it's this agent's turn (see draftHere), else as its own message.
  const lastGroup = groups.at(-1)?.[0];
  const draftJoined =
    draft && !!lastGroup && isAgent(lastGroup) && lastGroup.author === card.assignee && lastGroup.author !== 'system' && !messageRow(lastGroup, card.assignee) && !placed.after[groups.length - 1]!.length;
  const sysRow = (r: SysRow) => (
    <SystemRow
      key={r.key}
      row={r}
      cards={cardLinks}
      renderText={(t) => text(t)}
      onRetry={() => api.retry(card.id).catch(props.onError)}
      onUndo={(id) => (props.onUndo ? props.onUndo(id) : api.undoRewind(id)).catch(props.onError)}
    />
  );
  return (
    <>
      <span ref={listBox} hidden />
      {messages.length === 0 && !asking && <p className="empty">{props.empty}</p>}
      {placed.before.map(sysRow)}
      {groups.map((ms, i) => {
        const m = ms[0]!;
        const prev = groups[i - 1]?.[0];
        const after = placed.after[i]!.map(sysRow);
        const event = messageRow(m, card.assignee);
        if (event)
          return (
            <Fragment key={m.id}>
              {sysRow(event)}
              {after}
            </Fragment>
          );
        if (m.author === 'system')
          return (
            <Fragment key={m.id}>
              <SystemMessage message={m} landed={props.convo.isLive(m.id)} onOpenCard={cardLinks?.open ?? props.onOpenCard} renderBody={(t) => text(t)} />
              {after}
            </Fragment>
          );
        const last = i === groups.length - 1 && !inline;
        // The reply streaming after this agent turn joins it, as the final message will (no jump when it lands).
        const draftHere = draftJoined && i === groups.length - 1;
        // A run of the same author continues the bubble; a system row in between starts a new one.
        const cont = prev?.author === m.author && !placed.after[i - 1]?.length;
        return (
          <Fragment key={m.id}>
          <div className={'msg ' + m.role + (cont ? ' cont' : '')} data-seq={m.seq}>
            {!cont && <div className="who">{m.author === USER ? (props.userName ?? 'You') : <><AgentFace id={m.author} />{m.author}</>}</div>}
            <div className="msg-body">
              {isAgent(m) ? renderTurn(ms, running && last, last) : m.content.map((b, k) => (b.type === 'text' ? text(b.text, String(k), m.author === USER) : null))}
              {draftHere && <DraftView segments={draftSegs} cardLinks={cardLinks} />}
              {m.author === USER && props.onRewind && (
                <div className="msg-actions">
                  <button type="button" className="msg-action" onClick={() => props.onRewind!(m.seq)} aria-label="Rewind to here" title="Rewind to here: hide this message and the rest, put the agent's files back">
                    <RewindIcon />
                  </button>
                </div>
              )}
            </div>
          </div>
          {after}
          </Fragment>
        );
      })}
      {draft && !draftJoined && (
        <div className="msg assistant">
          <div className="who">{card.assignee && <AgentFace id={card.assignee} />}{card.assignee}</div>
          <div className="msg-body">
            <DraftView segments={draftSegs} cardLinks={cardLinks} />
          </div>
        </div>
      )}
      {asking && !draft && (
        <AskMessage ref={askRef} card={card} onError={props.onError}>
          {inline ? renderTurn([last!], false, false) : card.block && text(card.block.reason)}
        </AskMessage>
      )}
      <div ref={end} />
    </>
  );
}

/** The streaming answer: live thinking rows (the saved step's look) and text, the last text with the caret. */
function DraftView({ segments, cardLinks }: { segments: Segment[]; cardLinks?: CardLinks }) {
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'text' ? (
          <TextBlock key={s.key} text={s.text} cardLinks={cardLinks} streaming={i === segments.length - 1} />
        ) : s.kind === 'step' ? (
          <StepRow key={s.step.id} step={s.step} now={0} at={s.step.at} />
        ) : null,
      )}
    </>
  );
}

/** A system message: a card report-back is one compact row that expands to the full report; anything else a note. */
function SystemMessage({ message: m, landed, onOpenCard, renderBody }: { message: Message; landed?: boolean; onOpenCard?(id: string): void; renderBody(text: string): ReactNode }) {
  const text = m.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
  const r = parseReport(text);
  if (!r) return <SysNote text={text} onOpenCard={onOpenCard} />;
  const ref = onOpenCard ? (
    <button
      type="button"
      className="chat-row-ref"
      title="Open the ticket"
      onClick={(e) => {
        e.stopPropagation();
        onOpenCard(r.card);
      }}
    >
      {r.card}
    </button>
  ) : (
    <span className="chat-row-ref">{r.card}</span>
  );
  // A finished task reads « #99 [Done] » (#104); the other reports keep their verb.
  const done = r.verb === 'finished';
  return (
    <ChatRow
      className={'card-report' + (done ? ' done' : '') + (landed ? ' landed' : '')}
      icon={<StatusIcon status={r.icon} />}
      verb={
        done ? (
          <>
            {ref} <span className="st-chip done">Done</span>
          </>
        ) : (
          <>
            {ref} {r.verb}
          </>
        )
      }
      object={r.title}
      at={m.at}
      tone={r.tone}
    >
      {(r.body || onOpenCard) && (
        <>
          {r.body && renderBody(r.body)}
          {onOpenCard && (
            <button type="button" className="chat-row-open" onClick={() => onOpenCard(r.card)}>
              Open ticket ↗
            </button>
          )}
        </>
      )}
    </ChatRow>
  );
}

/** A system line; a report-back about a card ("✓ Card “X” finished") opens that card when clicked. */
function SysNote({ text, onOpenCard }: { text: string; onOpenCard?(id: string): void }) {
  const line = onOpenCard ? sysLine(text) : { card: null, text };
  const parts = linkCardIds(line.text).map((part, j) =>
    typeof part === 'string' || !onOpenCard ? (
      <span key={j}>{typeof part === 'string' ? part : part.card}</span>
    ) : (
      <button
        key={j}
        type="button"
        className="sys-link"
        onClick={(e) => {
          e.stopPropagation();
          onOpenCard(part.card);
        }}
      >
        {part.card}
      </button>
    ),
  );
  if (!line.card || !onOpenCard) return <div className="sys-note">{parts}</div>;
  const open = () => onOpenCard(line.card!);
  return (
    <div
      className="sys-note open"
      role="button"
      tabIndex={0}
      title="Open the task"
      onClick={open}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          open();
        }
      }}
    >
      {parts}
      <span className="sys-open"> · open</span>
    </div>
  );
}

/** "@x is working…" with Stop. How a run ended is a row in the conversation (#66: stopped, failed, interrupted). */
export function RunLine({ run, onStop, stop = true }: { run: Run | null; onStop(): void; stop?: boolean }) {
  if (run?.status !== 'running') return null;
  return (
    <div className="run-status running">
      <span className="pulse" /> @{run.agentId} is working…
      {stop && (
        <button className="ghost" onClick={onStop}>
          Stop
        </button>
      )}
    </div>
  );
}

/** Message box for the card's agent, with usage and the model/effort chooser. */
export const CardComposer = forwardRef<
  HTMLTextAreaElement,
  { card: Card; agents: Agent[]; models: Model[]; plan: boolean; stream: MessageStream; onError(e: unknown): void; quote?: Quote | null; onQuoteClear?(): void; onClear?(agentId: string): void; rewind?: Rewind }
>(
  function CardComposer({ card, agents, models, plan, stream, onError, quote, onQuoteClear, onClear, rewind }, ref) {
    const draftId = draftKey('card', card.id);
    const [text, setText] = useDraft(draftId);
    const box = useRef<HTMLTextAreaElement | null>(null);
    useAutoGrow(box, text);
    // A rewind put the message back (or its undo took it away): fill the box, cursor at the end.
    const fill = rewind?.fill;
    useEffect(() => {
      if (!fill) return;
      setText((t) => (fill.ifText === undefined || t === fill.ifText ? fill.text : t));
      requestAnimationFrame(() => {
        const el = box.current;
        if (!el || fill.ifText !== undefined) return;
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
        el.scrollTop = el.scrollHeight;
      });
    }, [fill]);
    const usage = useChatUsage(card.id, stream, onError);
    const agent = agents.find((a) => a.id === card.assignee);
    return (
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          // `/clear` (typed, never voice) in a direct chat: a fresh main chat; this one stays in History.
          if (t === '/clear' && onClear && card.board === 'direct' && card.assignee) {
            setText('');
            onClear(card.assignee);
            return;
          }
          setText('');
          onQuoteClear?.();
          rewind?.sent();
          // A failed send puts the text back (unless the user already started a new message).
          void api.postMessage(card.id, t, quote?.ref).catch((err: unknown) => {
            if (!readDraft(draftId).trim()) writeDraft(draftId, text); // the composer may be gone already
            setText((cur) => (cur.trim() ? cur : text));
            onError(err);
          });
        }}
      >
        {quote && (
          <div className="quote-chip" title="Your message is about this part of the document">
            <span aria-hidden="true">❝</span>
            <span className="quote-chip-label">{quote.label}</span>
            <button type="button" aria-label="Remove the quote" onClick={onQuoteClear}>
              ×
            </button>
          </div>
        )}
        <textarea
          ref={(el) => {
            box.current = el;
            if (typeof ref === 'function') ref(el);
            else if (ref) ref.current = el;
          }}
          value={text}
          placeholder={card.assignee ? `Message @${card.assignee}…  (Enter to send · Shift+Enter for newline)` : 'Assign an agent, then write to it here…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (rewind?.composerKey(e.nativeEvent, text)) return;
            submitOnEnter(e);
          }}
        />
        <ComposerMeta
          usage={usage}
          plan={plan}
          send={{ disabled: !text.trim() }}
          pick={{
            models,
            agentModelId: agent?.modelId ?? null,
            modelId: card.modelId,
            effort: card.effort,
            onChange: (p) => void api.updateCard(card.id, p).catch(onError),
          }}
        />
      </form>
    );
  },
);

const blockLabel: Record<NonNullable<Card['block']>['kind'], string> = {
  needs_input: 'Question for you',
  dependency: 'Waiting on other work',
  capability: 'Missing access or a broken setup',
  transient: 'Temporary problem, will retry',
};

/** #N references in a message: which ones are cards, and how to open one. */
type CardLinks = { known(ref: string): boolean; open(ref: string): void; card?(ref: string): Card | undefined };

/** `streaming`: a reply still arriving (#79), same markdown as the final one plus the caret at the end of its text. */
function TextBlock({ text: raw, onOpenRef, quotes, cardLinks, streaming }: { text: string; onOpenRef?(ref: MessageRef): void; quotes?: boolean; cardLinks?: CardLinks; streaming?: boolean }) {
  const text = streaming ? draftMarkdown(raw) : raw;
  const rehype = streaming ? REHYPE_CARET : undefined;
  // « Ask about this »: the quoted document part shows as a chip; the agent got the full quote.
  const ref = quotes ? parseDocRef(text) : null;
  if (ref)
    return onOpenRef ? (
      <button type="button" className="msg-quote" title="Show it in the panel" onClick={() => onOpenRef(ref)}>
        ❝ {ref.label}
      </button>
    ) : (
      <div className="msg-quote">❝ {ref.label}</div>
    );
  return (
    <div className={'text md' + (streaming ? ' streaming' : '')}>
      {cardLinks ? (
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={rehype}
          components={{
            a: ({ node: _n, href, children, ...a }) =>
              href?.startsWith(CARD_HREF) ? (
                <CardRef ref_={decodeURIComponent(href.slice(CARD_HREF.length))} links={cardLinks}>
                  {children}
                </CardRef>
              ) : (
                <a href={href} {...a}>
                  {children}
                </a>
              ),
          }}
        >
          {linkCardRefsMd(text, cardLinks.known)}
        </Markdown>
      ) : (
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehype}>
          {text}
        </Markdown>
      )}
    </div>
  );
}

const REHYPE_CARET = [rehypeCaret];

/** A #N reference in a message: a chip with the card's status icon and title; opens the card. */
function CardRef({ ref_, links, children }: { ref_: string; links: CardLinks; children: ReactNode }) {
  const c = links.card?.(ref_);
  return (
    <button type="button" className="card-ref" title={c ? `${c.title} · open the task` : 'Open the task'} onClick={() => links.open(ref_)}>
      {c && <StatusIcon status={c.status} size={12} />}
      {children}
      {c && <em className="card-ref-title">{c.title}</em>}
    </button>
  );
}

function merge(a: Message[], b: Message[]): Message[] {
  const byId = new Map([...a, ...b].map((m) => [m.id, m]));
  return [...byId.values()].sort((x, y) => x.seq - y.seq);
}
