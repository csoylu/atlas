import { useCallback, useEffect, useState } from 'react';
import { cardRef, type Card, type Doc } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { HeaderActions, Icon } from './ScreenHeader.tsx';
import { Menu, PopRow } from './HeadMenu.tsx';
import { Avatar } from './Board.tsx';
import { StatusIcon } from './StatusIcon.tsx';
import { shortAgo } from './inboxView.ts';
import { ArtifactViewer, KindIcon } from './Viewer.tsx';
import { clearFilter, filterCount, groupDocs, LIB_TABS, libraryHref, matches, parseLibView, TYPE_LABEL, type LibView } from './library.ts';

/**
 * The Library (design §16, mockup linear.html?screen=library): every document — docs, pages, diagrams, whiteboards —
 * in one list grouped Pinned / This week / Earlier, type tabs, a filter by agent / card / chat, « New whiteboard ».
 * #/library/<docId> shows one in the shared viewer (whiteboards edit in place).
 */
export function Library(props: {
  docId: string | null;
  cards: Card[];
  chats: Card[];
  stream: MessageStream;
  onOpenCard(id: string): void;
  /** The open document's title (the screen header's breadcrumb). */
  onTitle(title: string | null): void;
  onError(e: unknown): void;
}) {
  const { stream, onError, onTitle } = props;
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [view, setView] = useState(() => parseLibView(localStorage.getItem('atlas.library.view')));
  const [menu, setMenu] = useState(false);
  const save = (next: LibView) => {
    setView(next);
    localStorage.setItem('atlas.library.view', JSON.stringify(next));
  };

  const reload = useCallback(() => api.documents().then(setDocs, onError), [onError]);
  useEffect(() => {
    void reload();
    const offDoc = stream.listen('docs', (e) => {
      if (e.type !== 'doc') return;
      setDocs((ds) => (ds ? (ds.some((d) => d.id === e.doc.id) ? ds.map((d) => (d.id === e.doc.id ? e.doc : d)) : [e.doc, ...ds]) : ds));
    });
    // A canvas created or deleted: its whiteboard comes or goes.
    const offCanvas = stream.listen('canvases', () => void reload());
    return () => {
      offDoc();
      offCanvas();
    };
  }, [reload, stream]);

  const newWhiteboard = async () => {
    const name = prompt('Whiteboard name', 'System design');
    if (!name?.trim()) return;
    try {
      const canvas = await api.createCanvas(name.trim());
      const doc = await api.whiteboardDoc(canvas.id);
      location.hash = libraryHref(doc.id);
    } catch (e) {
      onError(e);
    }
  };
  const pin = (d: Doc) => api.pinDoc(d.id, !d.pinned).then((x) => setDocs((ds) => ds && ds.map((y) => (y.id === x.id ? x : y))), onError);

  const card = (id: string | null) => (id ? props.cards.find((c) => c.id === id) : undefined);
  const open = props.docId ? docs?.find((d) => d.id === props.docId) : undefined;
  useEffect(() => onTitle(open?.title ?? null), [open?.title, onTitle]);

  /** The type tabs: in the screen header; on phones, a bar under it (the header has no room). */
  const typeTabs = (cls: string) => (
    <div className={cls} role="tablist" aria-label="Type">
      {LIB_TABS.map((t) => {
        const on = view.tab === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={'tabbtn' + (on ? ' on' : '')}
            onClick={() => save({ ...view, tab: t.id })}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );

  if (props.docId) {
    if (!docs) return <div className="library loading" />;
    if (!open)
      return (
        <div className="library lib-empty">
          <p>This document is not in the Library any more.</p>
          <a className="head-btn" href="#/library">
            Back to the Library
          </a>
        </div>
      );
    const c = card(open.cardId);
    return (
      <div className="library lib-doc">
        <ArtifactViewer
          key={open.id}
          doc={open}
          mode="library"
          lead={
            <a className="sd-btn" href="#/library" title="Back to the Library">
              ‹ Library
            </a>
          }
          actions={
            <button type="button" className={'sd-btn icon-only' + (open.pinned ? ' on' : '')} aria-pressed={open.pinned} title={open.pinned ? 'Unpin' : 'Pin on top of the Library'} onClick={() => pin(open)}>
              <Icon.pin />
            </button>
          }
          meta={
            <>
              <Avatar id={open.agentId} />
              <span className="sd-by-t">
                {open.agentId === 'user' ? 'you' : '@' + open.agentId}
                {open.path && <span className="sd-path"> · {open.path}</span>}
              </span>
              {c && (
                <button type="button" className="card-ref" title={`${c.title} · open the task`} onClick={() => props.onOpenCard(c.id)}>
                  <StatusIcon status={c.status} size={12} />
                  {cardRef(c)}
                </button>
              )}
            </>
          }
          stream={stream}
          onOpenCard={props.onOpenCard}
          onDeleted={() => (location.hash = '#/library')}
          onError={onError}
        />
      </div>
    );
  }

  const shown = (docs ?? []).filter((d) => matches(d, view.tab, view.filter));
  const groups = groupDocs(shown);
  const n = filterCount(view.filter);
  const withDocs = (ids: (string | null)[]) => new Set(ids.filter((x): x is string => !!x));
  const docCards = withDocs((docs ?? []).map((d) => d.cardId));
  const docChats = withDocs((docs ?? []).map((d) => d.chatId));
  const docAgents = withDocs((docs ?? []).map((d) => d.agentId));
  const setFilter = (k: keyof LibView['filter'], v: string | null) => save({ ...view, filter: { ...view.filter, [k]: v } });

  return (
    <div className="library">
      <HeaderActions>
        {typeTabs('view-tabs lib-tabs-head')}
        <span className="head-sp" />
        <Menu
          open={menu}
          onOpen={setMenu}
          title="Filter by agent, task or chat"
          label={
            <>
              <Icon.filter />
              <span className="btn-text">Filter</span>
              {n > 0 && <span className="tab-n">{n}</span>}
            </>
          }
        >
          <div className="pop-k">Agent</div>
          <PopRow on={view.filter.agent === null} onClick={() => setFilter('agent', null)}>
            Any agent
          </PopRow>
          {[...docAgents].map((a) => (
            <PopRow key={a} on={view.filter.agent === a} onClick={() => setFilter('agent', a)}>
              <Avatar id={a} />
              {a === 'user' ? 'You' : '@' + a}
            </PopRow>
          ))}
          {docCards.size > 0 && <div className="pop-k">Task</div>}
          {docCards.size > 0 && (
            <PopRow on={view.filter.card === null} onClick={() => setFilter('card', null)}>
              Any task
            </PopRow>
          )}
          {[...docCards].map((id) => {
            const c = card(id);
            return (
              <PopRow key={id} on={view.filter.card === id} onClick={() => setFilter('card', id)}>
                {c && <StatusIcon status={c.status} size={12} />}
                <span className="pop-t">{c ? `${cardRef(c)} ${c.title}` : id}</span>
              </PopRow>
            );
          })}
          {docChats.size > 0 && <div className="pop-k">Chat</div>}
          {docChats.size > 0 && (
            <PopRow on={view.filter.chat === null} onClick={() => setFilter('chat', null)}>
              Any chat
            </PopRow>
          )}
          {[...docChats].map((id) => (
            <PopRow key={id} on={view.filter.chat === id} onClick={() => setFilter('chat', id)}>
              <span className="pop-t">{props.chats.find((c) => c.id === id)?.title ?? 'Deleted chat'}</span>
            </PopRow>
          ))}
          {n > 0 && (
            <button type="button" className="pop-clear" onClick={() => save({ ...view, filter: clearFilter() })}>
              Clear filters
            </button>
          )}
        </Menu>
        <button type="button" className="head-btn" onClick={newWhiteboard} title="New whiteboard" aria-label="New whiteboard">
          <Icon.plus />
          <span className="btn-text">New whiteboard</span>
        </button>
      </HeaderActions>
      {typeTabs('lib-tabs-bar')}
      <div className="lib-list">
        {docs && !shown.length && (
          <div className="lib-empty">
            {docs.length ? (
              <p>Nothing matches. {n > 0 && <button className="sd-link" onClick={() => save({ ...view, filter: clearFilter() })}>Clear filters</button>}</p>
            ) : (
              <p>No documents yet. Agents write docs/*.md, pages/*.html and diagrams/*.svg in their workspaces; they show up here, with whiteboards.</p>
            )}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.id} className="list-group" aria-label={g.label}>
            <h2 className="lg">
              {g.label} <span className="count">{g.docs.length}</span>
            </h2>
            {g.docs.map((d) => {
              const c = card(d.cardId);
              return (
                <div key={d.id} className="lib-row">
                  <a className="lib-main" data-row href={libraryHref(d.id)} title={d.path ?? d.title}>
                    <span className={'ty ' + d.kind}>
                      <KindIcon kind={d.kind} />
                      <span>{TYPE_LABEL[d.kind]}</span>
                    </span>
                    <span className="lib-t">{d.title}</span>
                  </a>
                  <span className="lib-m">
                    {c && (
                      <button type="button" className="card-ref" title={`${c.title} · open the task`} onClick={() => props.onOpenCard(c.id)}>
                        <StatusIcon status={c.status} size={12} />
                        {cardRef(c)}
                      </button>
                    )}
                    <button type="button" className={'lib-pin' + (d.pinned ? ' on' : '')} aria-pressed={d.pinned} title={d.pinned ? 'Unpin' : 'Pin on top'} aria-label={(d.pinned ? 'Unpin ' : 'Pin ') + d.title} onClick={() => pin(d)}>
                      <Icon.pin />
                    </button>
                    <Avatar id={d.agentId} />
                    <span className="lib-when" title={new Date(d.updatedAt).toLocaleString()}>
                      {shortAgo(d.updatedAt)}
                    </span>
                  </span>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
