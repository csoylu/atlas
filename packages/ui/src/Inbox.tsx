import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentFace } from './AgentFace.tsx';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cardRef, type Agent, type Card, type Inbox as InboxData, type InboxNeed, type Notification } from '@atlas/shared';
import { api } from './api.ts';
import { Icon } from './ScreenHeader.tsx';
import { StatusIcon } from './StatusIcon.tsx';
import { CardDocs } from './DocPanel.tsx';
import { stallAction } from './stallView.ts';
import { ago } from './PlanAccounts.tsx';
import { submitOnEnter } from './composerKeys.ts';
import type { MessageStream } from './useMessages.ts';
import { CleanupBody, DigestBody, type MemoryDigestState } from './MemoryDigest.tsx';
import { DIGEST_ID } from './memoryView.ts';
import { clearDraft, draftKey, readDraft, useDraft } from './drafts.ts';
import { ProjTag } from './projects.tsx';
import { EmptyState, Skeleton } from './Kit.tsx';
import { SecretBox } from './SecretBox.tsx';
import {
  inboxKey,
  itemsOf,
  kindOf,
  lineOf,
  groupsOf,
  parseTab,
  refOf,
  rowTime,
  shownItem,
  step,
  timeOf,
  titleOf,
  TASK_KEY,
  taskEntry,
  toRead,
  unreadOf,
  type InboxItem,
  type InboxTab,
} from './inboxView.ts';

const WIDE = '(min-width: 901px)';

/**
 * The Inbox (design §16; redesign mockup atlas-redesign.html, screen « Inbox », #267): one header row across the screen
 * (tabs with counts, Archive all read); the list on the left (380px), « Needs you » (live blocked / review cards) first,
 * then the updates grouped by day; the item on the right, answered in place. J/K move, E archives an update,
 * R replies, 1–4 pick an option. Under 900px one column: the item pushes in over the list.
 */
export function Inbox(props: {
  inbox: InboxData | null;
  cards: Card[];
  agents: Agent[];
  /** The item in the URL (#/inbox/<key>). */
  selected: string | null;
  onSelect(key: string | null): void;
  onOpenCard(id: string): void;
  stream: MessageStream;
  /** The daily memory digest (#82): its row is in `inbox` already (withDigest), read and archived here. */
  digest: MemoryDigestState;
  onError(e: unknown): void;
}) {
  const { inbox, selected, onSelect, onError, digest } = props;
  const [tab, setTabState] = useState<InboxTab>(() => parseTab(localStorage.getItem('atlas.inbox.tab')));
  const setTab = (t: InboxTab) => {
    setTabState(t);
    localStorage.setItem('atlas.inbox.tab', t);
  };
  // A link from a task note (#task:<id>, #143): the task's entry, else the task itself.
  useEffect(() => {
    if (!inbox || !selected?.startsWith(TASK_KEY)) return;
    const id = selected.slice(TASK_KEY.length);
    const entry = taskEntry(inbox, id);
    if (entry?.tab && entry.tab !== tab) setTabState(entry.tab); // not stored: the user's tab choice stays
    if (entry) return onSelect(entry.key);
    onSelect(null);
    props.onOpenCard(id);
  }, [inbox, selected, tab, onSelect, props.onOpenCard]);
  const wide = useMedia(WIDE);
  const items = useMemo(() => (inbox ? itemsOf(inbox, tab) : []), [inbox, tab]);
  const lastIndex = useRef(0);
  const item = shownItem(items, selected, lastIndex.current, wide);
  const index = item ? items.indexOf(item) : -1;
  if (index >= 0) lastIndex.current = index;
  const numbers = useMemo(() => new Map(props.cards.map((c) => [c.id, c.number])), [props.cards]);
  const listRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  // Opening an item reads it (once per item: a failed request is shown, not retried in a loop).
  const readTried = useRef(new Set<number>());
  const unreadId = item ? toRead(item) : null;
  useEffect(() => {
    if (unreadId === null || readTried.current.has(unreadId)) return;
    if (unreadId === DIGEST_ID) return void digest.seen(); // read again when a newer change comes
    readTried.current.add(unreadId);
    api.readNotification(unreadId).catch(onError);
  }, [unreadId, onError, digest]);

  // The key that left the list gives way to the item now at its place: keep the URL on what is shown.
  useEffect(() => {
    if (selected && !selected.startsWith(TASK_KEY) && item && item.key !== selected) onSelect(item.key);
  }, [selected, item, onSelect]);

  // The selected row stays in view (J/K).
  useEffect(() => {
    listRef.current?.querySelector('.ni.on')?.scrollIntoView({ block: 'nearest' });
  }, [item?.key]);

  const archive = (u: Notification) => (u.id === DIGEST_ID ? Promise.resolve(void digest.archive()) : api.archiveNotification(u.id).catch(onError));
  /** True when the message went out (the reply box then drops its draft); false after showing the error. */
  const answer = (cardId: string, text: string) =>
    api.postMessage(cardId, text).then(
      () => true,
      (e: unknown) => {
        onError(e);
        return false;
      },
    );

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.activeElement?.closest('.thread-panel')) return; // the task panel's own keys
      const k = inboxKey(e, e.target);
      if (!k) return;
      if (k.kind === 'next' || k.kind === 'prev') {
        const next = step(items, item?.key ?? null, k.kind === 'next' ? 1 : -1);
        if (next) onSelect(next);
      } else if (k.kind === 'archive') {
        if (!item?.update) return;
        void archive(item.update);
      } else if (k.kind === 'reply') {
        if (!replyRef.current) return;
        replyRef.current.focus();
      } else {
        const b = item?.need?.card.block;
        if (!b || item.need!.failed || !b.options[k.index]) return;
        void answer(item.need!.card.id, b.options[k.index]!);
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const needCount = inbox?.needsYou.length ?? 0;
  const allCount = inbox ? itemsOf(inbox, 'all').length : 0;
  const readCount = inbox?.updates.filter((u) => u.readAt).length ?? 0;
  const pushed = !wide && !!item;
  const groups = groupsOf(items);
  const archiveRead = () => {
    if (digest.item?.readAt) digest.archive();
    api.archiveRead().catch(onError);
  };
  const archiveTitle = readCount ? `Archive the ${readCount} update${readCount === 1 ? '' : 's'} you have read` : 'Nothing read to archive yet';

  return (
    <div className={'inbox' + (pushed ? ' pushed' : '')}>
      <header className="screen-head ibx-head">
        <div className="crumb">
          <h1>Inbox</h1>
        </div>
        <div className="view-tabs" role="tablist" aria-label="Show">
          {(['all', 'needs'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={'tabbtn' + (tab === t ? ' on' : '')} onClick={() => setTab(t)}>
              {t === 'all' ? 'All' : 'Needs you'}
              {inbox && <span className="tab-n">{t === 'all' ? allCount : needCount}</span>}
            </button>
          ))}
        </div>
        <span className="head-sp" />
        {wide ? (
          <button type="button" className="btn ghost" title={archiveTitle} disabled={!readCount} onClick={archiveRead}>
            <Icon.check />
            Archive all read
          </button>
        ) : (
          <button type="button" className="icon-btn" aria-label="Archive all read" title={archiveTitle} disabled={!readCount} onClick={archiveRead}>
            <Icon.check />
          </button>
        )}
      </header>
      <div className="ibx-wrap">
        <section className="ibx" aria-label="Inbox">
          <div className="ibx-list" ref={listRef} role="listbox" aria-label="Inbox items">
            {!inbox ? (
              <Skeleton rows={4} className="ibx-loading" />
            ) : !items.length ? (
              <EmptyState icon={<Icon.inbox />} title={tab === 'needs' ? 'Nothing needs you' : 'All clear'}>
                {tab === 'needs' ? 'Questions and reviews for you show here.' : 'Updates show here when a task finishes or asks a question.'}
              </EmptyState>
            ) : (
              groups.map((g) => (
                <div key={g.label} role="group" aria-label={g.label}>
                  <div className="ibx-group">{g.label}</div>
                  {g.items.map(row)}
                </div>
              ))
            )}
          </div>
        </section>
        <section className="ibx-pane" aria-label="Item">
          {item ? (
            <Detail
              key={item.key}
              item={item}
              refText={refOf(item, numbers)}
              agents={props.agents}
              cards={props.cards}
              replyRef={replyRef}
              wide={wide}
              stream={props.stream}
              onBack={() => onSelect(null)}
              onOpenCard={props.onOpenCard}
              onArchive={archive}
              onAnswer={answer}
              digest={digest}
              onError={onError}
            />
          ) : (
            wide && inbox && <EmptyState className="pane-empty">Nothing selected.</EmptyState>
          )}
        </section>
      </div>
    </div>
  );

  function row(i: InboxItem) {
    const k = kindOf(i);
    const card = i.need ? i.need.card : i.update.cardId ? props.cards.find((c) => c.id === i.update!.cardId) : undefined;
    const agent = card?.assignee ?? null;
    const unread = unreadOf(i);
    const ref = refOf(i, numbers);
    return (
      <button
        key={i.key}
        type="button"
        role="option"
        aria-selected={item?.key === i.key}
        aria-label={(unread ? 'Unread: ' : '') + titleOf(i)}
        className={'ni' + (item?.key === i.key ? ' on' : '') + (unread ? ' unread' : ' read')}
        onClick={() => onSelect(i.key)}
      >
        <StatusIcon status={k.icon} title={k.label} />
        <span className="ni-l2">{titleOf(i)}</span>
        <span className="ni-when" title={new Date(timeOf(i)).toLocaleString('en-GB')}>
          {rowTime(i)}
        </span>
        <span className="ni-l1">
          {agent && <AgentFace id={agent} />}
          {ref && <span className="ni-ref">{ref}</span>}
          <ProjTag id={card?.projectId} />
          <span className="ni-l3">{lineOf(i) || k.label}</span>
        </span>
      </button>
    );
  }
}

function Detail(props: {
  item: InboxItem;
  refText: string;
  agents: Agent[];
  cards: Card[];
  replyRef: React.RefObject<HTMLTextAreaElement | null>;
  wide: boolean;
  stream: MessageStream;
  onBack(): void;
  onOpenCard(id: string): void;
  onArchive(u: Notification): void;
  onAnswer(cardId: string, text: string): Promise<boolean>;
  digest: MemoryDigestState;
  onError(e: unknown): void;
}) {
  const { item } = props;
  const k = kindOf(item);
  const cardId = item.need ? item.need.card.id : item.update.cardId;
  const card = item.need?.card ?? props.cards.find((c) => c.id === cardId);
  const who = card?.assignee ?? null;
  return (
    <>
      <header className="screen-head ibx-dh">
        {!props.wide && (
          <button type="button" className="head-back" aria-label="Back to the inbox" title="Back to the inbox" onClick={props.onBack}>
            <Icon.back />
          </button>
        )}
        <StatusIcon status={k.icon} title={k.label} />
        {props.refText && <span className="ibx-ref">{props.refText}</span>}
        <h1 className="ibx-title" title={titleOf(item)}>
          {titleOf(item)}
        </h1>
        <div className="head-actions">
          {cardId && (
            <button type="button" className="btn" onClick={() => props.onOpenCard(cardId)}>
              Open task
            </button>
          )}
          {item.update && (
            <button type="button" className="btn" onClick={() => props.onArchive(item.update!)}>
              Archive <span className="kbd">E</span>
            </button>
          )}
        </div>
      </header>
      <div className="ibx-det">
        <div className="ibx-meta">
          {card?.assignee && <AgentFace id={card.assignee} />}
          {who && <b>{(who + ' ' + verbOf(item)).trim()}</b>}
          <span>
            {ago(timeOf(item))} · {metaOf(item)}
            {card && card.parents.length > 0 && <> · child of {card.parents.map((p) => refName(p, props.cards)).join(', ')}</>}
          </span>
          <ProjTag id={card?.projectId} />
        </div>
        {item.need ? (
          <NeedBody need={item.need} {...props} />
        ) : item.update.id === DIGEST_ID ? (
          <DigestBody digest={props.digest} onError={props.onError} />
        ) : item.update.kind === 'memory.cleanup' && item.update.cardId ? (
          <CleanupBody cardId={item.update.cardId} summary={item.update.body} stream={props.stream} onError={props.onError} />
        ) : (
          <UpdateBody update={item.update} {...props} />
        )}
      </div>
    </>
  );
}

function NeedBody(props: Parameters<typeof Detail>[0] & { need: InboxNeed }) {
  const { need, onAnswer, onError } = props;
  const { card } = need;
  // Shares the card chat's draft: text started here shows up in the card's composer, and back.
  const draftId = draftKey('card', card.id);
  const [text, setText] = useDraft(draftId);
  const [busy, setBusy] = useState(false);
  const send = async (t: string) => {
    if (!t.trim() || busy) return;
    setBusy(true);
    const ok = await onAnswer(card.id, t.trim());
    setBusy(false);
    if (!ok) return; // a failed send keeps the text
    setText((cur) => (cur === t ? '' : cur));
    if (readDraft(draftId) === t) clearDraft(draftId); // the box may be gone already
  };
  const agent = card.assignee ?? 'the agent';
  const reply = (placeholder: string) => (
    <form
      className="ibx-reply"
      onSubmit={(e) => {
        e.preventDefault();
        void send(text);
      }}
    >
      <textarea ref={props.replyRef} rows={text.includes('\n') ? 4 : 1} value={text} placeholder={placeholder} aria-label={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={submitOnEnter} />
      {text.trim() ? (
        <button type="submit" className="btn primary" disabled={busy}>
          Send
        </button>
      ) : (
        <span className="kbd" aria-hidden="true">
          R
        </span>
      )}
    </form>
  );

  if (card.status === 'review')
    return (
      <>
        <div className="ibx-q review">
          <div className="ibx-k">
            <StatusIcon status="review" /> Ready for your review
          </div>
          {need.summary ? (
            <div className="md">
              <Markdown remarkPlugins={[remarkGfm]}>{need.summary}</Markdown>
            </div>
          ) : (
            <p className="muted">No summary: open the task for the conversation.</p>
          )}
          <div className="ibx-actions">
            <button type="button" className="btn primary" onClick={() => api.moveCard(card.id, 'done').catch(onError)}>
              Approve
            </button>
            <button type="button" className="btn" onClick={() => props.replyRef.current?.focus()}>
              Request changes
            </button>
          </div>
          {reply(`Or say what ${agent} should change…`)}
        </div>
        <CardDocs cardId={card.id} stream={props.stream} onOpenCard={props.onOpenCard} onError={onError} />
        <p className="ibx-note">Approving moves the task to done. Requested changes go back to {agent}. Either way the item leaves the inbox by itself.</p>
      </>
    );

  const b = card.block ?? { kind: 'needs_input' as const, reason: 'Blocked, with no reason given.', options: [] as string[] };
  if (need.failed)
    return (
      <>
        <div className="ibx-q failed">
          <div className="ibx-k">
            <StatusIcon status="failed" /> The run failed
          </div>
          <pre className="ibx-error">{b.reason}</pre>
          <div className="ibx-actions">
            <button type="button" className="btn primary" onClick={() => api.retry(card.id).catch(onError)}>
              Retry
            </button>
          </div>
          {reply('Or tell ' + agent + ' what to do instead…')}
        </div>
        <p className="ibx-note">Retry runs the task again. The item leaves the inbox by itself.</p>
      </>
    );

  return (
    <>
      <div className="ibx-q ask" role="group" aria-label={BLOCK_LABEL[b.kind] ?? 'Blocked'}>
        <div className="md ibx-ask">
          <Markdown remarkPlugins={[remarkGfm]}>{b.reason}</Markdown>
        </div>
        <SecretBox card={card} />
        {b.options.length > 0 && (
          <div className="ibx-opts">
            {b.options.map((o, i) => (
              <button key={o} type="button" className={'btn ibx-opt' + (i === 0 ? ' primary' : '')} title={i === 0 ? 'Recommended' : undefined} disabled={busy} onClick={() => void send(o)}>
                {i < 4 && <span className="ibx-optn">{i + 1} ·</span>}
                <span className="ibx-optt">{o}</span>
              </button>
            ))}
          </div>
        )}
        {reply(b.options.length ? 'Or reply in your own words…' : `Reply to ${agent}…`)}
      </div>
      <p className="ibx-note">Answering unblocks the task and {agent} carries on. The item leaves the inbox by itself.</p>
    </>
  );
}

function UpdateBody(props: Parameters<typeof Detail>[0] & { update: Notification }) {
  const { update, onError } = props;
  const [retried, setRetried] = useState(false);
  return (
    <>
      {update.body ? (
        <div className={'ibx-q' + (update.kind === 'run.failed' ? ' failed' : ' plain')}>
          {update.kind === 'run.failed' ? (
            <pre className="ibx-error">{update.body}</pre>
          ) : (
            <div className="md">
              <Markdown remarkPlugins={[remarkGfm]}>{update.body}</Markdown>
            </div>
          )}
          {update.kind === 'run.failed' && update.cardId && (
            <div className="ibx-actions">
              <button
                type="button"
                className="btn primary"
                disabled={retried}
                onClick={() => {
                  setRetried(true);
                  api.retry(update.cardId!).then(() => props.onArchive(update), (e: unknown) => {
                    setRetried(false);
                    onError(e);
                  });
                }}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      ) : null}
      {update.kind === 'card.stalled' && update.cardId && <StallActions cardId={update.cardId} card={props.cards.find((c) => c.id === update.cardId)} onOpenCard={props.onOpenCard} onError={onError} />}
      {update.cardId && update.kind !== 'run.failed' && <CardDocs cardId={update.cardId} stream={props.stream} onOpenCard={props.onOpenCard} onError={onError} />}
      <p className="ibx-note">E archives it. « Archive all read » at the top clears every update you have read.</p>
    </>
  );
}

/**
 * A stuck task (#237): the action its reason calls for (Retry the review, Restart the run, Move to Ready) and Open.
 * The item leaves the Inbox by itself once the task moves; a task no longer stuck shows only Open.
 */
function StallActions(props: { cardId: string; card: Card | undefined; onOpenCard(id: string): void; onError(e: unknown): void }) {
  const [busy, setBusy] = useState(false);
  const act = props.card?.stall ? stallAction(props.card.stall) : null;
  return (
    <div className="ibx-actions">
      {act && (
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            act.run(props.cardId).catch((e: unknown) => {
              setBusy(false);
              props.onError(e);
            });
          }}
        >
          {act.label}
        </button>
      )}
      <button type="button" className="btn" onClick={() => props.onOpenCard(props.cardId)}>
        Open
      </button>
    </div>
  );
}

const BLOCK_LABEL: Record<string, string> = { needs_input: 'Needs your input', dependency: 'Waiting on other work', capability: 'Needs access or a tool' };

/** What the agent did, after its name on the detail's first line (« munih asks »). */
function verbOf(item: InboxItem): string {
  if (item.need) {
    const { card, failed } = item.need;
    if (card.status === 'review') return 'asks for your review';
    if (failed) return 'could not finish';
    if (card.block?.reason.startsWith('Stopped by you')) return 'was stopped';
    return ({ needs_input: 'asks', dependency: 'is waiting on other work', capability: 'needs access or a tool' } as Record<string, string>)[card.block?.kind ?? ''] ?? 'is blocked';
  }
  return ({ 'card.done': 'finished', 'run.failed': 'failed', 'card.stalled': 'is stuck', 'schedule.ran': 'ran' } as Record<string, string>)[item.update.kind] ?? '';
}

function metaOf(item: InboxItem): string {
  if (item.need) {
    if (item.need.card.status === 'review') return 'sent for review';
    if (item.need.failed) return 'failed';
    return 'blocked';
  }
  return ({ 'card.done': 'done', 'schedule.ran': 'ran', 'run.failed': 'failed', 'memory.digest': 'latest change', 'memory.cleanup': 'proposed', 'card.stalled': 'stuck' } as Record<string, string>)[item.update.kind] ?? '';
}

function refName(id: string, cards: Card[]): string {
  const c = cards.find((x) => x.id === id);
  return c ? cardRef(c) : id;
}

export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const change = () => setOn(m.matches);
    m.addEventListener('change', change);
    return () => m.removeEventListener('change', change);
  }, [query]);
  return on;
}
