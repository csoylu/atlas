import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { changedSections, linkOf, splitSections, USER, type Doc, type DocContent, type DocSection, type DocVersion } from '@atlas/shared';
import { api, ApiError } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { diagramWidth } from './docPanel.ts';
import { Icon } from './ScreenHeader.tsx';
import { PopButton, PopItem } from './HeadMenu.tsx';
import { relAgo } from './library.ts';
import { fileUrl, folderName, isImageUrl, sandboxFor, SANDBOX, useFolders, versionLabel } from './artifacts.ts';

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
 * browser (links), Ask about this, then the caller's items (Open in the Library; Pin and Move to in the Library).
 */
export function ArtifactViewer(props: {
  doc: Doc;
  mode: ViewerMode;
  /** The tabs in the head; without them the head shows the artifact's title. */
  tabs?: ViewerTab[];
  onTab?(doc: Doc): void;
  /** Left of the tabs (« ‹ Back », « ‹ Library »). */
  lead?: ReactNode;
  /** Between the version controls and ⋯ (Full size, Pin). */
  tools?: ReactNode;
  /** Right of ⋯ (close). */
  end?: ReactNode;
  /** The ⋯ menu's first line: « Opened by @x » (chat); default « By @author ». */
  by?: string;
  /** The ⋯ menu's last items. */
  menu?(close: () => void): ReactNode;
  /** A version to show (a chat card opens its own); a new key shows it again. */
  want?: { version: number; key: string } | null;
  /** Markdown section (or html element id) to scroll to; a new scrollKey scrolls again. */
  section?: string | null;
  scrollKey?: string;
  /** Sections changed since this version get a « changed » mark. */
  seenVersion?: number;
  stream: MessageStream;
  onAsk?(section: DocSection | null, version: number): void;
  onSeen?(): void;
  onError(e: unknown): void;
}) {
  const { doc, onError } = props;
  const [version, setVersion] = useState<number | null>(null);
  const [src, setSrc] = useState(false);
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
  const old = version !== null && version < doc.version;
  const restore = (v: number) => api.restoreDoc(doc.id, v).then(() => setVersion(null), onError);
  const isLink = doc.kind === 'url';

  return (
    <div className={'viewer ' + props.mode}>
      <div className="sd-head">
        {props.lead}
        {props.tabs ? (
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
            {props.mode === 'library' && <span className="sd-path">{doc.path}</span>}
          </div>
        )}
        <PopButton
          className={'sd-ver-btn' + (old ? ' old' : '')}
          title={old ? `Showing v${shown}; the latest is v${doc.version}` : `Versions (v${doc.version}, ${relAgo(doc.updatedAt)})`}
          ariaLabel={`Version ${versionLabel(shown, doc.version)}: versions`}
          label={
            <>
              {versionLabel(shown, doc.version)}
              <Icon.chevDown />
            </>
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
              {props.onAsk && doc.kind !== 'markdown' && (
                <PopItem
                  icon={<Icon.ask />}
                  onClick={() => {
                    props.onAsk!(null, shown);
                    close();
                  }}
                >
                  Ask about this
                </PopItem>
              )}
              {props.menu?.(close)}
            </>
          )}
        </PopButton>
        {props.end}
      </div>
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
          onAsk={props.onAsk}
          onSeen={props.onSeen}
          onError={onError}
        />
      )}
    </div>
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
 * Preview: the artifact rendered by kind. Markdown at a readable width, sections with « Ask about this » and
 * « changed » marks; an html page at real size, sandboxed; an svg diagram fit to the width (text kept readable); a
 * link as the running app (an image link fit to the box).
 */
function DocBody(props: {
  doc: Doc;
  /** null: the latest version, live. */
  version: number | null;
  section?: string | null;
  scrollKey?: string;
  seenVersion?: number;
  onAsk?(section: DocSection | null, version: number): void;
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
    document.getElementById(secId(doc.id, props.section))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [data, props.section, props.scrollKey, doc.id, doc.kind]);

  if (!data) return <div className="sd-body loading" />;
  const shown = data.version;
  return (
    <div className={'sd-body ' + doc.kind}>
      {doc.kind === 'markdown' ? (
        <article className="doc-md md">
          {sections.map((s) => (
            <section key={s.id || '_intro'} id={secId(doc.id, s.id)} className={'doc-sec' + (changed.has(s.id) ? ' changed' : '')}>
              <div className="doc-sec-tools">
                {changed.has(s.id) && (
                  <button className="doc-chg" title="Mark as seen" onClick={props.onSeen}>
                    changed
                  </button>
                )}
                {props.onAsk && (
                  <button className="doc-ask" onClick={() => props.onAsk!(s, shown)}>
                    Ask about this
                  </button>
                )}
              </div>
              <MarkdownText text={s.text} />
            </section>
          ))}
          {!sections.length && <p className="muted">This document is empty.</p>}
        </article>
      ) : doc.kind === 'html' ? (
        version === null ? (
          <iframe
            key={doc.version + ':' + (props.scrollKey ?? '')}
            className="doc-frame"
            title={doc.title}
            sandbox={SANDBOX}
            src={fileUrl(doc) + (props.section ? '#' + encodeURIComponent(props.section) : '')}
          />
        ) : (
          <iframe className="doc-frame" title={doc.title} sandbox={SANDBOX} srcDoc={data.content} />
        )
      ) : doc.kind === 'diagram' ? (
        <Diagram svg={data.content} title={doc.title} />
      ) : (
        <LinkView url={linkOf(data.content)} title={doc.title} />
      )}
    </div>
  );
}

const MarkdownText = ({ text }: { text: string }) => (
  <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _n, ...a }) => <a {...a} target="_blank" rel="noreferrer" /> }}>
    {text}
  </Markdown>
);

/** A link: the running app or page in a frame, an image fit to the box. */
function LinkView({ url, title, preview }: { url: string; title: string; preview?: boolean }) {
  if (!url) return <p className="muted doc-empty">This link has no address.</p>;
  if (isImageUrl(url)) return <img className={preview ? 'lib-pv-img' : 'doc-link-img'} src={url} alt={preview ? '' : title} />;
  return <iframe className={preview ? undefined : 'doc-frame'} title={title} sandbox={sandboxFor(url)} src={url} tabIndex={preview ? -1 : undefined} aria-hidden={preview || undefined} loading="lazy" />;
}

const secId = (docId: string, section: string) => `docsec-${docId}-${section}`;

/** An svg as an image (no scripts), fit to the width unless its text would get too small to read. */
function Diagram({ svg, title }: { svg: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const url = useMemo(() => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), [svg]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth - 32));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="doc-diagram" ref={box}>
      {w > 0 && <img src={url} alt={title} style={{ width: diagramWidth(svg, w) }} />}
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
