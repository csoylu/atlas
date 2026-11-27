import { rehypeSecrets } from './secretsView.ts';
import { Fragment, forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { MdCode, NoFileLinks } from './FileRefs.tsx';
import { AgentFace } from './AgentFace.tsx';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { USER, isPaneLine, opensInTab, paneLabel, parseDocRef, stallText, type Agent, type Card, type Message, type Model, type PaneSees, type Run, type Timeline, type ToolCallTiming } from '@atlas/shared';
import { EyeIcon, PaneEye } from './PaneEye.tsx';
import { api } from './api.ts';
import { useMinute } from './useMinute.ts';
import { stallAction } from './stallView.ts';
import type { MessageStream } from './useMessages.ts';
import { submitOnEnter } from './composerKeys.ts';
import { ComposerMeta, useChatUsage } from './Usage.tsx';
import { CARD_HREF, findCard, linkCardIds, linkCardRefsMd, proseRefLabel, withCard } from './cardModal.ts';
import { StepRow, Turn } from './ChatActivity.tsx';
import { draftSegments, turns, type Segment } from './chatTurn.ts';
import { AttachButton, AttachmentStrip, DROP_HINT, FAILED, fileList, ImageThumbs, isAttachedLine, NO_AGENT, openTaskFile, pastedFiles, useAttachments, WAITING } from './Images.tsx';
import type { ToolOutcome } from './toolRows.ts';
import { sysLine } from './chatPins.ts';
import { webSearchResult } from './webRows.ts';
import { ChatPins } from './ChatPins.tsx';
import { VoiceToggle } from './VoiceToggle.tsx';
import { PopButton, PopItem } from './HeadMenu.tsx';
import { useKeepBottom } from './useKeepBottom.ts';
import { ChatRow } from './ChatRow.tsx';
import { parseReport, rowTime } from './chatRow.ts';
import { SecretBox, secretBoxOf } from './SecretBox.tsx';
import { deleteChatQuestion } from './chatHistoryMenu.ts';
import { HeaderActions, Icon } from './ScreenHeader.tsx';
import { StatusIcon, STATUS_LABEL } from './StatusIcon.tsx';
import { chipAnchor, isComment, isQuote, toPost, toQuote, type Comments } from './comments.ts';
import { QuoteLayer } from './QuoteLayer.tsx';
import { rehypeQuoteMarks, type QuoteMark } from './quoteMarks.ts';
import { useQuoteSurface } from './useQuoteSurface.ts';
import { CommentChips, UserContent } from './CommentCards.tsx';
import { draftKey, readDraft, useDraft, writeDraft } from './drafts.ts';
import { useAutoGrow } from './useAutoGrow.ts';
import { RewindConfirm, RewindIcon, RewindNote, useRewind, type Rewind } from './Rewind.tsx';
import { clearPoint, distribute, isMemoryNote, memoryRow, messageRow, timelineRows, type SysRow } from './sysRows.ts';
import { parseSlash, slashKey, slashMatches, type SlashName } from './slashCommands.ts';
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

/** A place in an artifact a message points at (an old « ❝ Doc › Section » quote, or a comment's card, #304). */
export type MessageRef = { docId: string; version: number; section: string | null; label: string };

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
        if (b.type === 'tool_result') map.set(b.tool_use_id, { content: b.content, isError: !!b.is_error, ...(b.images?.length ? { images: b.images } : {}) });
        else if (b.type === 'web_search_tool_result') map.set(b.tool_use_id, webSearchResult(b.content));
      }
    return map;
  }, [messages]);
  const isLive = useCallback((id: string) => live.current.has(id), []);
  return { messages, run, draft, results, timings, timeline, isLive };
}

const NO_TIMELINE: Timeline = { runs: [], rewinds: [], summary: null };

type Conversation = ReturnType<typeof useCardConversation>;

/** The direct chat pane (ChatView): the conversation with the chat's agent, no card fields. Cards open in the task panel (ThreadPanel). */
export function CardPanel(props: {
  card: Card;
  /** Opens a card (links in system lines) in the task panel. */
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
  /** The tab open in the chat's pane (#305): the composer's eye, sent with the message. */
  sees?: PaneSees | null;
  /** The comments made on the side panel (#304): numbered chips in the composer, sent with the message. */
  comments?: Comments;
  /** Tabs open in a hidden side panel (overlay mode): a button brings it back. */
  hiddenDocs?: number;
  /** A direct chat opened with an unread reply (#338): the « New » line goes above the first message after this seq. */
  newAfter?: number | null;
  /** The hidden pane holds the browser the agent is driving (#306): a dot on the button, this as its tooltip. */
  hiddenLive?: string;
  onShowDocs?(): void;
  /** The side panel is on screen: a header button hides it (⌘\ toggles). */
  onHideDocs?(): void;
  /** A quote chip in a message was clicked: open that document part in the panel. */
  onOpenRef?(ref: MessageRef): void;
}) {
  const { card, stream, onError } = props;
  const convo = useCardConversation(card, stream, onError);
  const rw = useRewind(card, convo.run, onError, { globalEsc: true });
  const chatBox = useRef<HTMLDivElement>(null);
  useKeepBottom(chatBox);
  return (
    <aside className={'panel chat-pane' + (props.hiddenDocs ? ' has-docs' : '')}>
      <HeaderActions>
        <ChatPins chatId={card.id} cards={props.cards} stream={stream} onOpen={props.onOpen} onError={onError} />
        {!!props.hiddenDocs && (
          <button
            type="button"
            className="btn doc-reopen"
            onClick={props.onShowDocs}
            title={'Show the documents panel (⌘\\)' + (props.hiddenLive ? ' · ' + props.hiddenLive : '')}
            aria-label={`Show the documents panel: ${props.hiddenDocs} open${props.hiddenLive ? ', ' + props.hiddenLive : ''}`}
          >
            <Icon.doc /> <span className="doc-reopen-l">Documents · </span>
            {props.hiddenDocs}
            {props.hiddenLive && <span className="wb-hdot" aria-hidden="true" />}
          </button>
        )}
        {props.onHideDocs && (
          <button type="button" className="icon-btn doc-hide" onClick={props.onHideDocs} aria-label="Hide the documents panel" title="Hide the documents panel (⌘\)">
            <Icon.panel />
          </button>
        )}
        <PopButton className="icon-btn chat-menu" label={<Icon.dots />} title="Chat menu" ariaLabel="Chat menu: clear context, delete chat" width={220}>
          {(close) => (
            <>
              <PopItem
                icon={<Icon.restore />}
                onClick={() => {
                  close();
                  api.command(card.id, 'clear').catch(onError);
                }}
              >
                Clear context
              </PopItem>
              <PopItem
                icon={<Icon.trash />}
                danger
                onClick={() => {
                  close();
                  const isMain = props.agents.some((a) => a.mainChat === card.id);
                  if (confirm(deleteChatQuestion(card, isMain))) api.deleteCard(card.id).then(props.onClose, onError);
                }}
              >
                Delete chat
              </PopItem>
            </>
          )}
        </PopButton>
      </HeaderActions>
      <CardNotices card={card} onError={onError} />
      <div className="chat" ref={chatBox}>
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
          newAfter={props.newAfter}
          comments={props.comments}
          empty={`Ask @${card.assignee} anything. For work to track, it creates tasks.`}
        />
      </div>
      <RewindNote rw={rw} />
      {!rw.hideRun && <RunLine run={convo.run} onStop={() => void rw.stopTurn()} />}
      <CardComposer card={card} agents={props.agents} models={props.models} plan={!!props.plan} stream={stream} onError={onError} comments={props.comments} sees={props.sees} rewind={rw} />
      <RewindConfirm rw={rw} />
    </aside>
  );
}

/** The plain-words reason a card isn't moving (a question shows in the conversation, see AskMessage). */
export function CardNotices({ card, onError }: { card: Card; onError(e: unknown): void }) {
  const now = useMinute();
  // Stuck (#237): what it is stuck on, and the action that unsticks it.
  if (card.stall && !card.block) {
    const act = stallAction(card.stall);
    return (
      <div className="waiting-line stuck">
        {stallText(card.stall, card.statusSince, now)}
        {act && (
          <button className="btn ghost retry" onClick={() => act.run(card.id).catch(onError)}>
            {act.label}
          </button>
        )}
      </div>
    );
  }
  // GitHub unreadable: the task view's « Now » box says it (TaskNow).
  if (!card.waiting || card.block || (card.status === 'review' && card.prs.some((p) => p.error))) return null;
  return (
    <div className="waiting-line">
      {card.waiting}
      {card.waiting.includes('Retry') && (
        <button className="btn ghost retry" onClick={() => api.retry(card.id).catch(onError)}>
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
        <SecretBox card={card} />
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
  /** The composer's waiting comments and quotes (#367): a selection in a message quotes it there. */
  comments?: Comments;
  /**
   * The task sheet (#269) shows a blocked task's question in its « Now » box: the conversation then doesn't repeat it,
   * and opens scrolled to that box instead of the end.
   */
  askAt?: RefObject<HTMLElement | null>;
  /** The « New » line (#338) above the first message group after this seq; null or undefined: none. */
  newAfter?: number | null;
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
  // A /clear folds the messages before it (#99) until « Show earlier messages »; a new clear folds again.
  const fold = clearPoint(timeline);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [fold, card.id]);
  const shown = messages.filter((m) => m.author !== 'tool' && (expanded || m.seq > fold));
  // In review waits for QA, not the user (#189): its reason is a notice line, not a question.
  const asking = !!card.block && !props.askAt;
  // The question is the agent's last message: highlight that one instead of repeating it.
  const last = shown.at(-1);
  // In the task sheet that message is the « Now » box's question: it is not shown twice (unless it also ran steps).
  const inline =
    !!card.block && !draft && last?.role === 'assistant' && msgText(last) === card.block.reason.trim() && (asking || last.content.every((b) => b.type === 'text'));
  const list = inline ? shown.slice(0, -1) : shown;
  // Opens at the question's start (a long one is read from its top), else at the end of the conversation.
  // Block body on purpose: scrollIntoView returns a Promise in recent Chromium, which must not become the cleanup.
  const newRef = useRef<HTMLDivElement>(null);
  const newShown = useRef(false);
  useEffect(() => {
    const box = card.block ? props.askAt?.current : null;
    // An unread reply (#338): opens at the « New » line once; then as before (new messages scroll to the end).
    if (newRef.current && !newShown.current) {
      newShown.current = true;
      newRef.current.scrollIntoView({ block: 'start' });
    } else if (askRef.current) askRef.current.scrollIntoView({ block: 'start' });
    else if (box) box.scrollIntoView({ block: 'nearest' }); // the sheet's top: title, then the question
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
  // Quotes (#367): which text block a selection is in, the passages waiting as chips, the one a click lit.
  const quote = useQuoteSurface(messages, props.comments, listBox, fold, expanded, setExpanded);
  const userWho = props.userName ?? 'You';
  const text = (t: string, key?: string, user?: boolean, at?: { seq: number; block: number; who: string }) => (
    <TextBlock key={key} text={t} onOpenRef={user ? props.onOpenRef : undefined} quotes={user} cardLinks={cardLinks} qb={at} marks={at ? quote.marks(at.seq, at.block) : undefined} />
  );
  const renderText = (t: string, key: string) => {
    const cut = key.lastIndexOf(':');
    const m = quote.byId.get(key.slice(0, cut));
    const at = m ? { seq: m.seq, block: Number(key.slice(cut + 1)), who: m.author } : undefined;
    return <TextBlock key={key} text={t} cardLinks={cardLinks} qb={at} marks={at ? quote.marks(at.seq, at.block) : undefined} />;
  };
  const renderTurn = (ms: Message[], live: boolean, last: boolean) => (
    <Turn messages={ms} results={results} timings={timings} live={live} last={last} stream={props.stream} renderText={renderText} onOpenArtifact={props.onOpenRef} cards={cardLinks} cardId={card.id} />
  );
  const isAgent = (m: Message) => m.role === 'assistant';
  const groups = turns(list, isAgent, props.newAfter);
  // The first group with a message Master hadn't seen gets the « New » line above it.
  const newAt = props.newAfter == null ? -1 : groups.findIndex((g) => g.some((m) => m.seq > props.newAfter!));
  const running = run?.status === 'running';
  // System events between turns (#66): ended runs, rewinds, the summary point, each after the group it follows.
  const placed = distribute(
    groups.map((g) => g[0]!.seq),
    timelineRows(timeline, messages, { latestRunId: run?.id ?? null, running, hhmm: (iso) => rowTime(iso), expanded }),
  );
  // Where the streaming reply shows: inside the last group when it's this agent's turn (see draftHere), else as its own message.
  const lastGroup = groups.at(-1)?.[0];
  const draftJoined =
    draft && !!lastGroup && isAgent(lastGroup) && lastGroup.author === card.assignee && lastGroup.author !== 'system' && !messageRow(lastGroup, card.assignee) && !placed.after[groups.length - 1]!.length;
  // Consecutive [memory] notes with nothing placed between them are one row (#143): the first carries them all, the
  // others draw nothing (null).
  const memRows = new Map<number, SysRow | null>();
  for (let i = 0; i < groups.length; i++) {
    if (!isMemoryNote(groups[i]![0]!)) continue;
    let j = i;
    while (j + 1 < groups.length && isMemoryNote(groups[j + 1]![0]!) && !placed.after[j]!.length) j++;
    memRows.set(i, memoryRow(groups.slice(i, j + 1).map((g) => g[0]!), card.assignee));
    for (let k = i + 1; k <= j; k++) memRows.set(k, null);
    i = j;
  }
  const sysRow = (r: SysRow) => (
    <SystemRow
      key={r.key}
      row={r}
      cards={cardLinks}
      renderText={(t) => text(t)}
      onRetry={() => api.retry(card.id).catch(props.onError)}
      onUndo={(id) => (props.onUndo ? props.onUndo(id) : api.undoRewind(id)).catch(props.onError)}
      onToggleEarlier={() => setExpanded((x) => !x)}
      onUndoClear={(id) => api.undoClear(id).catch(props.onError)}
    />
  );
  return (
    <>
      <span ref={listBox} hidden />
      {messages.length === 0 && !asking && <p className="state-empty center">{props.empty}</p>}
      {fold > 0 && shown.length === 0 && !draft && !asking && <p className="state-empty center">Context cleared. The agent starts fresh from your next message.</p>}
      {placed.before.map(sysRow)}
      {groups.map((ms, i) => {
        const m = ms[0]!;
        const prev = groups[i - 1]?.[0];
        const after = placed.after[i]!.map(sysRow);
        const merged = memRows.get(i);
        if (merged === null) return <Fragment key={m.id}>{after}</Fragment>;
        const event = merged ?? messageRow(m, card.assignee);
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
              <SystemMessage message={m} landed={props.convo.isLive(m.id)} cards={cardLinks} onOpenCard={props.onOpenCard} />
              {after}
            </Fragment>
          );
        const newLine = i === newAt && (
          <div ref={newRef} className="new-line" role="separator" aria-label="New messages">
            New
          </div>
        );
        const last = i === groups.length - 1 && !inline;
        // The reply streaming after this agent turn joins it, as the final message will (no jump when it lands).
        const draftHere = draftJoined && i === groups.length - 1;
        // A run of the same author continues the bubble; a system row in between starts a new one.
        const cont = prev?.author === m.author && !placed.after[i - 1]?.length;
        return (
          <Fragment key={m.id}>
          {newLine}
          <div className={'msg ' + m.role + (cont && !newLine ? ' cont' : '')} data-seq={m.seq}>
            {(!cont || newLine) && <div className="who">{m.author === USER ? (props.userName ?? 'You') : <><AgentFace id={m.author} />{m.author}</>}</div>}
            <div className="msg-body">
              {isAgent(m) ? (
                renderTurn(ms, running && last, last)
              ) : (
                <>
                  <UserContent
                    message={m}
                    cardId={card.id}
                    onOpenFile={card.board === 'direct' ? (path) => void api.panelOpenFile(card.id, path).catch(props.onError) : (path) => openTaskFile(card.id, path)}
                    opens={card.board === 'direct' ? () => 'open in Files' : (name) => (opensInTab(name) ? 'open in a tab' : 'download')}
                    text={(t, k) => (isAttachedLine(t) || (m.author === USER && isPaneLine(t)) ? null : text(t, k, m.author === USER, { seq: m.seq, block: Number(k), who: m.author === USER ? userWho : m.author }))}
                    onOpenRef={m.author === USER ? props.onOpenRef : undefined}
                    quoteJump={quote.jumper}
                  />
                  {m.author === USER && m.pane && (
                    <div className="pane-was" title="Open in your pane when you sent this: the agent was told where (not the content)">
                      <EyeIcon />
                      <span>{paneLabel(m.pane)} was open</span>
                    </div>
                  )}
                </>
              )}
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
      {props.comments && <QuoteLayer root={quote.root} resolve={quote.resolve} comments={props.comments} within={quote.root} />}
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

/**
 * A system message: a task note (card report-back) is one line (redesign #271, mockup « Chat »): state, #N, title,
 * outcome · time; a click opens the task beside the chat. The outcome is a finished task's first summary line (« PR #70
 * merged »), else what it waits for (« needs your OK »). Anything else is a plain note.
 */
function SystemMessage({ message: m, landed, cards, onOpenCard }: { message: Message; landed?: boolean; cards?: CardLinks; onOpenCard?(id: string): void }) {
  const text = m.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
  const r = parseReport(text);
  if (!r) return <SysNote text={text} onOpenCard={onOpenCard} />;
  const done = r.verb === 'finished';
  const id = cards?.card?.(r.card)?.id;
  const outcome = done ? r.summary || 'done' : r.verb;
  const line = (
    <span className="chat-row-line">
      <span className="chat-row-icon">
        <StatusIcon status={r.icon} />
      </span>
      <span className="chat-row-ref">{r.card}</span>
      <span className="chat-row-obj">{r.title}</span>
      <span className="tn-sum">
        {outcome} · {rowTime(m.at)}
      </span>
    </span>
  );
  const cls = 'chat-row tone-' + r.tone + ' card-report task-note' + (done ? ' done' : '') + (landed ? ' landed' : '');
  const tip = `${r.card} ${r.title}: ${outcome} · ${rowTime(m.at)}`;
  // The task is gone from the board: nothing to open.
  if (!id)
    return (
      <div className={cls} title={tip}>
        {line}
      </div>
    );
  // « Needs secret X » (#297): the box to type it, under the row that reported that block.
  const task = cards?.card?.(r.card);
  const secret = task ? secretBoxOf(task) : null;
  const box = task && secret && r.body.includes(`Needs secret ${secret.name}`) ? (
    <div className="chat-secbox">
      <SecretBox card={task} />
    </div>
  ) : null;
  return (
    <>
      <a
        className={cls}
        href={withCard(typeof location === 'undefined' ? '#/' : location.hash, id)}
        title={tip + ' · open the task'}
        onClick={(e) => {
          if (!onOpenCard) return;
          e.preventDefault();
          onOpenCard(id);
        }}
      >
        {line}
      </a>
      {box}
    </>
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
        <button className="btn ghost" onClick={onStop}>
          Stop
        </button>
      )}
    </div>
  );
}

/** Message box for the card's agent, with usage and the model/effort chooser. */
export const CardComposer = forwardRef<
  HTMLTextAreaElement,
  { card: Card; agents: Agent[]; models: Model[]; plan: boolean; stream: MessageStream; onError(e: unknown): void; comments?: Comments; sees?: PaneSees | null; rewind?: Rewind }
>(
  function CardComposer({ card, agents, models, plan, stream, onError, comments, sees, rewind }, ref) {
    // The eye (#305): off for one message, back on for the next.
    const [eyeOff, setEyeOff] = useState(false);
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
    // « Send now » in a quote's note box (#367): send what waits, as Send would.
    const form = useRef<HTMLFormElement>(null);
    const sendAsk = comments?.sendAsk ?? 0;
    useEffect(() => {
      if (sendAsk) form.current?.requestSubmit();
    }, [sendAsk]);
    const usage = useChatUsage(card.id, stream, onError);
    const agent = agents.find((a) => a.id === card.assignee);
    // Slash commands (#99): the popup while `/` starts the box; Esc hides it until the text changes.
    const [slashIndex, setSlashIndex] = useState(0);
    const [slashClosed, setSlashClosed] = useState<string | null>(null);
    const [slashBusy, setSlashBusy] = useState<string | null>(null);
    const matches = slashClosed === text || slashBusy ? [] : slashMatches(text);
    useEffect(() => setSlashIndex(0), [text]);
    const runSlash = (name: SlashName, arg: string) => {
      if (slashBusy) return;
      const typed = text;
      setText('');
      setSlashBusy(name === 'compact' ? 'Compacting the conversation…' : 'Clearing the context…');
      api
        .command(card.id, name, arg || undefined)
        .catch((err: unknown) => {
          setText((cur) => (cur.trim() ? cur : typed));
          onError(err);
        })
        .finally(() => setSlashBusy(null));
    };
    const att = useAttachments(card.id);
    const [dragging, setDragging] = useState(false);
    const canAttach = !!card.assignee;
    const addFiles = (files: File[]) => {
      if (!files.length) return;
      if (!canAttach) return void att.setNotice(NO_AGENT);
      att.add(files);
    };
    return (
      <form
        ref={form}
        className={'composer' + (dragging ? ' dropping' : '')}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          addFiles(fileList(e.dataTransfer.files));
        }}
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          const images = att.items.filter((a) => !a.error);
          const notes = comments?.list ?? [];
          if (!t && !images.length && !notes.length) return;
          // An exact command (« /clear », « /compact keep X ») runs; it is never sent as a message.
          const cmd = images.length || notes.length ? null : parseSlash(t);
          if (cmd) return runSlash(cmd.name, cmd.arg);
          if (att.uploading) return; // Send waits for the uploads (dimmed, « Waiting for the uploads »)
          if (att.failed) return void att.setNotice(FAILED);
          setText('');
          comments?.clear();
          rewind?.sent();
          const sent = att.items;
          const pending = att.take();
          att.clear();
          const pane = eyeOff ? null : (sees ?? null);
          setEyeOff(false);
          // A failed send puts the text (and the images) back, unless the user already started a new message.
          void pending
            .then((ids) => api.postMessage(card.id, t, ids, notes.filter(isComment).map(toPost), pane, notes.filter(isQuote).map(toQuote)))
            .then(() => att.release(sent))
            .catch((err: unknown) => {
              if (!readDraft(draftId).trim()) writeDraft(draftId, text); // the composer may be gone already
              setText((cur) => (cur.trim() ? cur : text));
              att.restore(sent);
              comments?.restore(notes);
              onError(err);
            });
        }}
      >
        {!!comments?.list.length && <CommentChips list={comments.list} label={chipAnchor} onRemove={comments.remove} onPickQuote={comments.pick} />}
        {matches.length > 0 && (
          <div className="slash-pop" role="listbox" aria-label="Commands">
            {matches.map((c, i) => (
              <div
                key={c.name}
                role="option"
                aria-selected={i === slashIndex}
                className={'slash-op' + (i === slashIndex ? ' on' : '')}
                onMouseEnter={() => setSlashIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep the focus in the box
                  runSlash(c.name, '');
                }}
              >
                <span className="slash-cmd">/{c.name}</span>
                <span className="slash-desc">
                  {c.desc}
                  {c.arg && <em> · /{c.name} {c.arg}</em>}
                </span>
                {i === slashIndex && <span className="slash-hint">↵</span>}
              </div>
            ))}
          </div>
        )}
        {slashBusy && (
          <div className="slash-busy" role="status">
            <span className="pulse" /> {slashBusy}
          </div>
        )}
        <AttachmentStrip a={att} />
        {dragging && <div className="drop-hint">{canAttach ? DROP_HINT : NO_AGENT}</div>}
        <textarea
          style={dragging ? { display: 'none' } : undefined}
          ref={(el) => {
            box.current = el;
            if (typeof ref === 'function') ref(el);
            else if (ref) ref.current = el;
          }}
          rows={1}
          value={text}
          placeholder={card.assignee ? `Message @${card.assignee}` : 'Assign an agent, then write to it here…'}
          title="Enter to send · Shift+Enter for a new line"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = pastedFiles(e.clipboardData);
            if (!files.length) return;
            e.preventDefault(); // a file, not its name as text
            addFiles(files);
          }}
          onKeyDown={(e) => {
            const k = slashKey(e.nativeEvent, { matches, index: slashIndex });
            if (k) {
              e.preventDefault();
              e.stopPropagation();
              if (k.kind === 'move') setSlashIndex(k.index);
              else if (k.kind === 'close') setSlashClosed(text);
              else if (!e.repeat) runSlash(k.name, '');
              return;
            }
            if (rewind?.composerKey(e.nativeEvent, text)) return;
            submitOnEnter(e);
          }}
        />
        <ComposerMeta
          usage={usage}
          plan={plan}
          attach={canAttach ? <AttachButton onFiles={addFiles} /> : undefined}
          voice={card.board === 'direct' ? <VoiceToggle chatId={card.id} agents={agents} stream={stream} onError={onError} /> : undefined}
          send={att.uploading ? { disabled: true, title: WAITING } : { disabled: !text.trim() && !att.sendable && !comments?.list.length }}
          sees={sees ? <PaneEye sees={sees} off={eyeOff} onToggle={() => setEyeOff(!eyeOff)} /> : undefined}
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

export const blockLabel: Record<NonNullable<Card['block']>['kind'], string> = {
  needs_input: 'Question for you',
  dependency: 'Waiting on other work',
  capability: 'Missing access or a broken setup',
  transient: 'Temporary problem, will retry',
};

/** #N references in a message: which ones are cards, and how to open one. */
type CardLinks = { known(ref: string): boolean; open(ref: string): void; card?(ref: string): Card | undefined };

/** `streaming`: a reply still arriving (#79), same markdown as the final one plus the caret at the end of its text. */
function TextBlock(props: {
  text: string;
  onOpenRef?(ref: MessageRef): void;
  quotes?: boolean;
  cardLinks?: CardLinks;
  streaming?: boolean;
  /** A message's text block a selection can quote (#367): its seq, its index in the content, who wrote it. */
  qb?: { seq: number; block: number; who: string };
  /** Passages waiting as quotes, and the one lit by a jump. */
  marks?: QuoteMark[];
}) {
  const { text: raw, onOpenRef, quotes, cardLinks, streaming, qb, marks } = props;
  const text = streaming ? draftMarkdown(raw) : raw;
  const rehype = streaming ? REHYPE_CARET : marks?.length ? [...REHYPE, [rehypeQuoteMarks, marks] as [typeof rehypeQuoteMarks, QuoteMark[]]] : REHYPE;
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
  const md = (
    <div className={'text md' + (streaming ? ' streaming' : '')} {...(qb && !streaming ? { 'data-qseq': qb.seq, 'data-qblock': qb.block, 'data-qwho': qb.who } : {})}>
      {cardLinks ? (
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={rehype}
          components={{
            ...FILE_MD,
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
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehype} components={FILE_MD}>
          {text}
        </Markdown>
      )}
    </div>
  );
  // A reply still arriving names half-written paths: links come with the final text.
  return streaming ? <NoFileLinks.Provider value>{md}</NoFileLinks.Provider> : md;
}

// File paths in inline code become links to the agent's workspace (#303); code blocks stay code.
const FILE_MD = {
  code: MdCode,
  pre: ({ node: _n, ...p }: { node?: unknown } & ComponentProps<'pre'>) => (
    <NoFileLinks.Provider value>
      <pre {...p} />
    </NoFileLinks.Provider>
  ),
};

// [secret NAME] marks (#209) in every message; the caret too while a reply streams.
const REHYPE = [rehypeSecrets];
const REHYPE_CARET = [rehypeSecrets, rehypeCaret];

/** A #N reference in a message's text (#140): plain « #N » in the text's size and line height, title and status on hover. */
function CardRef({ ref_, links, children }: { ref_: string; links: CardLinks; children: ReactNode }) {
  const c = links.card?.(ref_);
  const { title, label } = proseRefLabel(ref_, c && { title: c.title, status: STATUS_LABEL[c.status] });
  return (
    <button type="button" className="prose-ref" title={title} aria-label={label} onClick={() => links.open(ref_)}>
      {children}
    </button>
  );
}

function merge(a: Message[], b: Message[]): Message[] {
  const byId = new Map([...a, ...b].map((m) => [m.id, m]));
  return [...byId.values()].sort((x, y) => x.seq - y.seq);
}
