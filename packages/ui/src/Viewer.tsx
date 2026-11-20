import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { changedSections, findSection, linkOf, splitSections, USER, withPaneHelper, type Doc, type DocContent, type DocSection, type DocVersion } from '@atlas/shared';
import { api, ApiError } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { diagramWidth } from './docPanel.ts';
import { HeaderActions, Icon } from './ScreenHeader.tsx';
import { AgentFace } from './AgentFace.tsx';
import { PopButton, PopItem } from './HeadMenu.tsx';
import { relAgo } from './library.ts';
import { fileUrl, folderName, isImageUrl, sandboxFor, SANDBOX, useFolders, versionLabel } from './artifacts.ts';
import { Marks, markdownMarks, markdownPick, PickOverlay, pictureMarks, picturePick, SvgHitLayer, useFrameComments, useSizeTick, type PaneComment, type PictureSpace, type SvgHits } from './CommentLayer.tsx';
import { boxOf, containRect, svgSpace, type Box } from './comments.ts';

/** Where the viewer is: the chat's side panel, the Library, or inside a card / inbox item. */
export type ViewerMode = 'panel' | 'library' | 'inline';

export interface ViewerTab {
  doc: Doc;
  /** « changed since you looked ». */
  dot?: boolean;
  onClose?(): void;
}

/** An artifact kind's line icon (tabs, chat cards, Library rows and tiles). */
export function KindIcon({ kind }: { kind: Doc['kind'] }) {
  const d =
    kind === 'url' ? (
      <><path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.7.7" /><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.5 8.8a2.6 2.6 0 0 0 3.7 3.7l.7-.7" /></>
    ) : kind === 'html' ? (
      <><rect x="2" y="3" width="12" height="10" rx="1.2" /><path d="M2 6h12M6.5 8.5 5 10l1.5 1.5M9.5 8.5 11 10l-1.5 1.5" /></>
    ) : kind === 'diagram' ? (
      <><rect x="2" y="2.5" width="4.5" height="3.5" rx=".8" /><rect x="9.5" y="10" width="4.5" height="3.5" rx=".8" /><path d="M4.25 6v4.5a1 1 0 0 0 1 1H9.5" /></>
    ) : (
      <><path d="M3.5 2.5h6l3 3v8h-9z" /><path d="M9.5 2.5v3h3M5.5 8.5h5M5.5 11h3.5" /></>
    );
  return (
    <svg className="icon kind-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d}
    </svg>
  );
}

const who = (id: string) => (id === USER ? 'you' : '@' + id);

/**
 * The one artifact viewer (#120, mockup #106 v2), shared by the chat's side panel, the Library and the card modal /
 * inbox. ONE head row in every state: tabs (or the title), the version picker (« vN », « vN of M » in warn colours on
 * an old version), « Latest » on an old version, « Source × » while the source shows, the caller's tools (Full
 * size, Pin), ⋯, and the caller's end (×). The ⋯ menu has who / folder / path, Show source (or address), Open in the
 * browser (links), then the caller's items (Open in the Library; Pin and Move to in the Library).
 */
export function ArtifactViewer(props: {
  doc: Doc;
  mode: ViewerMode;
  /** The tabs in the head; without them the head shows the artifact's title. */
  tabs?: ViewerTab[];
  onTab?(doc: Doc): void;
  /** Left of the tabs (« ‹ Back », « ‹ Library »). */
  lead?: ReactNode;
  /** The workbench's own tab strip (#302: tabs of every kind, +, or the phone's tab picker), in place of `tabs`. */
  strip?: ReactNode;
  /** The second row, under the head: the bar of the open tab's kind (#302); artifacts have none. */
  bar?: ReactNode;
  /** Between the version controls and ⋯ (Full size, Pin). */
  tools?: ReactNode;
  /** Right of ⋯ (close). */
  end?: ReactNode;
  /** The ⋯ menu's first line: « Opened by @x » (chat); default « By @author ». */
  by?: string;
  /** The ⋯ menu's last items (before « Delete… », which every viewer has). */
  menu?(close: () => void): ReactNode;
  /** After « Delete… » went through (#242): leave the viewer (the Library goes back to its list). */
  onDeleted?(): void;
  /** A version to show (a chat card opens its own); a new key shows it again. */
  want?: { version: number; key: string } | null;
  /** Markdown section (or html element id) to scroll to; a new scrollKey scrolls again. */
  section?: string | null;
  scrollKey?: string;
  /** Sections changed since this version get a « changed » mark. */
  seenVersion?: number;
  stream: MessageStream;
  /** Comment mode (#304): the pane's marks and picks; none in the Library. */
  comment?: PaneComment;
  onSeen?(): void;
  /** The version on screen, each time it changes (« what the agent sees », #305). */
  onShown?(version: number): void;
  onError(e: unknown): void;
}) {
  const { doc, onError } = props;
  const [version, setVersion] = useState<number | null>(null);
  const [src, setSrc] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const folders = useFolders(props.stream, onError);
  useEffect(() => {
    setVersion(null);
    setSrc(false);
  }, [doc.id]);
  // A chat card asks for its version: the latest one is shown live (null), an older one fixed.
  const wantKey = props.want ? `${props.want.key}:${props.want.version}` : null;
  useEffect(() => {
    if (props.want) setVersion(props.want.version < doc.version ? props.want.version : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantKey]);

  const shown = version ?? doc.version;
  const onShown = props.onShown;
  useEffect(() => onShown?.(shown), [onShown, shown]);
  const old = version !== null && version < doc.version;
  const restore = (v: number) => api.restoreDoc(doc.id, v).then(() => setVersion(null), onError);
  const isLink = doc.kind === 'url';
  const lib = props.mode === 'library';

  /** The version picker, Latest, Source, the caller's tools, ⋯ and its end: in the head row, or in the Library's screen header. */
  const controls = (
    <>
      <PopButton
        className={'sd-ver-btn' + (old ? ' old' : '') + (lib ? ' sd-ver-lib' : '')}
        title={old ? `Showing v${shown}; the latest is v${doc.version}` : `Versions (v${doc.version}, ${relAgo(doc.updatedAt)})`}
        ariaLabel={`Version ${versionLabel(shown, doc.version)}: versions`}
        label={
          lib ? (
            <>
              <AgentFace id={doc.updatedBy || doc.agentId} />
              <span>{versionLabel(shown, doc.version)}</span>
              {!old && <span className="sd-ver-ago">· {relAgo(doc.updatedAt)}</span>}
              <Icon.chevDown />
            </>
          ) : (
            <>
              {versionLabel(shown, doc.version)}
              <Icon.chevDown />
            </>
          )
        }
      >
        {(close) => (
          <VersionMenu
            doc={doc}
            shown={shown}
            onView={(v) => {
              setVersion(v === doc.version ? null : v);
              close();
            }}
            onRestore={(v) => {
              close();
              void restore(v);
            }}
            onError={onError}
          />
        )}
      </PopButton>
      {old && (
        <button type="button" className="sd-btn sd-latest-btn" title="Back to the latest version" onClick={() => setVersion(null)}>
          Latest
        </button>
      )}
      {src && (
        <button type="button" className="sd-btn sd-src-on" title="Back to the preview" onClick={() => setSrc(false)}>
          {isLink ? 'Address' : 'Source'} ×
        </button>
      )}
      {props.tools}
      <PopButton className="sd-btn icon-only" title="More" ariaLabel="More" label={<Icon.dots />}>
        {(close) => (
          <>
            <div className="pop-info">
              <span>{props.by ?? `By ${who(doc.agentId)}`}</span>
              <span>
                <Icon.folder />
                {folderName(folders, doc.folderId)}
              </span>
              <span className="pop-path">{doc.path}</span>
            </div>
            <div className="pop-sep" />
            <PopItem
              icon={<Icon.code />}
              onClick={() => {
                setSrc(!src);
                close();
              }}
            >
              {src ? 'Show the preview' : isLink ? 'Show the address' : 'Show the source'}
            </PopItem>
            {isLink && <OpenInBrowser doc={doc} version={version} onDone={close} onError={onError} />}
            {props.menu?.(close)}
            <div className="pop-sep" />
            <PopItem
              danger
              icon={<Icon.trash />}
              onClick={() => {
                close();
                setDeleting(true);
              }}
            >
              Delete…
            </PopItem>
          </>
        )}
      </PopButton>
      {props.end}
    </>
  );
  return (
    <div className={'viewer ' + props.mode}>
      {lib ? (
        // The Library (redesign #270): one screen header (breadcrumb, title, project tag in App), these on its right.
        <HeaderActions>{controls}</HeaderActions>
      ) : (
        <div className="sd-head">
          {props.lead}
          {props.strip ? (
            props.strip
          ) : props.tabs ? (
            <div className="sd-tabs" role="tablist" aria-label="Artifacts">
              {props.tabs.map((t) => (
                <div key={t.doc.id} className={'sd-tab' + (t.doc.id === doc.id ? ' on' : '')}>
                  <button role="tab" aria-selected={t.doc.id === doc.id} title={t.doc.path} onClick={() => t.doc.id !== doc.id && props.onTab?.(t.doc)}>
                    <KindIcon kind={t.doc.kind} />
                    <span className="sd-tab-t">{t.doc.title}</span>
                    {t.dot && <span className="sd-dot" title="Changed since you looked" />}
                  </button>
                  {t.onClose && (
                    <button className="sd-tab-x" aria-label={`Close ${t.doc.title}`} onClick={t.onClose}>
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="sd-title">
              <KindIcon kind={doc.kind} />
              <b>{doc.title}</b>
            </div>
          )}
          {controls}
        </div>
      )}
      {props.bar}
      {deleting && <DeleteArtifactDialog doc={doc} onCancel={() => setDeleting(false)} onDeleted={() => props.onDeleted?.()} onError={onError} />}
      {src ? (
        <Source key={doc.id} doc={doc} version={version} onError={onError} />
      ) : (
        <DocBody
          key={doc.id}
          doc={doc}
          version={version}
          section={props.section}
          scrollKey={props.scrollKey}
          seenVersion={props.seenVersion}
          path={lib}
          comment={props.comment}
          onSeen={props.onSeen}
          onError={onError}
        />
      )}
    </div>
  );
}

/**
 * « Delete «title»? » (#242): the artifact, every version and its file go for good. The number of versions is read
 * first (the last 50 are kept, so it can be fewer than the version number). Esc or a click outside cancels.
 */
export function DeleteArtifactDialog(props: { doc: Doc; onCancel(): void; onDeleted(): void; onError(e: unknown): void }) {
  const { doc, onCancel, onError } = props;
  const [n, setN] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.docVersions(doc.id).then((v) => live && setN(v.length), onError);
    return () => {
      live = false;
    };
  }, [doc.id, onError]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onCancel]);
  const del = () => {
    setBusy(true);
    api.deleteDoc(doc.id).then(
      () => {
        onCancel();
        props.onDeleted();
      },
      (e) => {
        setBusy(false);
        onError(e);
      },
    );
  };
  return createPortal(
    <div className="modal-scrim del-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="del-art-title" aria-describedby="del-art-text">
        <h2 id="del-art-title">Delete «{doc.title}»?</h2>
        <p id="del-art-text">
          {n === null ? 'All its versions are removed.' : n === 1 ? 'Its only version is removed.' : `All ${n} versions are removed.`} This can't be undone.
        </p>
        <p className="del-fine">
          Its file <code>{doc.path}</code> in {who(doc.agentId)}'s workspace is deleted too. Its cards in chats will read “Deleted artifact”.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary danger" autoFocus disabled={busy} onClick={del}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The version picker's menu: every kept version with its author and time; « Restore vN as vM+1 » on an old one. */
function VersionMenu(props: { doc: Doc; shown: number; onView(v: number): void; onRestore(v: number): void; onError(e: unknown): void }) {
  const { doc, onError } = props;
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  useEffect(() => {
    api.docVersions(doc.id).then(setVersions, onError);
  }, [doc.id, doc.version, onError]);
  return (
    <>
      <div className="pop-k">Versions</div>
      {!versions && <p className="pop-note">Loading…</p>}
      {versions?.map((v) => (
        <button key={v.version} type="button" role="menuitemradio" aria-checked={v.version === props.shown} className="pop-row" onClick={() => props.onView(v.version)}>
          <span className="pop-v">v{v.version}</span>
          <span className="pop-t">{who(v.updatedBy)}</span>
          <span className="pop-sub" title={new Date(v.updatedAt).toLocaleString()}>
            {v.version === doc.version ? 'latest · ' : ''}
            {relAgo(v.updatedAt)}
          </span>
          <span className="pop-check" style={v.version === props.shown ? undefined : { visibility: 'hidden' }}>
            <Icon.check />
          </span>
        </button>
      ))}
      {props.shown < doc.version && (
        <>
          <div className="pop-sep" />
          <PopItem icon={<Icon.restore />} onClick={() => props.onRestore(props.shown)}>
            Restore v{props.shown} as v{doc.version + 1}
          </PopItem>
        </>
      )}
      <p className="pop-note">The last 50 versions are kept. Restoring adds a new version: nothing is lost.</p>
    </>
  );
}

/** « Open in the browser » for a link: its address at the version shown. */
function OpenInBrowser({ doc, version, onDone, onError }: { doc: Doc; version: number | null; onDone(): void; onError(e: unknown): void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    api.document(doc.id, version ?? undefined).then((d) => setUrl(linkOf(d.content)), onError);
  }, [doc.id, doc.version, version, onError]);
  return (
    <a className="pop-row" role="menuitem" href={url ?? undefined} target="_blank" rel="noreferrer" onClick={onDone} aria-disabled={!url}>
      <Icon.ext />
      <span className="pop-t">Open in the browser</span>
    </a>
  );
}

/** Source: the file's text at the version shown (a link: its address). */
function Source({ doc, version, onError }: { doc: Doc; version: number | null; onError(e: unknown): void }) {
  const [text, setText] = useState<string | null>(null);
  const latestKey = version === null ? doc.version : -1;
  useEffect(() => {
    let live = true;
    api.document(doc.id, version ?? undefined).then((d) => live && setText(d.content), onError);
    return () => {
      live = false;
    };
  }, [doc.id, version, latestKey, onError]);
  if (text === null) return <div className="sd-body loading" />;
  return (
    <div className="sd-body sd-src">
      <pre>{text}</pre>
    </div>
  );
}

/**
 * Preview: the artifact rendered by kind. Markdown at a readable width, sections with « changed » marks; an html page at real size, sandboxed; an svg diagram fit to the width (text kept readable); a
 * link as the running app (an image link fit to the box).
 */
function DocBody(props: {
  doc: Doc;
  /** null: the latest version, live. */
  version: number | null;
  section?: string | null;
  scrollKey?: string;
  seenVersion?: number;
  /** The file path as a quiet line on top of a document (the Library). */
  path?: boolean;
  comment?: PaneComment;
  onSeen?(): void;
  onError(e: unknown): void;
}) {
  const { doc, version, onError } = props;
  const [data, setData] = useState<DocContent | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const scrolled = useRef<string | null>(null);

  // The latest version follows the artifact (doc.version changes on every edit); an old one is fixed.
  const latestKey = version === null ? doc.version : -1;
  useEffect(() => {
    let live = true;
    api.document(doc.id, version ?? undefined).then((d) => live && setData(d), onError);
    return () => {
      live = false;
    };
  }, [doc.id, version, latestKey, onError]);

  const seen = props.seenVersion;
  useEffect(() => {
    setBase(null);
    if (doc.kind !== 'markdown' || version !== null || seen === undefined || !data || seen >= data.version) return;
    let live = true;
    api.document(doc.id, seen).then(
      (d) => live && setBase(d.content),
      // The version seen is older than the 50 kept: no section marks, the tab still shows a dot.
      (e) => (e instanceof ApiError && e.status === 404 ? undefined : onError(e)),
    );
    return () => {
      live = false;
    };
  }, [doc.id, doc.kind, version, seen, data, onError]);

  const sections = useMemo(() => (data && doc.kind === 'markdown' ? splitSections(data.content) : []), [data, doc.kind]);
  const changed = useMemo(() => (base !== null && data ? changedSections(base, data.content) : new Set<string>()), [base, data]);

  // Scroll to the section an agent asked for, once per open/focus.
  useEffect(() => {
    if (!data || !props.section || !props.scrollKey || scrolled.current === props.scrollKey) return;
    scrolled.current = props.scrollKey;
    if (doc.kind !== 'markdown') return; // html: the fragment in the iframe's URL does it
    // An id or a heading's text (a chip keeps what the agent wrote, e.g. « 7. Open questions »).
    const id = findSection(sections, props.section)?.id ?? props.section;
    document.getElementById(secId(doc.id, id))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [data, sections, props.section, props.scrollKey, doc.id, doc.kind]);

  if (!data) return <div className="sd-body loading" />;
  const shown = data.version;
  const cm = props.comment;
  return (
    <div className={'sd-body ' + doc.kind + (cm?.on ? ' commenting' : '')}>
      {doc.kind === 'markdown' ? (
        <MarkdownDoc doc={doc} sections={sections} changed={changed} path={props.path} version={shown} comment={cm} onSeen={props.onSeen} />
      ) : doc.kind === 'html' ? (
        <PageFrame
          key={(version === null ? doc.version + ':' + (props.scrollKey ?? '') : 'v' + version) + (cm ? ':pane' : '')}
          title={doc.title}
          src={version === null ? fileUrl(doc) + (cm ? '?pane=1' : '') + (props.section ? '#' + encodeURIComponent(props.section) : '') : undefined}
          srcDoc={version === null ? undefined : cm ? withPaneHelper(data.content) : data.content}
          version={shown}
          comment={cm}
        />
      ) : doc.kind === 'diagram' ? (
        <Diagram svg={data.content} title={doc.title} version={shown} comment={cm} />
      ) : (
        <LinkView url={linkOf(data.content)} title={doc.title} version={shown} comment={cm} />
      )}
    </div>
  );
}

/**
 * Markdown, by section; each block carries its source lines (data-l1/l2, lines of the whole file) so a comment says
 * exactly where. In comment mode a selection or a click on a block opens the comment box (#304).
 */
function MarkdownDoc(props: { doc: Doc; sections: DocSection[]; changed: Set<string>; path?: boolean; version: number; comment?: PaneComment; onSeen?(): void }) {
  const { doc, comment: cm } = props;
  const art = useRef<HTMLElement>(null);
  const tick = useSizeTick(art, !!cm?.marks.length);
  const marks = useMemo(() => (art.current && cm?.marks.length ? markdownMarks(art.current, cm.marks) : []), [cm?.marks, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const sectionOf = useCallback((el: Element) => (el.closest('[data-sec]') as HTMLElement | null)?.dataset.sec ?? null, []);
  return (
    <article
      ref={art}
      className="doc-md md"
      onClickCapture={(e) => {
        if (!cm?.on) return;
        if ((e.target as Element).closest('a')) e.preventDefault(); // a link is commented on, not followed
      }}
      onMouseUp={(e) => {
        if (!cm?.on || e.button !== 0 || !art.current) return;
        const p = markdownPick(art.current, e.target, sectionOf);
        if (p) cm.onPick(p, props.version);
      }}
    >
      {props.path && <p className="doc-path">{doc.path}</p>}
      {props.sections.map((s) => (
        <section key={s.id || '_intro'} id={secId(doc.id, s.id)} data-sec={s.id} className={'doc-sec' + (props.changed.has(s.id) ? ' changed' : '')}>
          {props.changed.has(s.id) && (
            <div className="doc-sec-tools">
              <button className="doc-chg" title="Mark as seen" onClick={props.onSeen}>
                changed
              </button>
            </div>
          )}
          <MarkdownText text={s.text} line={s.line} />
        </section>
      ))}
      {!props.sections.length && <p className="muted">This document is empty.</p>}
      {marks.length > 0 && <Marks items={marks} />}
    </article>
  );
}

/** An html page, sandboxed; in the pane its helper (added by the engine, ?pane=1) answers comment mode. */
function PageFrame(props: { title: string; src?: string; srcDoc?: string; version: number; comment?: PaneComment }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useFrameComments(frame, props.comment, props.version);
  return <iframe ref={frame} className="doc-frame" title={props.title} sandbox={SANDBOX} src={props.src} srcDoc={props.srcDoc} />;
}

const LINE_TAGS = ['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'tr'] as const;
type MdNode = { position?: { start: { line: number }; end: { line: number } } };
/** react-markdown components that put each block's lines of the file on it (`line`: the text's first line in the file). */
function lineComponents(line: number) {
  const out: Record<string, (p: Record<string, unknown> & { node?: MdNode }) => ReactNode> = {};
  for (const T of LINE_TAGS)
    out[T] = ({ node, ...rest }) => {
      const pos = node?.position;
      const Tag = T as 'p';
      return <Tag {...(rest as object)} data-l1={pos ? pos.start.line + line - 1 : undefined} data-l2={pos ? pos.end.line + line - 1 : undefined} />;
    };
  return out;
}
const MarkdownText = ({ text, line }: { text: string; line?: number }) => {
  const lined = useMemo(() => (line ? lineComponents(line) : {}), [line]);
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{ ...lined, a: ({ node: _n, ...a }) => <a {...a} target="_blank" rel="noreferrer" /> }}>
      {text}
    </Markdown>
  );
};

/** A link: the running app or page in a frame, an image fit to the box. */
function LinkView({ url, title, preview, version, comment }: { url: string; title: string; preview?: boolean; version?: number; comment?: PaneComment }) {
  if (!url) return <p className="state-empty inline doc-empty">This link has no address.</p>;
  if (comment && !preview) return isImageUrl(url) ? <CommentImage url={url} title={title} version={version ?? 0} comment={comment} /> : <CommentLink url={url} title={title} version={version ?? 0} comment={comment} />;
  if (isImageUrl(url)) return <img className={preview ? 'lib-pv-img' : 'doc-link-img'} src={url} alt={preview ? '' : title} />;
  return <iframe className={preview ? undefined : 'doc-frame'} title={title} sandbox={sandboxFor(url)} src={url} tabIndex={preview ? -1 : undefined} aria-hidden={preview || undefined} loading="lazy" />;
}

/** An image link in the pane: a spot or an area in the image's own pixels (#304). */
function CommentImage({ url, title, version, comment: cm }: { url: string; title: string; version: number; comment: PaneComment }) {
  const img = useRef<HTMLImageElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const tick = useSizeTick(img, true);
  const space = (): PictureSpace | null => {
    const el = img.current;
    if (!el || !nat) return null;
    return { shown: containRect(boxOf(el.getBoundingClientRect()), nat), of: nat, origin: { x: 0, y: 0 }, unit: 'px' };
  };
  const s = space();
  void tick;
  return (
    <div className="cm-pic">
      <img ref={img} className="doc-link-img" src={url} alt={title} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })} />
      {s && img.current && <Marks items={pictureMarks(cm.marks, s, boxOf(img.current.getBoundingClientRect()))} />}
      {cm.on && (
        <PickOverlay
          label="Click a spot or drag an area of the image"
          onPick={(b, click) => {
            const sp = space();
            const p = sp && picturePick(b, click, sp, img.current);
            if (p) cm.onPick(p, version);
          }}
        />
      )}
    </div>
  );
}

/** A link's page (another site: nothing can be read inside it): a spot or an area of the frame as shown (#304). */
function CommentLink({ url, title, version, comment: cm }: { url: string; title: string; version: number; comment: PaneComment }) {
  const box = useRef<HTMLDivElement>(null);
  const tick = useSizeTick(box, true);
  void tick;
  const space = (): PictureSpace | null => {
    const el = box.current;
    if (!el) return null;
    const r = boxOf(el.getBoundingClientRect());
    return { shown: r, of: { w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) }, origin: { x: 0, y: 0 }, unit: 'px' };
  };
  const s = space();
  return (
    <div ref={box} className="cm-pic cm-pic-frame">
      <iframe className="doc-frame" title={title} sandbox={sandboxFor(url)} src={url} loading="lazy" />
      {s && <Marks items={pictureMarks(cm.marks, s, s.shown)} />}
      {cm.on && (
        <PickOverlay
          label="Click a spot or drag an area of the page"
          onPick={(b, click) => {
            const sp = space();
            const p = sp && picturePick(b, click, sp, null);
            if (p) cm.onPick(p, version);
          }}
        />
      )}
    </div>
  );
}


const secId = (docId: string, section: string) => `docsec-${docId}-${section}`;

/**
 * An svg as an image (no scripts), fit to the width unless its text would get too small to read. In comment mode a
 * click names the shape under it, a drag the shapes inside the area, in the svg's own units (#304).
 */
function Diagram({ svg, title, version, comment: cm }: { svg: string; title: string; version?: number; comment?: PaneComment }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [w, setW] = useState(0);
  const [hits, setHits] = useState<SvgHits | null>(null);
  const url = useMemo(() => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), [svg]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth - 32));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [loaded, setLoaded] = useState(false);
  const space = (): PictureSpace | null => {
    const el = img.current;
    if (!el || !loaded) return null;
    const sp = svgSpace(svg) ?? { of: { w: el.naturalWidth || 1, h: el.naturalHeight || 1 }, origin: { x: 0, y: 0 } };
    return { shown: containRect(boxOf(el.getBoundingClientRect()), sp.of), of: sp.of, origin: sp.origin, unit: 'svg' };
  };
  const s = cm ? space() : null;
  const el: Box | null = img.current ? boxOf(img.current.getBoundingClientRect()) : null;
  const onHits = useCallback((h: SvgHits | null) => setHits(h), []);
  return (
    <div className="doc-diagram" ref={box}>
      {w > 0 && (
        <div className="cm-pic">
          <img ref={img} src={url} alt={title} style={{ width: diagramWidth(svg, w) }} onLoad={() => setLoaded(true)} />
          {cm?.on && <SvgHitLayer svg={svg} onReady={onHits} />}
          {s && el && <Marks items={pictureMarks(cm!.marks, s, el)} />}
          {cm?.on && (
            <PickOverlay
              label="Click a shape or drag an area of the diagram"
              onPick={(b, click) => {
                const sp = space();
                const p = sp && picturePick(b, click, sp, img.current, hits);
                if (p) cm.onPick(p, version ?? 0);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A Library tile's preview (#120): the real content, rendered live and scaled down to the tile (a page or link at
 * 720 px wide, a document at 620 px), so artifacts are found by sight. Not interactive.
 */
export function ArtifactPreview({ doc, onError }: { doc: Doc; onError(e: unknown): void }) {
  const box = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<{ k: number; h: number } | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const base = doc.kind === 'markdown' ? 620 : 720;
  useEffect(() => {
    if (doc.kind !== 'markdown' && doc.kind !== 'url') return;
    let live = true;
    api.document(doc.id).then((d) => live && setContent(d.content), onError);
    return () => {
      live = false;
    };
  }, [doc.id, doc.kind, doc.version, onError]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => el.clientWidth && setFit({ k: el.clientWidth / base, h: Math.ceil(el.clientHeight / (el.clientWidth / base)) });
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, [base]);
  // The inner box at its real width, scaled to the tile (style values are layout, not type).
  const scaled = fit ? { width: base, height: fit.h, transform: `scale(${fit.k})` } : { visibility: 'hidden' as const };
  const link = doc.kind === 'url' && content !== null ? linkOf(content) : null;
  return (
    <span ref={box} className={'lib-pv ' + doc.kind} aria-hidden="true">
      {doc.kind === 'markdown' ? (
        content !== null && (
          <div className="lib-pv-doc" style={scaled}>
            <article className="doc-md md">
              <MarkdownText text={content} />
            </article>
          </div>
        )
      ) : doc.kind === 'diagram' ? (
        <img className="lib-pv-img" src={fileUrl(doc) + `?v=${doc.version}`} alt="" />
      ) : doc.kind === 'html' ? (
        <iframe key={doc.version} tabIndex={-1} title="" sandbox={SANDBOX} src={fileUrl(doc)} style={scaled} loading="lazy" />
      ) : link && isImageUrl(link) ? (
        <img className="lib-pv-img" src={link} alt="" />
      ) : (
        link && <iframe tabIndex={-1} title="" sandbox={sandboxFor(link)} src={link} style={scaled} loading="lazy" />
      )}
    </span>
  );
}
