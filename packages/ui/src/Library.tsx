import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cardRef, type Card, type Doc, type DocHit, type Folder } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { HeaderActions, Icon } from './ScreenHeader.tsx';
import { Menu, PopButton, PopItem, PopRow } from './HeadMenu.tsx';
import { Avatar } from './Board.tsx';
import { StatusIcon } from './StatusIcon.tsx';
import { shortAgo } from './inboxView.ts';
import { ArtifactPreview, ArtifactViewer, KindIcon } from './Viewer.tsx';
import { folderName, useFolders } from './artifacts.ts';
import { clearFilter, filterCount, folderCounts, groupDocs, inFolder, LIB_TABS, libraryHref, matches, parseLibView, recentDocs, relAgo, TYPE_LABEL, type LibFolder, type LibView } from './library.ts';

/**
 * The Library (#120, mockup #106 v2): every artifact (docs, pages, diagrams, links) in flat folders. A folders column
 * (chips on phones) with All artifacts, Unfiled and each folder (⋯: Rename, Delete: its artifacts go to Unfiled);
 * « Recently modified » as 4 large tiles showing the real content; Pinned (on top of each folder), then This week /
 * Earlier. Rows have a folder badge and ⋯ (Open, Pin, Move to). Search in the header covers titles and content in
 * every folder. #/library/<docId> shows one in the shared viewer (⋯: Pin, Move to).
 */
export function Library(props: {
  docId: string | null;
  cards: Card[];
  chats: Card[];
  stream: MessageStream;
  onOpenCard(id: string): void;
  /** The open artifact's title (the screen header's breadcrumb). */
  onTitle(title: string | null): void;
  onError(e: unknown): void;
}) {
  const { stream, onError, onTitle } = props;
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [view, setView] = useState(() => parseLibView(localStorage.getItem('atlas.library.view')));
  const [menu, setMenu] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<DocHit[] | null>(null);
  /** The folder being renamed, or 'new' while one is created. */
  const [editing, setEditing] = useState<string | null>(null);
  const folders = useFolders(stream, onError);
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
    // A folder deleted moves its artifacts to Unfiled: reload them.
    const offFolders = stream.listen('folders', () => void reload());
    return () => {
      offDoc();
      offFolders();
    };
  }, [reload, stream]);

  // Search: titles and content across every folder (the engine reads the files), debounced.
  const query = q.trim();
  useEffect(() => {
    if (!query) return setHits(null);
    let live = true;
    const t = setTimeout(() => api.searchDocs(query).then((h) => live && setHits(h), onError), 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, onError, docs]);

  // A folder that was deleted elsewhere: back to All.
  const folder: LibFolder = view.folder === 'all' || view.folder === 'unfiled' || folders.some((f) => f.id === view.folder) || !folders.length ? view.folder : 'all';
  const replace = (x: Doc) => setDocs((ds) => ds && ds.map((y) => (y.id === x.id ? x : y)));
  const pin = (d: Doc) => api.pinDoc(d.id, !d.pinned).then(replace, onError);
  const move = (d: Doc, to: string | null) => api.moveDoc(d.id, to).then(replace, onError);
  const createFolder = (name: string) =>
    api.createFolder(name).then((f) => {
      setEditing(null);
      save({ ...view, folder: f.id });
    }, onError);
  const renameFolder = (id: string, name: string) => api.renameFolder(id, name).then(() => setEditing(null), onError);
  const deleteFolder = (f: Folder, n: number) => {
    if (!confirm(`Delete the folder “${f.name}”? Its ${n} artifact${n === 1 ? '' : 's'} move to Unfiled. Nothing is deleted.`)) return;
    api.deleteFolder(f.id).then(() => {
      if (view.folder === f.id) save({ ...view, folder: 'all' });
    }, onError);
  };

  const card = (id: string | null) => (id ? props.cards.find((c) => c.id === id) : undefined);
  const open = props.docId ? docs?.find((d) => d.id === props.docId) : undefined;
  useEffect(() => onTitle(open?.title ?? null), [open?.title, onTitle]);

  /** Pin and Move to: the row's ⋯ and the viewer's ⋯. */
  const fileItems = (d: Doc, close: () => void) => (
    <>
      <PopItem
        icon={<Icon.pin />}
        onClick={() => {
          close();
          void pin(d);
        }}
      >
        {d.pinned ? 'Unpin' : 'Pin on top of its folder'}
      </PopItem>
      <div className="pop-k">Move to</div>
      {[...folders, null].map((f) => (
        <button
          key={f?.id ?? 'unfiled'}
          type="button"
          role="menuitemradio"
          aria-checked={d.folderId === (f?.id ?? null)}
          className="pop-row"
          onClick={() => {
            close();
            if (d.folderId !== (f?.id ?? null)) void move(d, f?.id ?? null);
          }}
        >
          {f ? <Icon.folder /> : <Icon.inbox />}
          <span className="pop-t">{f?.name ?? 'Unfiled'}</span>
          {d.folderId === (f?.id ?? null) && (
            <span className="pop-check">
              <Icon.check />
            </span>
          )}
        </button>
      ))}
    </>
  );

  if (props.docId) {
    if (!docs) return <div className="library loading" />;
    if (!open)
      return (
        <div className="library lib-empty">
          <p>This artifact is not in the Library any more.</p>
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
          tools={
            <button type="button" className={'sd-btn icon-only' + (open.pinned ? ' on' : '')} aria-pressed={open.pinned} title={open.pinned ? 'Unpin' : 'Pin on top of its folder'} aria-label="Pin" onClick={() => pin(open)}>
              <Icon.pin />
            </button>
          }
          menu={(close) => (
            <>
              {c && (
                <PopItem
                  icon={<StatusIcon status={c.status} size={12} />}
                  onClick={() => {
                    close();
                    props.onOpenCard(c.id);
                  }}
                >
                  Open the task {cardRef(c)}
                </PopItem>
              )}
              <div className="pop-sep" />
              {fileItems(open, close)}
            </>
          )}
          stream={stream}
          onError={onError}
        />
      </div>
    );
  }

  const all = (docs ?? []).filter((d) => matches(d, view.tab, view.filter));
  const counts = folderCounts(docs ?? []);
  const inView = all.filter((d) => inFolder(d, folder));
  const n = filterCount(view.filter);
  const withDocs = (ids: (string | null)[]) => new Set(ids.filter((x): x is string => !!x));
  const docCards = withDocs((docs ?? []).map((d) => d.cardId));
  const docChats = withDocs((docs ?? []).map((d) => d.chatId));
  const docAgents = withDocs((docs ?? []).map((d) => d.agentId));
  const setFilter = (k: keyof LibView['filter'], v: string | null) => save({ ...view, filter: { ...view.filter, [k]: v } });
  const pick = (f: LibFolder) => {
    setQ('');
    save({ ...view, folder: f });
  };
  // Search results follow the type tab and filter too.
  const results = hits?.filter((h) => matches(h.doc, view.tab, view.filter)) ?? null;
  const current = folders.find((f) => f.id === folder);

  const typeTabs = (cls: string) => (
    <div className={cls} role="tablist" aria-label="Type">
      {LIB_TABS.map((t) => {
        const on = view.tab === t.id;
        return (
          <button key={t.id} type="button" role="tab" aria-selected={on} className={'tabbtn' + (on ? ' on' : '')} onClick={() => save({ ...view, tab: t.id })}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
  const searchBox = (cls: string) => (
    <label className={'mem-search ' + cls}>
      <Icon.search />
      <input type="search" value={q} placeholder="Search titles and content…" aria-label="Search the Library" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
    </label>
  );
  const folderMenu = (f: Folder, className: string) => (
    <PopButton className={className} title="Rename, delete" ariaLabel={`Actions for ${f.name}`} label={<Icon.dots />} width={240}>
      {(close) => (
        <>
          <PopItem
            icon={<Icon.edit />}
            onClick={() => {
              close();
              setEditing(f.id);
            }}
          >
            Rename
          </PopItem>
          <PopItem
            danger
            icon={<Icon.trash />}
            onClick={() => {
              close();
              deleteFolder(f, counts.get(f.id) ?? 0);
            }}
          >
            Delete folder
          </PopItem>
          <p className="pop-note">
            Its {counts.get(f.id) ?? 0} artifact{counts.get(f.id) === 1 ? '' : 's'} move to Unfiled. Nothing is deleted.
          </p>
        </>
      )}
    </PopButton>
  );
  const nameInput = (f: Folder | null) => (
    <FolderInput key={f?.id ?? 'new'} name={f?.name ?? ''} onDone={(name) => (name && name !== f?.name ? (f ? renameFolder(f.id, name) : createFolder(name)) : setEditing(null))} />
  );

  const row = (d: Doc, snippet?: string | null) => {
    const c = card(d.cardId);
    return (
      <div key={d.id} className="lib-row">
        <a className="lib-main" data-row href={libraryHref(d.id)} title={d.path}>
          <span className={'ty ' + d.kind}>
            <KindIcon kind={d.kind} />
            <span>{TYPE_LABEL[d.kind]}</span>
          </span>
          <span className="lib-t">
            <Highlight text={d.title} q={query} />
            {snippet && (
              <span className="lib-snip">
                in content: <Highlight text={snippet} q={query} />
              </span>
            )}
          </span>
        </a>
        <span className="lib-m">
          {(query || folder === 'all') && (
            <span className="lib-fold" title="Folder">
              <Icon.folder />
              {folderName(folders, d.folderId)}
            </span>
          )}
          {c && (
            <button type="button" className="card-ref" title={`${c.title} · open the task`} onClick={() => props.onOpenCard(c.id)}>
              <StatusIcon status={c.status} size={12} />
              {cardRef(c)}
            </button>
          )}
          <button type="button" className={'lib-pin' + (d.pinned ? ' on' : '')} aria-pressed={d.pinned} title={d.pinned ? 'Unpin' : 'Pin on top of its folder'} aria-label={(d.pinned ? 'Unpin ' : 'Pin ') + d.title} onClick={() => pin(d)}>
            <Icon.pin />
          </button>
          <Avatar id={d.agentId} />
          <span className="lib-when" title={new Date(d.updatedAt).toLocaleString()}>
            {shortAgo(d.updatedAt)}
          </span>
          <PopButton className="lib-more" title="Open, pin, move" ariaLabel={`Actions for ${d.title}`} label={<Icon.dots />} width={240}>
            {(close) => (
              <>
                <a className="pop-row" role="menuitem" href={libraryHref(d.id)} onClick={close}>
                  <KindIcon kind={d.kind} />
                  <span className="pop-t">Open</span>
                </a>
                {fileItems(d, close)}
              </>
            )}
          </PopButton>
        </span>
      </div>
    );
  };
  const group = (id: string, label: string, list: ReactNode[]) =>
    list.length > 0 && (
      <section key={id} className="list-group" aria-label={label}>
        <h2 className="lg">
          {label} <span className="count">{list.length}</span>
        </h2>
        {list}
      </section>
    );

  let body: ReactNode;
  if (!docs) body = null;
  else if (query) {
    body = !results ? null : results.length ? (
      group('results', 'Results', results.map((h) => row(h.doc, h.snippet)))
    ) : (
      <div className="lib-empty">
        <p>Nothing matches “{query}” in titles or content, in any folder.</p>
        <button type="button" className="head-btn" onClick={() => setQ('')}>
          Clear the search
        </button>
      </div>
    );
  } else if (!inView.length) {
    body = (
      <div className="lib-empty">
        {!docs.length ? (
          <p>No artifacts yet. Agents make them with artifact_create (docs, pages, diagrams, links); they show up here.</p>
        ) : n > 0 && all.length === 0 ? (
          <p>
            Nothing matches the filter.{' '}
            <button className="sd-link" onClick={() => save({ ...view, filter: clearFilter() })}>
              Clear filters
            </button>
          </p>
        ) : (
          <p>{folder === 'unfiled' ? 'Nothing is unfiled.' : folder === 'all' ? 'Nothing of this type.' : 'This folder is empty. Move an artifact here from its ⋯ menu.'}</p>
        )}
      </div>
    );
  } else {
    const recent = recentDocs(inView);
    body = (
      <>
        <section className="list-group lib-recent" aria-label="Recently modified">
          <h2 className="lg">
            Recently modified <span className="count">{recent.length}</span>
          </h2>
          <div className="lib-tiles">
            {recent.map((d) => (
              <a key={d.id} className="lib-tile" href={libraryHref(d.id)} title={d.path}>
                <ArtifactPreview doc={d} onError={onError} />
                <span className="lib-tile-t">
                  <KindIcon kind={d.kind} />
                  <b>{d.title}</b>
                </span>
                <span className="lib-tile-m">
                  <Avatar id={d.agentId} />
                  <span>
                    {relAgo(d.updatedAt)} · v{d.version}
                  </span>
                  <span className="lib-fold">
                    <Icon.folder />
                    {folderName(folders, d.folderId)}
                  </span>
                </span>
              </a>
            ))}
          </div>
        </section>
        {groupDocs(inView).map((g) => group(g.id, g.label, g.docs.map((d) => row(d))))}
      </>
    );
  }

  const folderItem = (id: LibFolder, icon: ReactNode, name: string, f?: Folder) =>
    f && editing === f.id ? (
      nameInput(f)
    ) : (
      <div key={id} className="lib-fold-row">
        <button type="button" className={'nav-item' + (!query && folder === id ? ' active' : '')} onClick={() => pick(id)}>
          {icon}
          <span>{name}</span>
          <span className="tab-n">{counts.get(id) ?? 0}</span>
        </button>
        {f && folderMenu(f, 'lib-more')}
      </div>
    );
  const chip = (id: LibFolder, name: string, f?: Folder) =>
    f && editing === f.id ? (
      nameInput(f)
    ) : (
      <button key={id} type="button" className={'mem-chip' + (!query && folder === id ? ' on' : '')} onClick={() => pick(id)}>
        {name} <span className="tab-n">{counts.get(id) ?? 0}</span>
      </button>
    );

  return (
    <div className="library">
      <HeaderActions>
        {typeTabs('view-tabs lib-tabs-head')}
        <span className="head-sp" />
        {searchBox('lib-head-search')}
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
        <button type="button" className="head-btn" onClick={() => setEditing('new')} title="New folder" aria-label="New folder">
          <Icon.plus />
          <span className="btn-text">New folder</span>
        </button>
      </HeaderActions>
      {typeTabs('lib-tabs-bar')}
      <div className="lib-bar">
        {searchBox('')}
        <div className="lib-chips" aria-label="Folders">
          {chip('all', 'All artifacts')}
          {chip('unfiled', 'Unfiled')}
          {folders.map((f) => chip(f.id, f.name, f))}
          {editing === 'new' && nameInput(null)}
          {current && !query && folderMenu(current, 'mem-chip')}
        </div>
      </div>
      <div className="lib-split">
        <nav className="lib-folders" aria-label="Folders">
          {folderItem('all', <Icon.stack />, 'All artifacts')}
          {folderItem('unfiled', <Icon.inbox />, 'Unfiled')}
          <div className="side-group">
            Folders
            <button type="button" className="icon-btn" title="New folder" aria-label="New folder" onClick={() => setEditing('new')}>
              <Icon.plus />
            </button>
          </div>
          {folders.map((f) => folderItem(f.id, <Icon.folder16 />, f.name, f))}
          {editing === 'new' && nameInput(null)}
        </nav>
        <div className="lib-main-col">
          <div className="lib-list">{body}</div>
        </div>
      </div>
    </div>
  );
}

/** A folder name being typed (new or rename): Enter or leaving saves, Esc cancels. */
function FolderInput({ name, onDone }: { name: string; onDone(name: string | null): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <div className="lib-fold-in">
      <Icon.folder />
      <input
        ref={ref}
        defaultValue={name}
        placeholder="Folder name"
        aria-label="Folder name"
        maxLength={80}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(e.currentTarget.value.trim() || null);
          if (e.key === 'Escape') finish(null);
        }}
        onBlur={(e) => finish(e.currentTarget.value.trim() || null)}
      />
    </div>
  );
}

/** The search term marked in a title or snippet. */
function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}
