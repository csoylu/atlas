import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { FileTab, WsEntry, WsFile, WsListing } from '@atlas/shared';
import { api, ApiError } from './api.ts';
import { ancestors, binaryWhat, fileState, gitTitle, langOf, rowIcon, splitPath, treeBeside } from './files.ts';
import { fileDrafts, useDrafts, type Draft } from './fileDrafts.ts';
import type { PanelMode } from './docPanel.ts';
import type { CodeEditorHandle } from './CodeEditor.tsx';
import { relAgo } from './library.ts';
import type { PaneComment } from './CommentLayer.tsx';

// CodeMirror loads with the first file opened, in its own chunk: the app's main bundle stays as it was.
const CodeEditor = lazy(() => import('./CodeEditor.tsx'));

/** How often the open file and the tree are checked for the agent's writes. */
const POLL_MS = 2000;
const TREE_KEY = 'atlas.files.tree';

const P = (d: ReactNode, w = 14) => (
  <svg
    className="icon"
    viewBox="0 0 16 16"
    width={w}
    height={w}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {d}
  </svg>
);
export const FileIcon = {
  file: () => P(<path d="M3.5 2.5h6l3 3v8h-9z M9.5 2.5v3h3" />),
  code: () => P(<path d="M3.5 2.5h6l3 3v8h-9z M9.5 2.5v3h3 M6.8 8.3 5.3 9.8l1.5 1.5M9.2 8.3l1.5 1.5-1.5 1.5" />),
  md: () => P(<path d="M3.5 2.5h6l3 3v8h-9z M9.5 2.5v3h3M5.5 8.5h5M5.5 11h3.5" />),
  image: () => P(<path d="M2 3h12v10H2z M6 6.5a1.2 1.2 0 1 0 0.01 0 M14 11l-3.5-3.5L4 13" />),
  chevR: () => P(<path d="m6 4 4 4-4 4" />, 12),
  chevD: () => P(<path d="m4 6 4 4 4-4" />, 12),
  tree: () => P(<path d="M2 2.5h12v11H2z M6 2.5v11" />),
  search: () => P(<path d="M7 3a4 4 0 1 0 0.01 0 M10 10l3.5 3.5" />, 13),
  warn: () => P(<path d="M8 2.5l6 10.5H2z M8 6.5v3M8 11.3v.1" />),
};
export function FileKindIcon({ path }: { path: string }) {
  const k = path ? rowIcon(path) : 'file';
  const I = FileIcon[k];
  return <I />;
}

/** Is the tree shown? A choice kept across chats (⌘B); in a narrow pane it is a whole-pane view instead. */
function useTreeOn(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => localStorage.getItem(TREE_KEY) !== 'off');
  return [
    on,
    (v) => {
      localStorage.setItem(TREE_KEY, v ? 'on' : 'off');
      setOn(v);
    },
  ];
}

/**
 * The Files tab's bar and body (#303, mockup « the right pane as a workbench », Files): the tree of the chat's agent
 * workspace (⌘B hides it, ⌘P finds a file, A / M git letters), the editor (⌘S saves) and the banners when the agent
 * writes or deletes the file being edited. The head row (tabs, +, ⋯, ×) is DocPanel's.
 */
export function FilesPane(props: {
  chatId: string;
  tab: FileTab;
  tabs: FileTab[];
  mode: PanelMode;
  agentId: string;
  /** « What the agent sees » (#305): the lines of the open file on screen. */
  onLines?(path: string, from: number, to: number): void;
  /** Comment mode on the file's lines (#304); `commenting`: the mode is on (the tree steps aside, as in the mockup). */
  comment?: PaneComment;
  commenting?: boolean;
  onError(e: unknown): void;
}) {
  const { chatId, tab, onError } = props;
  // The body is remounted with each file (keyed by path): a callback ref follows the live element.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!box) return;
    setWidth(box.clientWidth);
    const ro = new ResizeObserver(() => setWidth(box.clientWidth));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);
  const beside = treeBeside(props.mode, width);
  const [treeOn, setTreeOn] = useTreeOn();
  // Narrow (overlay, phone, under 560 px): the tree is a whole-pane view; picking a file shows the editor.
  const [treeFull, setTreeFull] = useState(false);
  const workspace = tab.path === '';
  const showTree = workspace || (!props.commenting && (beside ? treeOn : treeFull));
  const filter = useRef<HTMLInputElement>(null);
  const [findAsk, setFindAsk] = useState(0);
  useEffect(() => setTreeFull(false), [tab.path, tab.focusedAt]);

  // ⌘B: hide / show the tree; ⌘P: find a file (the tree shows first).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.defaultPrevented) return;
      const k = e.key.toLowerCase();
      if (k === 'b') {
        e.preventDefault();
        if (workspace) return;
        if (beside) setTreeOn(!treeOn);
        else setTreeFull(!treeFull);
      } else if (k === 'p') {
        e.preventDefault();
        if (!workspace) beside ? setTreeOn(true) : setTreeFull(true);
        // Shown already: focus now, so the first letters typed right after ⌘P land in the filter.
        if (filter.current) filter.current.focus();
        else setFindAsk((n) => n + 1);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [beside, treeOn, treeFull, workspace, setTreeOn]);
  useEffect(() => {
    if (findAsk) requestAnimationFrame(() => filter.current?.focus());
  }, [findAsk]);

  const open = (path: string) => {
    setTreeFull(false);
    if (path === tab.path) return;
    const there = props.tabs.some((t) => t.path === path);
    void (there ? api.panelFocusFile(chatId, path) : api.panelOpenFile(chatId, path)).catch(onError);
  };
  const toggle = () => (beside ? setTreeOn(!treeOn) : setTreeFull(!treeFull));

  return (
    <>
      <FileBarAndBody
        key={tab.path}
        chatId={chatId}
        tab={tab}
        agentId={props.agentId}
        treeShown={showTree}
        onToggleTree={workspace ? undefined : toggle}
        onError={onError}
        onLines={props.onLines}
        comment={props.comment}
        boxRef={setBox}
        tree={
          showTree && (
            <FileTree
              chatId={chatId}
              agentId={props.agentId}
              selected={tab.path}
              full={workspace || !beside}
              filterRef={filter}
              onPick={open}
              onError={onError}
            />
          )
        }
        treeOnly={workspace || (!beside && treeFull)}
      />
    </>
  );
}

function FileBarAndBody(props: {
  chatId: string;
  tab: FileTab;
  agentId: string;
  treeShown: boolean;
  treeOnly: boolean;
  tree: ReactNode;
  boxRef: (el: HTMLDivElement | null) => void;
  onToggleTree?(): void;
  onLines?(path: string, from: number, to: number): void;
  comment?: PaneComment;
  onError(e: unknown): void;
}) {
  const { chatId, tab, agentId, onError } = props;
  const path = tab.path;
  useDrafts();
  const draft = path ? fileDrafts.get(chatId, path) : undefined;
  const [missing, setMissing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [compare, setCompare] = useState(false);
  const [image, setImage] = useState<{ w: number; h: number } | null>(null);
  const [docKey, setDocKey] = useState(0);
  const editor = useRef<CodeEditorHandle>(null);

  // Load (once per path while the app runs: a draft keeps unsaved edits across tab switches).
  useEffect(() => {
    if (!path || fileDrafts.get(chatId, path)) return;
    let live = true;
    api.fileRead(chatId, path).then(
      (file) => live && fileDrafts.set(chatId, path, { file, text: null, conflict: null }),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setMissing(e.message);
        else onError(e);
      },
    );
    return () => {
      live = false;
    };
  }, [chatId, path, onError]);

  // The agent's writes: the file's stamp is polled; unchanged edits follow the disk, unsaved ones get a banner.
  useEffect(() => {
    if (!path) return;
    let live = true;
    const tick = async () => {
      const d = fileDrafts.get(chatId, path);
      if (!d || !live || document.hidden) return;
      const st = await api.fileStat(chatId, path);
      if (!live) return;
      const cur = fileDrafts.get(chatId, path);
      if (!cur) return;
      if (!st.exists) {
        if (cur.conflict?.kind !== 'deleted')
          fileDrafts.set(chatId, path, {
            ...cur,
            conflict: { kind: 'deleted', at: Date.now() },
          });
        return;
      }
      const known = cur.conflict?.kind === 'changed' ? cur.conflict.theirs.stamp : cur.file.stamp;
      if (st.stamp === known && cur.conflict?.kind !== 'deleted') return;
      const theirs = await api.fileRead(chatId, path);
      if (!live) return;
      const now = fileDrafts.get(chatId, path);
      if (!now) return;
      if (theirs.hash === now.file.hash) {
        fileDrafts.set(chatId, path, { ...now, file: theirs, conflict: null }); // touched, same bytes (or back again)
        return;
      }
      if (now.text === null && now.conflict === null) {
        // Nothing unsaved: show the agent's version.
        fileDrafts.set(chatId, path, {
          file: theirs,
          text: null,
          conflict: null,
        });
        setDocKey((k) => k + 1);
        return;
      }
      fileDrafts.set(chatId, path, {
        ...now,
        conflict: { kind: 'changed', theirs, at: Date.now() },
      });
    };
    const t = setInterval(() => void tick().catch(onError), POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [chatId, path, onError]);

  // The window asks before leaving with unsaved edits.
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (fileDrafts.anyDirty()) e.preventDefault();
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, []);

  const file = draft?.file ?? null;
  const dirty = draft?.text != null;
  const conflict = draft?.conflict ?? null;

  const save = useCallback(
    (base: string | null | undefined, text?: string) => {
      const d = fileDrafts.get(chatId, path);
      if (!d || d.file.readOnly) return;
      const content = text ?? editor.current?.text() ?? d.text ?? d.file.content ?? '';
      setSaving(true);
      api
        .fileSave(chatId, {
          path,
          content,
          base: base === undefined ? d.file.hash : base,
        })
        .then((r) => {
          const now = fileDrafts.get(chatId, path) ?? d;
          if (r.ok) {
            // Saved: what was typed since the request left stays unsaved.
            const typed = editor.current?.text() ?? content;
            fileDrafts.set(chatId, path, {
              file: r.file,
              text: typed === r.file.content ? null : typed,
              conflict: null,
            });
            setCompare(false);
          } else if (r.conflict === 'deleted')
            fileDrafts.set(chatId, path, {
              ...now,
              conflict: { kind: 'deleted', at: Date.now() },
            });
          else if (r.file)
            fileDrafts.set(chatId, path, {
              ...now,
              conflict: { kind: 'changed', theirs: r.file, at: Date.now() },
            });
        }, onError)
        .finally(() => setSaving(false));
    },
    [chatId, path, onError],
  );
  // ⌘S while the editor is not focused (the tree, the bar): same save. A conflict waits for the banner.
  useEffect(() => {
    if (!path) return;
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // the editor saved already
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        onSaveKey();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [chatId, path, save]);

  // During a conflict a save never goes through on its own: the banner decides, so Save points at it.
  const onSaveKey = () => {
    const d = fileDrafts.get(chatId, path);
    if (d?.conflict) document.querySelector<HTMLButtonElement>('.wb-strip[role=alert] .btn')?.focus();
    else if (d && d.text !== null) save(undefined);
  };

  const st = fileState(file, dirty, saving, image);
  const { dir, name } = splitPath(path);
  const toggle = props.onToggleTree && (
    <button
      type="button"
      className={'sd-btn icon-only' + (props.treeShown ? ' on' : '')}
      title={`${props.treeShown ? 'Hide' : 'Show'} the files (⌘B)`}
      aria-label={`${props.treeShown ? 'Hide' : 'Show'} the files`}
      aria-pressed={props.treeShown}
      onClick={props.onToggleTree}
    >
      <FileIcon.tree />
    </button>
  );
  const bar = !path ? (
    <div className="wb-bar">
      <span className="wb-path wb-ws">
        <bdi>@{agentId}’s workspace</bdi>
      </span>
    </div>
  ) : (
    <div className="wb-bar">
      {toggle}
      <span className="wb-path" title={path}>
        <bdi>
          {dir}
          <b>{name}</b>
        </bdi>
      </span>
      {st.kind === 'saved' && file && <span className="wb-state">Saved</span>}
      {st.kind === 'saving' && <span className="wb-state">Saving…</span>}
      {st.kind === 'unsaved' && (
        <>
          <span className="wb-state warn">Unsaved</span>
          <button type="button" className="btn small primary" title="Save (⌘S)" onClick={onSaveKey}>
            Save
          </button>
        </>
      )}
      {st.kind === 'ro' && <span className="wb-ro">{st.label}</span>}
    </div>
  );

  let banner: ReactNode = null;
  if (conflict?.kind === 'changed')
    banner = (
      <div className="wb-strip warn" role="alert">
        <FileIcon.warn />
        <span className="grow">
          <b>{agentId} changed this file</b> {relAgo(new Date(conflict.at).toISOString())} while you were editing it.
        </span>
        <button type="button" className={'btn small' + (compare ? ' on' : '')} aria-pressed={compare} onClick={() => setCompare(!compare)}>
          {compare ? 'Hide the changes' : 'Compare'}
        </button>
        <button type="button" className="btn small" title={`Save your text over ${agentId}’s`} onClick={() => save(conflict.theirs.hash)}>
          Keep mine
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            const theirs = conflict.theirs;
            fileDrafts.set(chatId, path, {
              file: theirs,
              text: null,
              conflict: null,
            });
            setCompare(false);
            if (theirs.readOnly) setDocKey((k) => k + 1);
            else editor.current?.setText(theirs.content ?? '');
            // setText reports a change: it equals the file, so the draft goes back to saved.
            fileDrafts.update(chatId, path, (d) => ({ ...d, text: null }));
          }}
        >
          Take {agentId}’s
        </button>
      </div>
    );
  else if (conflict?.kind === 'deleted')
    banner = (
      <div className="wb-strip neg" role="alert">
        <FileIcon.warn />
        <span className="grow">
          <b>{agentId} deleted this file</b> {relAgo(new Date(conflict.at).toISOString())}.{dirty ? ' Your edits are still here.' : ''}
        </span>
        <button type="button" className="btn small" onClick={() => save(null, editor.current?.text() ?? draft?.text ?? file?.content ?? '')}>
          Save it again
        </button>
        <button
          type="button"
          className="btn small ghost"
          onClick={() => {
            fileDrafts.drop(chatId, path);
            void api.panelCloseFile(chatId, path).catch(onError);
          }}
        >
          Discard
        </button>
      </div>
    );
  else if (file?.readOnly === 'large')
    banner = (
      <div className="wb-strip">
        <FileIcon.file />
        <span className="grow">
          {st.kind === 'ro' ? st.label.replace('Read only · ', '') : ''} is over the 1 MB editing limit: read only, the first 2,000 lines.
        </span>
      </div>
    );
  else if (file?.readOnly === 'secret')
    banner = (
      <div className="wb-strip">
        <FileIcon.file />
        <span className="grow">This file holds a secret value, shown as [secret NAME]: read only, so a save never writes the mark over the value.</span>
      </div>
    );

  let body: ReactNode;
  if (props.treeOnly) body = null;
  else if (missing)
    body = (
      <div className="wb-empty">
        <FileIcon.file />
        <b>{name} isn’t there</b>
        <p>
          No file {path} in @{agentId}’s workspace. It may have been moved or deleted.
        </p>
      </div>
    );
  else if (!file) body = <FileSkeleton />;
  else if (file.kind === 'binary')
    body = (
      <div className="wb-empty">
        <span className="big">
          <FileIcon.file />
        </span>
        <b>{name} can’t be shown</b>
        <p>A binary file ({binaryWhat(path, file.size)}). Files shows and edits text, and shows images.</p>
      </div>
    );
  else if (file.kind === 'image')
    body = (
      <div className="wb-img">
        <div className="frame">
          <img
            src={api.fileImageUrl(chatId, path, file.stamp)}
            alt={name}
            onLoad={(e) =>
              setImage({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })
            }
          />
        </div>
      </div>
    );
  else
    body = (
      <Suspense fallback={<FileSkeleton />}>
        <CodeEditor
          ref={editor}
          docKey={`${path}:${docKey}`}
          initial={draft?.text ?? file.content ?? ''}
          lang={langOf(path)}
          readOnly={!!file.readOnly}
          line={tab.line}
          lineKey={tab.focusedAt}
          compare={compare && conflict?.kind === 'changed' ? (conflict.theirs.content ?? '') : null}
          onChange={(text) =>
            fileDrafts.update(chatId, path, (d) => {
              const same = text === d.file.content;
              return { ...d, text: same && !d.conflict ? null : text };
            })
          }
          onSave={onSaveKey}
          onLines={props.onLines && ((from, to) => props.onLines?.(path, from, to))}
          comment={props.comment}
        />
      </Suspense>
    );

  return (
    <>
      {bar}
      <div ref={props.boxRef} className="wb-files">
        {props.tree}
        {!props.treeOnly && (
          <div className="wb-ed" style={file?.kind === 'binary' || missing ? { position: 'relative' } : undefined}>
            {banner}
            {body}
          </div>
        )}
      </div>
    </>
  );
}

function FileSkeleton() {
  return (
    <div className="wb-skel" aria-label="Loading the file">
      <i style={{ width: '62%' }} />
      <i style={{ width: '48%' }} />
      <i style={{ width: '70%' }} />
      <i style={{ width: '40%' }} />
    </div>
  );
}

/* ── The tree ─────────────────────────────────────────────────────────── */

/** Open folders per chat, kept while the app runs. */
const openDirs = new Map<string, Set<string>>();

function FileTree(props: {
  chatId: string;
  agentId: string;
  selected: string;
  full: boolean;
  filterRef: React.RefObject<HTMLInputElement | null>;
  onPick(path: string): void;
  onError(e: unknown): void;
}) {
  const { chatId, selected, onError } = props;
  const [lists, setLists] = useState<Map<string, WsListing>>(new Map());
  const [, setTick] = useState(0);
  const dirs = openDirs.get(chatId) ?? new Set<string>();
  if (!openDirs.has(chatId)) openDirs.set(chatId, dirs);
  // The selected file's folders open.
  for (const a of ancestors(selected)) dirs.add(a);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{
    paths: string[];
    truncated: boolean;
  } | null>(null);
  const [cursor, setCursor] = useState(0);

  const load = useCallback(
    (dir: string) =>
      api.filesList(chatId, dir).then(
        (l) => setLists((m) => new Map(m).set(dir, l)),
        (e: unknown) => {
          // A folder that went away (the agent deleted it): closed, not an error.
          if (e instanceof ApiError && e.status === 404) {
            dirs.delete(dir);
            setLists((m) => {
              const n = new Map(m);
              n.delete(dir);
              return n;
            });
          } else onError(e);
        },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatId, onError],
  );
  // The root and every open folder; again every few seconds for the agent's new files and the git letters.
  useEffect(() => {
    const all = () => ['', ...dirs].forEach((d) => void load(d));
    all();
    const t = setInterval(() => !document.hidden && all(), POLL_MS * 2);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, selected]);

  useEffect(() => {
    if (!q.trim()) return setFound(null);
    let live = true;
    const t = setTimeout(() => api.filesFind(chatId, q.trim()).then((r) => live && (setFound(r), setCursor(0)), onError), 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [chatId, q, onError]);

  const toggleDir = (d: string) => {
    if (dirs.has(d)) dirs.delete(d);
    else {
      dirs.add(d);
      void load(d);
    }
    setTick((n) => n + 1);
  };

  const rows = (dir: string): ReactNode => {
    const l = lists.get(dir);
    if (!l) return dir === '' ? <div className="wb-note">Loading…</div> : null;
    if (dir === '' && !l.entries.length) return <div className="wb-note">The workspace is empty.</div>;
    return l.entries.map(row);
  };
  // A plain function, not a component: a component defined here would remount (and lose focus) on every render.
  const row = (e: WsEntry): ReactNode => {
    const on = !e.dir && e.path === selected;
    const open = e.dir && dirs.has(e.path);
    return (
      <Fragment key={e.path}>
        <button
          type="button"
          className={'wb-row' + (on ? ' on' : '')}
          aria-expanded={e.dir ? open : undefined}
          aria-current={on || undefined}
          title={e.path}
          onClick={() => (e.dir ? toggleDir(e.path) : props.onPick(e.path))}
        >
          <span className="ic">{e.dir ? open ? <FileIcon.chevD /> : <FileIcon.chevR /> : <FileKindIcon path={e.path} />}</span>
          <span className="nm">{e.name}</span>
          {e.git && (
            <span className={'g ' + e.git} title={gitTitle(e.git, '@' + props.agentId)}>
              {e.git}
            </span>
          )}
        </button>
        {open && <div className="wb-grp">{rows(e.path)}</div>}
      </Fragment>
    );
  };

  const list = found?.paths ?? [];
  return (
    <div className={'wb-tree' + (props.full ? ' full' : '')} role="navigation" aria-label="Files">
      <label className="wb-filter">
        <FileIcon.search />
        <input
          ref={props.filterRef}
          type="search"
          value={q}
          placeholder="Find a file  ⌘P"
          aria-label="Find a file"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && q) {
              e.preventDefault();
              e.stopPropagation();
              setQ('');
            } else if (e.key === 'ArrowDown' && list.length) {
              e.preventDefault();
              setCursor((c) => Math.min(list.length - 1, c + 1));
            } else if (e.key === 'ArrowUp' && list.length) {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === 'Enter' && list[cursor]) {
              e.preventDefault();
              props.onPick(list[cursor]!);
              setQ('');
            }
          }}
        />
      </label>
      <div className="wb-rows">
        {found ? (
          <>
            {!list.length && <div className="wb-note">No file matches.</div>}
            {list.map((p, i) => {
              const { dir, name } = splitPath(p);
              return (
                <button
                  key={p}
                  type="button"
                  className={'wb-row wb-hit' + (i === cursor ? ' on' : '')}
                  title={p}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => {
                    props.onPick(p);
                    setQ('');
                  }}
                >
                  <span className="ic">
                    <FileKindIcon path={p} />
                  </span>
                  <span className="nm">
                    {name} <span className="dir">{dir}</span>
                  </span>
                </button>
              );
            })}
            {found.truncated && <div className="wb-note">More files match: type more of the name.</div>}
          </>
        ) : (
          rows('')
        )}
      </div>
    </div>
  );
}

/** Close a file tab: unsaved edits ask first. */
export function closeFileTab(chatId: string, path: string, onError: (e: unknown) => void) {
  if (fileDrafts.dirty(chatId, path) && !confirm(`${splitPath(path).name} has unsaved changes. Close it and lose them?`)) return;
  fileDrafts.drop(chatId, path);
  void api.panelCloseFile(chatId, path).catch(onError);
}

export type { Draft };
export type { WsFile };
