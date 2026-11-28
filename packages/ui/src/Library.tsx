import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cardRef, USER, type Card, type Doc, type DocHit, type Folder } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { HeaderActions, Icon, ScrollTabs } from './ScreenHeader.tsx';
import { effectiveFilter, inFilter, ProjectFilterButton, ProjTag, projectForNew, useProjectFilter, useProjects } from './projects.tsx';
import { Menu, PopButton, PopItem, PopRow } from './HeadMenu.tsx';
import { Avatar } from './Board.tsx';
import { StatusIcon } from './StatusIcon.tsx';
import { shortAgo } from './inboxView.ts';
import { ArtifactPreview, ArtifactViewer, DeleteArtifactDialog, KindIcon } from './Viewer.tsx';
import { folderName, useFolders } from './artifacts.ts';
import { clearFilter, filterCount, folderCounts, folderLabel, groupDocs, inFolder, isOldCanvases, LIB_TABS, libraryHref, matches, orderFolders, parseLibView, recentDocs, TYPE_LABEL, type LibFolder, type LibView } from './library.ts';
import { EmptyState } from './Kit.tsx';

/** The open document as the screen header shows it: « Library › folder › title » and its project tag (#270). */
export interface LibraryDocHead {
  title: string;
  folder: string | null;
  projectId: string | null;
}

/**
 * The Library (#120, redesign #270): every artifact (docs, pages, diagrams, links) in flat folders. One header row
 * (project, type tabs, search with « / », filter); a folders column (chips on phones) with All, Unfiled and each folder
 * (⋯: Rename, Delete: its artifacts go to Unfiled), the old converted canvases last as « Canvases (old) »; « Recent » as
 * 3 tiles showing the real content; Pinned (on top of each folder), then This week / Earlier. A row: kind, title, project
 * tag, folder as text, the task's number, version, author, time, ⋯ (Open, Pin, Move to, Delete…). #/library/<docId> shows
 * one in the shared viewer, its controls in the screen header (version picker with author and time, open beside a chat,
 * ⋯: Pin, Move to, Delete… #242).
 */
export function Library(props: {
  docId: string | null;
  cards: Card[];
  chats: Card[];
  stream: MessageStream;
  onOpenCard(id: string): void;
  /** The open artifact, for the screen header's breadcrumb and project tag. */
  onDoc(head: LibraryDocHead | null): void;
  /** Shows the artifact in the side panel of a chat (the one it came from, else its author's). */
  onOpenInPanel(doc: Doc): void;
  onError(e: unknown): void;
}) {
  const { stream, onError, onDoc } = props;
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [view, setView] = useState(() => parseLibView(localStorage.getItem('atlas.library.view')));
  const [menu, setMenu] = useState(false);
  const [q, setQ] = useState('');
  /** Phone: the search field shows under the header once its icon is tapped. */
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [hits, setHits] = useState<DocHit[] | null>(null);
  /** The folder being renamed, or 'new' while one is created. */
  const [editing, setEditing] = useState<string | null>(null);
  /** The artifact whose « Delete… » was picked in a row's ⋯ (#242). */
  const [deleting, setDeleting] = useState<Doc | null>(null);
  const folders = useFolders(stream, onError);
  const save = (next: LibView) => {
    setView(next);
    localStorage.setItem('atlas.library.view', JSON.stringify(next));
  };

  const pinfo = useProjects();
  const [pfRaw, setPf] = useProjectFilter();
  const pf = effectiveFilter(pfRaw, pinfo);
  const hasArchived = pinfo.all.some((p) => p.status === 'archived');
  // With an archived project, the list has its artifacts too (« Archived » in the filter shows them).
  const reload = useCallback(() => api.documents(undefined, hasArchived).then(setDocs, onError), [onError, hasArchived]);
  useEffect(() => {
    void reload();
    const offDoc = stream.listen('docs', (e) => {
      if (e.type === 'docDeleted') return setDocs((ds) => ds && ds.filter((d) => d.id !== e.id));
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
  const folderOk = (id: string) => folders.some((f) => f.id === id && (!pinfo.byId(pfRaw) || f.projectId === pfRaw || !pinfo.multi));
  const folder: LibFolder = view.folder === 'all' || view.folder === 'unfiled' || folderOk(view.folder) || !folders.length ? view.folder : 'all';
  const replace = (x: Doc) => setDocs((ds) => ds && ds.map((y) => (y.id === x.id ? x : y)));
  const pin = (d: Doc) => api.pinDoc(d.id, !d.pinned).then(replace, onError);
  const move = (d: Doc, to: string | null) => api.moveDoc(d.id, to).then(replace, onError);
  const createFolder = (name: string) =>
    api.createFolder(name, pinfo.multi ? projectForNew(pf, pinfo)?.id : undefined).then((f) => {
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
  const openFolder = open?.folderId ? folders.find((f) => f.id === open.folderId) : undefined;
  const head = open ? JSON.stringify({ title: open.title, folder: openFolder ? folderLabel(openFolder) : open.folderId ? null : 'Unfiled', projectId: open.projectId }) : null;
  useEffect(() => onDoc(head ? (JSON.parse(head) as LibraryDocHead) : null), [head, onDoc]);
  useEffect(() => () => onDoc(null), [onDoc]);

  // « / » focuses the search (not while typing somewhere else).
  useEffect(() => {
    if (props.docId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const input = [...document.querySelectorAll<HTMLInputElement>('.library-search input')].find((x) => x.offsetParent);
      if (!input) return;
      e.preventDefault();
      input.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.docId]);

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
          <span className="pop-t">{f ? folderLabel(f) : 'Unfiled'}</span>
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
        <div className="library">
          <EmptyState
            title="This artifact is not in the Library any more"
            action={
              <a className="btn" href="#/library">
                Back to the Library
              </a>
            }
          />
        </div>
      );
    const c = card(open.cardId);
    return (
      <div className="library lib-doc">
        <ArtifactViewer
          key={open.id}
          doc={open}
          mode="library"
          tools={
            (open.chatId || open.agentId !== USER) && (
              <button type="button" className="sd-btn icon-only" title="Open in the side panel of a chat" aria-label="Open in side panel" onClick={() => props.onOpenInPanel(open)}>
                <Icon.panel />
              </button>
            )
          }
          onDeleted={() => {
            location.hash = '#/library';
          }}
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

  const inProj = (docs ?? []).filter((d) => inFilter(pf, d.projectId, pinfo));
  const all = inProj.filter((d) => matches(d, view.tab, view.filter));
  const counts = folderCounts(inProj);
  // One project picked: its folders only, and its rows carry no tag.
  const shownFolders = orderFolders(pinfo.byId(pf) ? folders.filter((f) => f.projectId === pf) : folders);
  const tagged = pinfo.multi && !pinfo.byId(pf);
  const inView = all.filter((d) => inFolder(d, folder));
  const n = filterCount(view.filter);
  const withDocs = (ids: (string | null)[]) => new Set(ids.filter((x): x is string => !!x));
  const docCards = withDocs(inProj.map((d) => d.cardId));
  const docChats = withDocs(inProj.map((d) => d.chatId));
  const docAgents = withDocs(inProj.map((d) => d.agentId));
  const setFilter = (k: keyof LibView['filter'], v: string | null) => save({ ...view, filter: { ...view.filter, [k]: v } });
  const pick = (f: LibFolder) => {
    setQ('');
    save({ ...view, folder: f });
  };
  // Search results follow the type tab and filter too.
  const results = hits?.filter((h) => inFilter(pf, h.doc.projectId, pinfo) && matches(h.doc, view.tab, view.filter)) ?? null;
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
    <label className={'mem-search library-search ' + cls}>
      <Icon.search />
      <input
        ref={cls ? undefined : searchRef}
        type="search"
        value={q}
        placeholder="Search titles and content"
        aria-label="Search the Library"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          setQ('');
          e.currentTarget.blur();
        }}
      />
      {cls && !q && (
        <kbd className="kbd" aria-hidden="true">
          /
        </kbd>
      )}
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
    const f = d.folderId ? folders.find((x) => x.id === d.folderId) : undefined;
    return (
      <div key={d.id} className="lib-row">
        <a className="lib-main" data-row href={libraryHref(d.id)} title={d.path}>
          <span className={'ty ' + d.kind}>
            <KindIcon kind={d.kind} />
            <span>{TYPE_LABEL[d.kind]}</span>
          </span>
          <span className="lib-t">
            {d.pinned && (
              <span className="lib-pinned" title="Pinned on top of its folder" aria-label="Pinned">
                <Icon.pin />
              </span>
            )}
            <Highlight text={d.title} q={query} />
            {snippet && (
              <span className="lib-snip">
                in content: <Highlight text={snippet} q={query} />
              </span>
            )}
          </span>
        </a>
        <span className="lib-m">
          {tagged && <ProjTag id={d.projectId} />}
          {(query || folder === 'all') && (
            <span className="lib-fold" title="Folder">
              {f ? folderLabel(f) : folderName(folders, d.folderId)}
            </span>
          )}
          <span className="lib-task">
            {c && (
              <button type="button" className="lib-num" title={`${c.title} · open the task`} onClick={() => props.onOpenCard(c.id)}>
                {cardRef(c)}
              </button>
            )}
          </span>
          <span className="lib-ver" title={`Version ${d.version}`}>
            v{d.version}
          </span>
          <Avatar id={d.agentId} />
          <span className="lib-when" title={new Date(d.updatedAt).toLocaleString()}>
            {shortAgo(d.updatedAt)}
          </span>
          <PopButton className="lib-more" title="Open, pin, move, delete" ariaLabel={`Actions for ${d.title}`} label={<Icon.dots />} width={240}>
            {(close) => (
              <>
                <a className="pop-row" role="menuitem" href={libraryHref(d.id)} onClick={close}>
                  <KindIcon kind={d.kind} />
                  <span className="pop-t">Open</span>
                </a>
                {fileItems(d, close)}
                <div className="pop-sep" />
                <PopItem
                  danger
                  icon={<Icon.trash />}
                  onClick={() => {
                    close();
                    setDeleting(d);
                  }}
                >
                  Delete…
                </PopItem>
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
        <h2 className="lg">{label}</h2>
        {list}
      </section>
    );

  let body: ReactNode;
  if (!docs) body = null;
  else if (query) {
    body = !results ? null : results.length ? (
      group('results', 'Results', results.map((h) => row(h.doc, h.snippet)))
    ) : (
      <EmptyState
        title={`Nothing matches “${query}”`}
        action={
          <button type="button" className="btn" onClick={() => setQ('')}>
            Clear the search
          </button>
        }
      />
    );
  } else if (!inView.length) {
    body = (
      !docs.length ? (
        <EmptyState title="No artifacts yet" />
      ) : n > 0 && all.length === 0 ? (
        <EmptyState
          title="Nothing matches the filter"
          action={
            <button type="button" className="btn" onClick={() => save({ ...view, filter: clearFilter() })}>
              Clear filters
            </button>
          }
        />
      ) : (
        <EmptyState title={folder === 'unfiled' ? 'Nothing is unfiled' : folder === 'all' ? 'Nothing of this type' : 'This folder is empty'} />
      )
    );
  } else {
    const recent = recentDocs(inView);
    body = (
      <>
        <section className="list-group lib-recent" aria-label="Recent">
          <h2 className="lg">Recent</h2>
          <div className="lib-tiles">
            {recent.map((d) => (
              <a key={d.id} className="lib-tile" href={libraryHref(d.id)} title={d.path}>
                <ArtifactPreview doc={d} onError={onError} />
                <span className="lib-tile-t">
                  <b>{d.title}</b>
                </span>
                <span className="lib-tile-m">
                  <Avatar id={d.agentId} />
                  <span>{shortAgo(d.updatedAt)}</span>
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
      <div key={id} className={'lib-fold-row' + (f && isOldCanvases(f) ? ' old' : '')}>
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
      <button key={id} type="button" className={'tabbtn' + (!query && folder === id ? ' on' : '')} aria-pressed={!query && folder === id} onClick={() => pick(id)}>
        {name} <span className="tab-n">{counts.get(id) ?? 0}</span>
      </button>
    );

  return (
    <div className="library">
      <HeaderActions>
        {typeTabs('view-tabs lib-tabs-head')}
        <span className="head-sp" />
        <ProjectFilterButton value={pf} onChange={setPf} count={(f) => (docs ?? []).filter((d) => inFilter(f, d.projectId, pinfo)).length} />
        {searchBox('lib-head-search')}
        <button
          type="button"
          className={'icon-btn lib-search-btn' + (searching || query ? ' on' : '')}
          title="Search titles and content"
          aria-label="Search"
          aria-pressed={searching || !!query}
          onClick={() => {
            if (searching) setQ('');
            setSearching(!searching);
            if (!searching) setTimeout(() => searchRef.current?.focus(), 0);
          }}
        >
          <Icon.search />
        </button>
        <Menu
          open={menu}
          onOpen={setMenu}
          className="lib-filter"
          btnClass={'icon-only' + (n > 0 || view.tab !== 'all' ? ' on' : '')}
          title="Filter by type, agent, task or chat"
          label={
            <>
              <Icon.filter />
              {n > 0 && <span className="tab-n">{n}</span>}
            </>
          }
        >
          {/* Phone: no type tabs in the header, the type is picked here. */}
          <div className="lib-type-pick">
            <div className="pop-k">Type</div>
            {LIB_TABS.map((t) => (
              <PopRow key={t.id} on={view.tab === t.id} onClick={() => save({ ...view, tab: t.id })}>
                {t.label}
              </PopRow>
            ))}
          </div>
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
      </HeaderActions>
      <div className="lib-bar">
        {(searching || query) && searchBox('')}
        <ScrollTabs className="lib-chips" role="group" label="Folders">
          {chip('all', 'All')}
          {chip('unfiled', 'Unfiled')}
          {shownFolders.map((f) => chip(f.id, folderLabel(f), f))}
          {editing === 'new' ? (
            nameInput(null)
          ) : (
            <button type="button" className="tabbtn" title="New folder" aria-label="New folder" onClick={() => setEditing('new')}>
              <Icon.plus />
            </button>
          )}
          {current && !query && folderMenu(current, 'tabbtn')}
        </ScrollTabs>
      </div>
      <div className="lib-split">
        <nav className="lib-folders" aria-label="Folders">
          {folderItem('all', <Icon.library />, 'All')}
          {folderItem('unfiled', <Icon.inbox />, 'Unfiled')}
          <div className="side-group">
            Folders
            <button type="button" className="icon-btn" title="New folder" aria-label="New folder" onClick={() => setEditing('new')}>
              <Icon.plus />
            </button>
          </div>
          {shownFolders.map((f) => folderItem(f.id, <Icon.folder16 />, folderLabel(f), f))}
          {editing === 'new' && nameInput(null)}
        </nav>
        <div className="lib-main-col">
          <div className="lib-list">{body}</div>
        </div>
      </div>
      {deleting && <DeleteArtifactDialog doc={deleting} onCancel={() => setDeleting(null)} onDeleted={() => undefined} onError={onError} />}
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
