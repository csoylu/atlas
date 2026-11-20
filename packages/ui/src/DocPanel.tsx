import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { KIND_WORD, tabKey, type CommentTarget, type Doc, type FileTab, type PaneKind, type PanelTab } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { activeTab, artifactChoices, byline, panelMode, type PanelMode } from './docPanel.ts';
import { ArtifactViewer, KindIcon } from './Viewer.tsx';
import { Icon } from './ScreenHeader.tsx';
import { PopButton, PopItem } from './HeadMenu.tsx';
import { libraryHref } from './library.ts';
import { closeFileTab, FileIcon, FileKindIcon, FilesPane } from './FilesPane.tsx';
import { fileDrafts, useDrafts } from './fileDrafts.ts';
import { fileTitle } from './files.ts';
import type { PanelResize } from './PanelResizer.tsx';
import { CommentBox, CommentHint, CommentIcon, type PaneComment } from './CommentLayer.tsx';
import { boxOf, draftKey, hintFor, isTyping, type Comments, type PanePick } from './comments.ts';
import { BrowserPane, useBrowserStatus, useDriving } from './BrowserPane.tsx';
import { browserTitle } from './browserTab.ts';

/** A chat's open tabs, live (agents open and close them with panel_open / panel_close). */
export function usePanelTabs(chatId: string, stream: MessageStream, onError: (e: unknown) => void): PanelTab[] {
  const [tabs, setTabs] = useState<PanelTab[]>([]);
  useEffect(() => {
    api.panel(chatId).then(setTabs, onError);
    const offPanel = stream.listen('panel:' + chatId, (e) => e.type === 'panel' && setTabs(e.tabs));
    // The browser's live state (#306: loading, title, the agent's last action) comes on its own key.
    const offBrowser = stream.listen('browser:' + chatId, (e) => {
      if (e.type === 'browser') setTabs((ts) => ts.map((t) => (t.kind === 'browser' ? { ...t, tab: e.tab } : t)));
      else if (e.type === 'browserClosed') setTabs((ts) => ts.filter((t) => t.kind !== 'browser'));
    });
    const offDocs = stream.listen('docs', (e) => {
      if (e.type === 'doc')
        setTabs((ts) => (ts.some((t) => t.kind === 'artifact' && t.doc.id === e.doc.id) ? ts.map((t) => (t.kind === 'artifact' && t.doc.id === e.doc.id ? { ...t, doc: e.doc } : t)) : ts));
    });
    return () => {
      offPanel();
      offBrowser();
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
 * The panel beside a direct chat (#120, mockup #106 v2; the workbench #302, #303): tabs of every kind in ONE head row
 * (tabs, +, version, Full size, ⋯, ×), then the open tab: an artifact in the shared viewer, or a file of the chat's
 * agent workspace (FilesPane: tree, editor). On a phone (full) it is the whole screen with « ‹ Back ». A chat card
 * asks for its own version with `want`.
 */
export function DocPanel(props: {
  chatId: string;
  /** The chat's project: the + menu lists its artifacts. */
  projectId: string;
  /** The chat's agent: Files shows its workspace in the chat's project. */
  agentId: string | null;
  tabs: PanelTab[];
  mode: PanelMode;
  /** Drag handle and width (#211); none on a phone. */
  resize?: PanelResize;
  userName: string | null;
  want: { docId: string; version: number; key: string } | null;
  stream: MessageStream;
  /** The chat's waiting comments (#304): comment mode adds to them, the composer sends them. */
  comments: Comments;
  onOpenCard(id: string): void;
  onHide(): void;
  /** The open artifact and the version on screen (#305: sent with Master's message). */
  onShown?(doc: Doc, version: number): void;
  /** The open file's lines on screen (#305, file kind). */
  onFileLines?(path: string, from: number, to: number): void;
  onError(e: unknown): void;
}) {
  const { chatId, tabs, onError, comments } = props;
  const [full, setFull] = useState(false);
  useDrafts();
  const tab = activeTab(tabs);
  const doc = tab?.kind === 'artifact' ? tab.doc : undefined;
  const browserStatus = useBrowserStatus();
  const browserTab = tabs.find((t) => t.kind === 'browser')?.tab;
  const driving = useDriving(browserTab);
  // Master's click refused while the agent acts (#298 §3.1): the pane's strip says so for a moment.
  const [blockedAt, setBlockedAt] = useState(0);
  useEffect(() => props.stream.listen('browser:' + chatId, (e) => e.type === 'browser' && e.blocked && setBlockedAt(Date.now())), [props.stream, chatId]);
  // The pane's width: under 520 px the browser's bar uses short labels (mockup).
  const [narrow, setNarrow] = useState(false);
  // Comment mode (#304): on for the open tab; a pick opens the box, Add puts the comment in the composer.
  const [commenting, setCommenting] = useState(false);
  const [pending, setPending] = useState<{ pick: PanePick; version: number } | null>(null);
  const aside = useRef<HTMLElement>(null);
  // The open file, when it is text (comments are on its lines); images and binaries take none yet.
  const fileText = tab?.kind === 'file' && !!tab.path && fileDrafts.get(chatId, tab.path)?.file.kind === 'text';
  // A page takes comments when it shows (not an empty tab, an error or a blocked host).
  const pageOn = tab?.kind === 'browser' && !!tab.tab.url && !tab.tab.error && !tab.tab.crashed && !!browserStatus?.available;
  const docId = doc?.id ?? (fileText || pageOn ? tabKey(tab!) + (tab?.kind === 'browser' ? tab.tab.url : '') : undefined);
  useEffect(() => {
    const el = aside.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.getBoundingClientRect().width < 520));
    ro.observe(el);
    return () => ro.disconnect();
  });
  useEffect(() => {
    setCommenting(false);
    setPending(null);
  }, [docId]);
  const stop = () => {
    setPending(null);
    setCommenting(false);
  };
  // C enters comment mode (not while typing), Esc leaves it; first, before the chat's own Esc (rewind).
  useEffect(() => {
    if (!docId) return;
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (e.key === 'Escape' && commenting && !pending) {
        e.preventDefault();
        e.stopPropagation();
        setCommenting(false);
      } else if ((e.key === 'c' || e.key === 'C') && !isTyping(e.target) && !document.querySelector('[role=dialog][aria-modal=true]')) {
        e.preventDefault();
        setCommenting(true);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [docId, commenting, pending]);
  const unseen = tab?.kind === 'artifact' && !!doc && tab.seenVersion < doc.version;
  const report = props.onShown;
  const shown = useCallback((v: number) => void (doc && report?.(doc, v)), [doc, report]);
  // Pages, diagrams and links have no section marks: showing the new version is seeing it.
  useEffect(() => {
    if (!doc || !unseen || doc.kind === 'markdown') return;
    const t = setTimeout(() => void api.panelSeen(chatId, doc.id).catch(onError), 1500);
    return () => clearTimeout(t);
  }, [chatId, doc, unseen, onError]);
  if (!tab) return null;
  const phone = props.mode === 'full';
  // What a comment is on: the artifact at its version, or the file (#303: its lines).
  const target: CommentTarget | null = doc
    ? { kind: 'doc', docId: doc.id, version: doc.version }
    : fileText && tab.kind === 'file'
      ? { kind: 'file', path: tab.path }
      : pageOn && tab.kind === 'browser'
        ? { kind: 'browser', url: tab.tab.url!, title: tab.tab.title }
        : null;
  const mine = target ? comments.list.filter((c) => draftKey(c.target) === draftKey(target)) : [];
  const comment: PaneComment = {
    on: commenting && !pending,
    marks: [...mine.map((c) => ({ n: c.n, mark: c.mark })), ...(pending ? [{ n: comments.list.length + 1, mark: pending.pick.mark }] : [])],
    onPick: (pick, version) => setPending({ pick, version }),
    onKey: (k) => (k === 'Escape' ? (pending ? setPending(null) : setCommenting(false)) : setCommenting(true)),
  };
  const mode = phone || full ? 'full' : props.mode;
  const items: PaneTabItem[] = tabs.map((t) =>
    t.kind === 'browser'
      ? {
          key: tabKey(t),
          kind: t.kind,
          icon: <Icon.globe />,
          title: browserTitle(t.tab),
          tip: `${t.tab.agentId ? t.tab.agentId + '’s browser' : 'Your browser'}${t.tab.url ? ' · ' + t.tab.url : ''}`,
          on: t === tab,
          dot: false,
          live: driving ? `${t.tab.agentId ?? 'The agent'} is using the browser` : undefined,
          unsaved: false,
          onSelect: () => void api.browserFocus(chatId).catch(onError),
          onClose: () => void api.browserClose(chatId).catch(onError),
        }
      : t.kind === 'artifact'
      ? {
          key: tabKey(t),
          kind: t.kind,
          icon: <KindIcon kind={t.doc.kind} />,
          title: t.doc.title,
          tip: t.doc.path,
          on: t === tab,
          dot: t.seenVersion < t.doc.version,
          unsaved: false,
          onSelect: () => void api.panelFocus(chatId, t.doc.id).catch(onError),
          onClose: () => void api.panelClose(chatId, t.doc.id).catch(onError),
        }
      : {
          key: tabKey(t),
          kind: t.kind,
          icon: <FileKindIcon path={t.path} />,
          title: fileTitle(t.path),
          tip: t.path || `${props.agentId}’s workspace`,
          on: t === tab,
          dot: false,
          unsaved: fileDrafts.dirty(chatId, t.path),
          onSelect: () => void api.panelFocusFile(chatId, t.path).catch(onError),
          onClose: () => closeFileTab(chatId, t.path, onError),
        },
  );
  const strip = phone ? (
    <TabPicker items={items} />
  ) : (
    <>
      <PaneTabs items={items} />
      <AddMenu chatId={chatId} projectId={props.projectId} agentId={props.agentId} open={tabs} browser={!!browserStatus?.available} onError={onError} />
    </>
  );
  const lead = (phone || props.mode === 'overlay') && (
    <button type="button" className="sd-btn sd-back" title="Back to the chat" onClick={props.onHide}>
      ‹ Back
    </button>
  );
  const tools = (
    <>
      {target && (
        <button
          type="button"
          className={'sd-btn icon-only' + (commenting ? ' on' : '')}
          title={commenting ? 'Leave comment mode (Esc)' : 'Comment (C)'}
          aria-label="Comment"
          aria-pressed={commenting}
          onClick={() => (commenting ? stop() : setCommenting(true))}
        >
          <CommentIcon />
        </button>
      )}
      {!phone && (
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
      )}
    </>
  );
  const commentUi = target && (
    <>
      {commenting && !pending && <CommentHint text={hintFor(doc ? doc.kind : tab.kind === 'browser' ? 'browser' : 'file')} waiting={comments.list.length} onDone={stop} />}
      {pending && (
        <CommentBox
          key={JSON.stringify(pending.pick.rect)}
          n={comments.list.length + 1}
          anchor={pending.pick.anchor}
          rect={pending.pick.rect}
          within={aside.current ? boxOf(aside.current.getBoundingClientRect()) : null}
          sheet={phone}
          onCancel={() => setPending(null)}
          onAdd={(text) => {
            const on: CommentTarget = target.kind === 'doc' ? { ...target, version: pending.version } : target;
            const title = doc ? doc.title : tab.kind === 'browser' ? browserTitle(tab.tab) : fileTitle(tab.kind === 'file' ? tab.path : '');
            const kind = doc ? doc.kind : tab.kind === 'browser' ? 'browser' : 'file';
            comments.add({ target: on, anchor: pending.pick.anchor, text, title, kind, mark: pending.pick.mark, thumb: pending.pick.thumb ?? null });
            window.getSelection()?.removeAllRanges();
            setPending(null);
          }}
        />
      )}
    </>
  );
  const end = !phone && (
    <button type="button" className="sd-btn icon-only" title="Close the panel" aria-label="Close the panel" onClick={() => closePanel(chatId, tabs, driving, props.onHide, onError)}>
      <Icon.x />
    </button>
  );
  const style = props.resize && mode !== 'full' ? { width: props.resize.width } : undefined;
  if (tab.kind === 'browser')
    return (
      <aside ref={aside} className={'side-doc ' + mode} aria-label="Panel" style={style}>
        {mode !== 'full' && props.resize?.handle}
        <div className="viewer panel">
          <div className="sd-head">
            {lead}
            {strip}
            {tools}
            <PopButton className="sd-btn icon-only" title="More" ariaLabel="More" label={<Icon.dots />}>
              {(close) => (
                <>
                  <div className="pop-info">
                    <span>{tab.tab.agentId ? `${tab.tab.agentId}’s browser: cookies and logins stay with ${tab.tab.agentId} in this project` : 'Your own browser: no agent drives it'}</span>
                    {tab.tab.url && <span className="pop-path">{tab.tab.url}</span>}
                  </div>
                  {tab.tab.url && (
                    <>
                      <div className="pop-sep" />
                      <PopItem
                        icon={<Icon.code />}
                        onClick={() => {
                          close();
                          void navigator.clipboard.writeText(tab.tab.url!).catch(onError);
                        }}
                      >
                        Copy the address
                      </PopItem>
                      <a className="pop-row" role="menuitem" href={tab.tab.url} target="_blank" rel="noreferrer" data-external="1" onClick={close}>
                        <Icon.ext />
                        <span className="pop-t">Open in system browser</span>
                      </a>
                    </>
                  )}
                </>
              )}
            </PopButton>
            {end}
          </div>
          <BrowserPane
            chatId={chatId}
            tab={tab.tab}
            agentId={props.agentId}
            status={browserStatus}
            phone={phone}
            tight={narrow}
            blockedAt={blockedAt}
            comment={pageOn ? comment : undefined}
            commenting={commenting}
            onError={onError}
          />
        </div>
        {commentUi}
      </aside>
    );
  if (tab.kind === 'file')
    return (
      <aside ref={aside} className={'side-doc ' + mode} aria-label="Panel" style={style}>
        {mode !== 'full' && props.resize?.handle}
        <div className="viewer panel">
          <div className="sd-head">
            {lead}
            {strip}
            {tools}
            <PopButton className="sd-btn icon-only" title="More" ariaLabel="More" label={<Icon.dots />}>
              {(close) => (
                <>
                  <div className="pop-info">
                    <span>{byline({ openedBy: tab.openedBy, cardTitle: null }, props.userName)}</span>
                    <span className="pop-path">{tab.path || `${props.agentId}’s workspace`}</span>
                  </div>
                  {tab.path && (
                    <>
                      <div className="pop-sep" />
                      <PopItem
                        icon={<Icon.code />}
                        onClick={() => {
                          close();
                          void navigator.clipboard.writeText(tab.path).catch(onError);
                        }}
                      >
                        Copy the path
                      </PopItem>
                    </>
                  )}
                </>
              )}
            </PopButton>
            {end}
          </div>
          {props.agentId ? (
            <FilesPane
              chatId={chatId}
              tab={tab}
              tabs={tabs.filter((t): t is FileTab => t.kind === 'file')}
              mode={mode}
              agentId={props.agentId}
              comment={fileText ? comment : undefined}
              commenting={commenting}
              onLines={props.onFileLines}
              onError={onError}
            />
          ) : (
            <div className="wb-note">This chat has no agent: no workspace to show.</div>
          )}
        </div>
        {commentUi}
      </aside>
    );
  if (!doc) return null;
  return (
    <aside ref={aside} className={'side-doc ' + mode} aria-label="Panel" style={style}>
      {mode !== 'full' && props.resize?.handle}
      <ArtifactViewer
        doc={doc}
        mode="panel"
        strip={strip}
        lead={lead}
        want={props.want && props.want.docId === doc.id ? props.want : null}
        onShown={shown}
        tools={tools}
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
        end={end}
        section={tab.section}
        scrollKey={tab.focusedAt}
        seenVersion={tab.seenVersion}
        stream={props.stream}
        comment={comment}
        onSeen={() => void api.panelSeen(chatId, doc.id).catch(onError)}
        onError={onError}
      />
      {commentUi}
    </aside>
  );
}

/**
 * × of the panel: every tab closes; unsaved files ask first. The browser closes too, unless the agent is driving it
 * (#306): then the pane only hides, and its button carries a dot while the agent works.
 */
function closePanel(chatId: string, tabs: PanelTab[], driving: boolean, hide: () => void, onError: (e: unknown) => void) {
  const dirty = tabs.filter((t): t is FileTab => t.kind === 'file' && fileDrafts.dirty(chatId, t.path));
  if (dirty.length && !confirm(`${dirty.map((t) => fileTitle(t.path)).join(', ')} ${dirty.length === 1 ? 'has' : 'have'} unsaved changes. Close the panel and lose them?`)) return;
  for (const t of tabs) if (t.kind === 'file') fileDrafts.drop(chatId, t.path);
  if (tabs.some((t) => t.kind !== 'browser')) void api.panelClose(chatId, null).catch(onError);
  if (!tabs.some((t) => t.kind === 'browser')) return;
  if (driving) hide();
  else void api.browserClose(chatId).catch(onError);
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
  /** A file with unsaved edits (#303): a dot in place of ×; closing asks first. */
  unsaved: boolean;
  /** The browser while the agent drives it (#306): a live dot, this is its tooltip. */
  live?: string;
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
            {t.live && <span className="wb-live" title={t.live} aria-label={t.live} />}
          </button>
          <button className={'sd-tab-x' + (t.unsaved ? ' unsaved' : '')} aria-label={`Close ${t.title}${t.unsaved ? ' (unsaved changes)' : ''}`} title={t.unsaved ? 'Unsaved changes' : undefined} onClick={t.onClose}>
            {t.unsaved ? <span className="wb-udot" aria-hidden="true" /> : '×'}
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
              {t.live && <span className="wb-live" title={t.live} aria-label={t.live} />}
            </button>
            <button type="button" className={'sd-tab-x' + (t.unsaved ? ' unsaved' : '')} aria-label={`Close ${t.title}${t.unsaved ? ' (unsaved changes)' : ''}`} onClick={t.onClose}>
              {t.unsaved ? <span className="wb-udot" aria-hidden="true" /> : '×'}
            </button>
          </div>
        ))
      }
    </PopButton>
  );
}

/**
 * + in the head row (#302, #303): open something in a new tab. First the agent's files (⌘P), then the project's
 * artifacts (a filter, latest first); a page joins with the workbench's 5/5.
 */
function AddMenu(props: { chatId: string; projectId: string; agentId: string | null; open: PanelTab[]; browser: boolean; onError(e: unknown): void }) {
  const { chatId, agentId, onError } = props;
  const what = [props.browser && 'a page', agentId && 'a file (⌘P)', 'an artifact'].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' or $1');
  return (
    <PopButton className="sd-btn icon-only wb-add" title={'Open ' + what} ariaLabel="Open" width={320} label={<Icon.plus />}>
      {(close) => (
        <>
          {props.browser && (
            <PopItem
              icon={<Icon.globe />}
              sub={props.open.some((t) => t.kind === 'browser') ? 'open' : undefined}
              onClick={() => {
                close();
                // One browser per chat (#298): an open one is shown, else a new one with its address bar focused.
                void (props.open.some((t) => t.kind === 'browser') ? api.browserFocus(chatId) : api.browserCreate(chatId)).catch(onError);
              }}
            >
              A page{agentId ? ` in ${agentId}’s browser` : ''}
            </PopItem>
          )}
          {agentId && (
            <>
              <PopItem
                icon={<FileIcon.file />}
                sub="⌘P"
                onClick={() => {
                  close();
                  openFiles(chatId, props.open, onError);
                }}
              >
                A file of {agentId}’s workspace
              </PopItem>
              <div className="pop-sep" />
            </>
          )}
          <ArtifactPick {...props} onDone={close} />
        </>
      )}
    </PopButton>
  );
}

/** The workspace tab (the tree, its filter focused): an open file tab shows its tree, else the « Files » tab. */
export function openFiles(chatId: string, open: PanelTab[], onError: (e: unknown) => void) {
  const shown = activeTab(open);
  if (shown?.kind === 'file') return void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }));
  const ws = open.find((t) => t.kind === 'file' && t.path === '');
  void (ws ? api.panelFocusFile(chatId, '') : api.panelOpenFile(chatId, '')).catch(onError);
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
  const list = docs ? artifactChoices(docs, props.projectId, new Set(props.open.flatMap((t) => (t.kind === 'artifact' ? [t.doc.id] : []))), q) : [];
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
