import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { KIND_WORD, type Doc, type DocRef, type PaneKind, type PanelTab } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { activeTab, artifactChoices, byline, panelMode, type PanelMode } from './docPanel.ts';
import { ArtifactViewer, KindIcon } from './Viewer.tsx';
import { Icon } from './ScreenHeader.tsx';
import { PopButton, PopItem } from './HeadMenu.tsx';
import { libraryHref } from './library.ts';
import type { PanelResize } from './PanelResizer.tsx';

/** What « Ask about this » puts in the composer: the reference sent with the message and the chip's label. */
export interface Quote {
  ref: DocRef;
  label: string;
}

/** A chat's open tabs, live (agents open and close them with panel_open / panel_close). */
export function usePanelTabs(chatId: string, stream: MessageStream, onError: (e: unknown) => void): PanelTab[] {
  const [tabs, setTabs] = useState<PanelTab[]>([]);
  useEffect(() => {
    api.panel(chatId).then(setTabs, onError);
    const offPanel = stream.listen('panel:' + chatId, (e) => e.type === 'panel' && setTabs(e.tabs));
    const offDocs = stream.listen('docs', (e) => {
      if (e.type === 'doc') setTabs((ts) => (ts.some((t) => t.doc.id === e.doc.id) ? ts.map((t) => (t.doc.id === e.doc.id ? { ...t, doc: e.doc } : t)) : ts));
    });
    return () => {
      offPanel();
      offDocs();
    };
  }, [chatId, stream, onError]);
  return tabs;
}

/** Side by side, overlay or full screen, following the window width. */
export function usePanelMode(): PanelMode {
  const [mode, setMode] = useState(() => panelMode(window.innerWidth));
  useEffect(() => {
    const on = () => setMode(panelMode(window.innerWidth));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return mode;
}

/**
 * The panel beside a direct chat (#120, mockup #106 v2): the shared viewer with the chat's artifacts as tabs, in ONE
 * head row: tabs, version, Latest, Full size, ⋯ (opened by, folder, path, source, Open in the Library), ×. On a phone
 * (full) it is the whole screen with « ‹ Back ». A chat card asks for its own version with `want`.
 */
export function DocPanel(props: {
  chatId: string;
  /** The chat's project: the + menu lists its artifacts. */
  projectId: string;
  tabs: PanelTab[];
  mode: PanelMode;
  /** Drag handle and width (#211); none on a phone. */
  resize?: PanelResize;
  userName: string | null;
  want: { docId: string; version: number; key: string } | null;
  stream: MessageStream;
  onAsk(q: Quote): void;
  onOpenCard(id: string): void;
  onHide(): void;
  /** The open artifact and the version on screen (#305: sent with Master's message). */
  onShown?(doc: Doc, version: number): void;
  onError(e: unknown): void;
}) {
  const { chatId, tabs, onError } = props;
  const [full, setFull] = useState(false);
  const tab = activeTab(tabs);
  const doc = tab?.doc;
  const unseen = !!tab && !!doc && tab.seenVersion < doc.version;
  const report = props.onShown;
  const shown = useCallback((v: number) => void (doc && report?.(doc, v)), [doc, report]);
  // Pages, diagrams and links have no section marks: showing the new version is seeing it.
  useEffect(() => {
    if (!doc || !unseen || doc.kind === 'markdown') return;
    const t = setTimeout(() => void api.panelSeen(chatId, doc.id).catch(onError), 1500);
    return () => clearTimeout(t);
  }, [chatId, doc, unseen, onError]);
  if (!tab || !doc) return null;
  const phone = props.mode === 'full';
  const mode = phone || full ? 'full' : props.mode;
  const items: PaneTabItem[] = tabs.map((t) => ({
    key: t.kind + ':' + t.doc.id,
    kind: t.kind,
    icon: <KindIcon kind={t.doc.kind} />,
    title: t.doc.title,
    tip: t.doc.path,
    on: t === tab,
    dot: t.seenVersion < t.doc.version,
    onSelect: () => void api.panelFocus(chatId, t.doc.id).catch(onError),
    onClose: () => void api.panelClose(chatId, t.doc.id).catch(onError),
  }));
  return (
    <aside className={'side-doc ' + mode} aria-label="Panel" style={props.resize && mode !== 'full' ? { width: props.resize.width } : undefined}>
      {mode !== 'full' && props.resize?.handle}
      <ArtifactViewer
        doc={doc}
        mode="panel"
        strip={
          phone ? (
            <TabPicker items={items} />
          ) : (
            <>
              <PaneTabs items={items} />
              <AddMenu chatId={chatId} projectId={props.projectId} open={tabs} onError={onError} />
            </>
          )
        }
        lead={
          (phone || props.mode === 'overlay') && (
            <button type="button" className="sd-btn sd-back" title="Back to the chat" onClick={props.onHide}>
              ‹ Back
            </button>
          )
        }
        want={props.want && props.want.docId === doc.id ? props.want : null}
        onShown={shown}
        tools={
          !phone && (
            <button
              type="button"
              className={'sd-btn icon-only' + (full ? ' on' : '')}
              title={full ? 'Back to the side panel' : 'Full size'}
              aria-label={full ? 'Back to the side panel' : 'Full size'}
              aria-pressed={full}
              onClick={() => setFull(!full)}
            >
              {full ? <Icon.shrink /> : <Icon.expand />}
            </button>
          )
        }
        by={byline({ openedBy: tab.openedBy, cardTitle: null }, props.userName)}
        menu={(close) => (
          <>
            {doc.cardId && tab.cardTitle && (
              <PopItem
                icon={<Icon.board />}
                onClick={() => {
                  close();
                  props.onOpenCard(doc.cardId!);
                }}
              >
                Open the task “{tab.cardTitle}”
              </PopItem>
            )}
            <a className="pop-row" role="menuitem" href={libraryHref(doc.id)} onClick={close}>
              <Icon.library />
              <span className="pop-t">Open in the Library</span>
            </a>
          </>
        )}
        end={
          !phone && (
            <button type="button" className="sd-btn icon-only" title="Close the panel" aria-label="Close the panel" onClick={() => api.panelClose(chatId, null).catch(onError)}>
              <Icon.x />
            </button>
          )
        }
        section={tab.section}
        scrollKey={tab.focusedAt}
        seenVersion={tab.seenVersion}
        stream={props.stream}
        onAsk={(s, v) => props.onAsk({ ref: { docId: doc.id, version: v, section: s?.id ?? null }, label: s?.title ? `${doc.title} › ${s.title}` : doc.title })}
        onSeen={() => void api.panelSeen(chatId, doc.id).catch(onError)}
        onError={onError}
      />
    </aside>
  );
}

/** One tab of the workbench (#302), whatever its kind: artifacts today; files and pages come with 2/5 and 5/5. */
export interface PaneTabItem {
  key: string;
  kind: PaneKind;
  icon: ReactNode;
  title: string;
  /** Tooltip: the artifact's path (a file's path, a page's address). */
  tip: string;
  on: boolean;
  /** « Changed since you looked ». */
  dot: boolean;
  onSelect(): void;
  onClose(): void;
}

/** The head row's tabs (#302, mockup « the right pane as a workbench »): one strip, every kind, the active one kept in view. */
function PaneTabs({ items }: { items: PaneTabItem[] }) {
  const strip = useRef<HTMLDivElement>(null);
  const on = items.find((i) => i.on)?.key;
  // A block body: recent Chrome returns a Promise from scrollIntoView, and React would call it as the cleanup.
  useEffect(() => {
    strip.current?.querySelector('.sd-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [on, items.length]);
  return (
    <div ref={strip} className="sd-tabs" role="tablist" aria-label="Panel tabs">
      {items.map((t) => (
        <div key={t.key} className={'sd-tab' + (t.on ? ' on' : '')} data-kind={t.kind}>
          <button role="tab" aria-selected={t.on} title={t.tip} onClick={() => !t.on && t.onSelect()}>
            {t.icon}
            <span className="sd-tab-t">{t.title}</span>
            {t.dot && <span className="sd-dot" title="Changed since you looked" />}
          </button>
          <button className="sd-tab-x" aria-label={`Close ${t.title}`} onClick={t.onClose}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** On a phone (#302): the active tab's title and « · N tabs »; a menu lists every tab, each with its ×. */
function TabPicker({ items }: { items: PaneTabItem[] }) {
  const on = items.find((i) => i.on) ?? items.at(-1);
  if (!on) return null;
  return (
    <PopButton
      className="wb-tabsel"
      title="Switch tab"
      ariaLabel={`${on.title}, ${items.length} ${items.length === 1 ? 'tab' : 'tabs'}: switch tab`}
      width={300}
      label={
        <>
          {on.icon}
          <span className="t">{on.title}</span>
          <span className="n">
            · {items.length} {items.length === 1 ? 'tab' : 'tabs'}
          </span>
          <Icon.chevDown />
        </>
      }
    >
      {(close) =>
        items.map((t) => (
          <div key={t.key} className={'wb-pick' + (t === on ? ' on' : '')} data-kind={t.kind}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={t === on}
              className="wb-pick-t"
              title={t.tip}
              onClick={() => {
                close();
                if (t !== on) t.onSelect();
              }}
            >
              {t.icon}
              <span className="pop-t">{t.title}</span>
              {t.dot && <span className="sd-dot" title="Changed since you looked" />}
            </button>
            <button type="button" className="sd-tab-x" aria-label={`Close ${t.title}`} onClick={t.onClose}>
              ×
            </button>
          </div>
        ))
      }
    </PopButton>
  );
}

/**
 * + in the head row (#302): open something in a new tab. Artifacts only for now (a filter, the project's artifacts
 * latest first); a file (⌘P) and a page join as a first group with the workbench's 2/5 and 5/5.
 */
function AddMenu(props: { chatId: string; projectId: string; open: PanelTab[]; onError(e: unknown): void }) {
  return (
    <PopButton className="sd-btn icon-only wb-add" title="Open an artifact" ariaLabel="Open an artifact" width={320} label={<Icon.plus />}>
      {(close) => <ArtifactPick {...props} onDone={close} />}
    </PopButton>
  );
}

function ArtifactPick(props: { chatId: string; projectId: string; open: PanelTab[]; onDone(): void; onError(e: unknown): void }) {
  const { onError } = props;
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [q, setQ] = useState('');
  const find = useRef<HTMLInputElement>(null);
  // Not autoFocus: the popover is still hidden while PopButton places it, and a hidden field can't take focus.
  useEffect(() => {
    const f = requestAnimationFrame(() => find.current?.focus());
    return () => cancelAnimationFrame(f);
  }, []);
  useEffect(() => {
    let live = true;
    api.documents().then((d) => live && setDocs(d), onError);
    return () => {
      live = false;
    };
  }, [onError]);
  const list = docs ? artifactChoices(docs, props.projectId, new Set(props.open.map((t) => t.doc.id)), q) : [];
  const pick = (d: Doc) => {
    props.onDone();
    void api.panelOpen(props.chatId, d.id).catch(onError);
  };
  return (
    <>
      <input
        ref={find}
        className="wb-find"
        type="search"
        value={q}
        placeholder="Find an artifact"
        aria-label="Find an artifact"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && list[0] && pick(list[0])}
      />
      {!docs && <span className="pop-note">Loading…</span>}
      {docs && !list.length && <span className="pop-note">{q ? 'No artifact matches.' : 'Every artifact of this project is open.'}</span>}
      {list.map((d) => (
        <PopItem key={d.id} icon={<KindIcon kind={d.kind} />} sub={KIND_WORD[d.kind]} onClick={() => pick(d)}>
          {d.title}
        </PopItem>
      ))}
    </>
  );
}

/**
 * The documents attached to a card (task panel, inbox item): a list; picking one shows it below in the shared
 * viewer, the card's other documents as tabs. « Open in panel » (when given) shows it beside the card's chat.
 */
export function CardDocs({ cardId, stream, onOpenInPanel, onShow, onError }: {
  cardId: string;
  stream: MessageStream;
  onOpenInPanel?(doc: Doc): void;
  /** A task's view (#192): a row opens the document there (over the task in its panel, or the chat's documents panel), not inline below. */
  onShow?(doc: Doc): void;
  onOpenCard?(id: string): void;
  onError(e: unknown): void;
}) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    const load = () => api.documents(cardId).then(setDocs, onError);
    void load();
    return stream.listen('docs', (e) => {
      if (e.type === 'doc' ? e.doc.cardId === cardId : e.type === 'docDeleted') void load();
    });
  }, [cardId, stream, onError]);
  if (!docs.length) return null;
  const doc = docs.find((d) => d.id === shown) ?? null;
  return (
    <>
      <h3 className="cm-h">Artifacts</h3>
      <div className="cm-docs">
        {docs.map((d) => (
          <button
            key={d.id}
            className={'cm-doc' + (d.id === shown ? ' on' : '')}
            aria-expanded={onShow ? undefined : d.id === shown}
            onClick={() => (onShow ? onShow(d) : setShown(d.id === shown ? null : d.id))}
          >
            <span className="cm-doc-icon">
              <KindIcon kind={d.kind} />
            </span>
            <span className="cm-doc-title">{d.title}</span>
            <span className="cm-doc-meta">
              {KIND_WORD[d.kind]} · v{d.version}
            </span>
            <span className="cm-doc-open">{onShow ? 'Open' : d.id === shown ? 'hide' : 'show ↓'}</span>
          </button>
        ))}
      </div>
      {doc && (
        <ArtifactViewer
          doc={doc}
          mode="inline"
          tabs={docs.length > 1 ? docs.map((d) => ({ doc: d })) : undefined}
          onTab={(d) => setShown(d.id)}
          menu={(close) => (
            <>
              {onOpenInPanel && (
                <PopItem
                  icon={<Icon.panel />}
                  onClick={() => {
                    close();
                    onOpenInPanel(doc);
                  }}
                >
                  Show it beside the task's chat
                </PopItem>
              )}
              <a className="pop-row" role="menuitem" href={libraryHref(doc.id)} onClick={close}>
                <Icon.library />
                <span className="pop-t">Open in the Library</span>
              </a>
            </>
          )}
          end={
            <button type="button" className="sd-btn icon-only" title="Hide" aria-label="Hide the artifact" onClick={() => setShown(null)}>
              <Icon.x />
            </button>
          }
          stream={stream}
          onError={onError}
        />
      )}
    </>
  );
}

/** A document to read from a task (#192): a chip in its thread (its version and section) or a row of its Artifacts. */
export interface DocToRead {
  docId: string;
  version: number | null;
  section: string | null;
  /** A new key opens it again (same chip clicked twice). */
  key: string;
}

/**
 * A document read from the task panel (#192): the shared viewer filling the panel, over the task (which stays as it
 * was: scroll, draft). « ‹ Task » or Esc goes back. The chip's version and section are shown; the task's other
 * documents are not tabs here, its Artifacts list is one click away.
 */
export function TaskDocReader(props: { read: DocToRead; stream: MessageStream; onOpenInPanel?(doc: Doc): void; onBack(): void; onError(e: unknown): void }) {
  const { read, stream, onBack, onError } = props;
  const [doc, setDoc] = useState<Doc | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    api.document(read.docId).then((c) => live && setDoc(c.doc), onError);
    const off = stream.listen('docs', (e) => {
      if (e.type === 'doc' && e.doc.id === read.docId) setDoc(e.doc);
      if (e.type === 'docDeleted' && e.id === read.docId) onBack(); // deleted (#242): back to the task
    });
    return () => {
      live = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read.docId, stream, onError]);
  // Focus stays inside (Esc comes here): on ‹ Task once open and loaded; a click in the text focuses the reader itself.
  const loaded = doc !== null;
  useEffect(() => back.current?.focus({ preventScroll: true }), [read.key, loaded]);
  return (
    <div
      className="cm-reader"
      role="region"
      aria-label="Artifact"
      tabIndex={-1}
      onKeyDown={(e) => {
        // Esc goes back to the task (a menu inside closes first); the panel's own Esc sees it handled.
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        onBack();
      }}
    >
      {doc ? (
        <ArtifactViewer
          doc={doc}
          mode="panel"
          lead={
            <button ref={back} type="button" className="sd-btn sd-back" title="Back to the task (Esc)" onClick={onBack}>
              ‹ Task
            </button>
          }
          want={read.version === null ? null : { version: read.version, key: read.key }}
          section={read.section}
          scrollKey={read.key}
          menu={(close) => (
            <>
              {props.onOpenInPanel && (
                <PopItem
                  icon={<Icon.panel />}
                  onClick={() => {
                    close();
                    props.onOpenInPanel!(doc);
                  }}
                >
                  Show it beside the task's chat
                </PopItem>
              )}
              <a className="pop-row" role="menuitem" href={libraryHref(doc.id)} onClick={close}>
                <Icon.library />
                <span className="pop-t">Open in the Library</span>
              </a>
            </>
          )}
          stream={stream}
          onError={onError}
        />
      ) : (
        <div className="sd-head">
          <button ref={back} type="button" className="sd-btn sd-back" title="Back to the task (Esc)" onClick={onBack}>
            ‹ Task
          </button>
          <span className="cm-faint">Loading…</span>
        </div>
      )}
    </div>
  );
}
