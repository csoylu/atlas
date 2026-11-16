import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { changedSections, splitSections, type Canvas, type Doc, type DocContent, type DocSection, type DocVersion } from '@atlas/shared';
import { api, ApiError } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { InlineCanvas } from './canvas/InlineCanvas.tsx';
import { SANDBOX } from './canvas/renderers/html.tsx';
import { diagramWidth } from './docPanel.ts';
import { Icon } from './ScreenHeader.tsx';
import { relAgo } from './library.ts';

const CanvasBoard = lazy(() => import('./canvas/CanvasBoard.tsx').then((m) => ({ default: m.CanvasBoard })));

/** Where the viewer is: the chat's side panel, the Library (whiteboards edit in place), or inside a card / inbox item. */
export type ViewerMode = 'panel' | 'library' | 'inline';
type Pane = 'preview' | 'source' | 'history';

export interface ViewerTab {
  doc: Doc;
  /** « changed since you looked ». */
  dot?: boolean;
  onClose?(): void;
}

/** A document kind's line icon (tabs, Library rows). */
export function KindIcon({ kind }: { kind: Doc['kind'] }) {
  const d =
    kind === 'whiteboard' ? (
      <><rect x="2" y="2.5" width="12" height="9" rx="1" /><path d="M5 14l3-2.5 3 2.5M5 6.5h3M5 8.5h6" /></>
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

/**
 * The one artifact viewer (design §16 « Library », « Chat »), shared by the chat's side panel, the Library and the
 * card modal / inbox: a head with the documents' tabs and actions, then Preview / Source / History. History lists the
 * versions: view an old one (Preview shows it, with « Restore »), or restore it straight away.
 */
export function ArtifactViewer(props: {
  doc: Doc;
  mode: ViewerMode;
  /** The tabs in the head; without them the head shows the document's title. */
  tabs?: ViewerTab[];
  onTab?(doc: Doc): void;
  /** Left of the tabs (« ‹ Library »). */
  lead?: ReactNode;
  /** Right of the head (open in Library, close…). */
  actions?: ReactNode;
  /** A line under Preview / Source / History (who opened it, Ask about this…). */
  meta?: ReactNode;
  /** Markdown section (or html element id) to scroll to; a new scrollKey scrolls again. */
  section?: string | null;
  scrollKey?: string;
  /** Sections changed since this version get a « changed » mark. */
  seenVersion?: number;
  stream: MessageStream;
  onAsk?(section: DocSection | null, version: number): void;
  onSeen?(): void;
  onOpenCard?(id: string): void;
  /** The whiteboard was deleted (Library editor). */
  onDeleted?(): void;
  onError(e: unknown): void;
}) {
  const { doc, onError } = props;
  const [pane, setPane] = useState<Pane>('preview');
  const [version, setVersion] = useState<number | null>(null);
  useEffect(() => {
    setVersion(null);
    setPane('preview');
  }, [doc.id]);

  const restore = (v: number) => {
    const what = doc.kind === 'whiteboard' ? 'The canvas' : 'The file';
    if (!confirm(`Restore v${v}? ${what} gets that content again, as a new version (you can undo it the same way).`)) return;
    api.restoreDoc(doc.id, v).then(() => {
      setVersion(null);
      setPane('preview');
    }, onError);
  };

  return (
    <div className={'viewer ' + props.mode}>
      <div className="sd-head">
        {props.lead}
        {props.tabs ? (
          <div className="sd-tabs" role="tablist" aria-label="Documents">
            {props.tabs.map((t) => (
              <div key={t.doc.id} className={'sd-tab' + (t.doc.id === doc.id ? ' on' : '')}>
                <button role="tab" aria-selected={t.doc.id === doc.id} title={t.doc.path ?? t.doc.title} onClick={() => t.doc.id !== doc.id && props.onTab?.(t.doc)}>
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
            <span className="sd-path">{doc.path ?? 'whiteboard'}</span>
          </div>
        )}
        {props.actions}
      </div>
      <div className="sd-sub" role="tablist" aria-label="View">
        {(['preview', 'source', 'history'] as Pane[]).map((p) => (
          <button key={p} type="button" role="tab" aria-selected={pane === p} className={'tabbtn' + (pane === p ? ' on' : '')} onClick={() => setPane(p)}>
            {p === 'history' && <Icon.clock />}
            {p === 'preview' ? 'Preview' : p === 'source' ? 'Source' : 'History'}
          </button>
        ))}
        <span className="sd-ver" title={new Date(doc.updatedAt).toLocaleString()}>
          {version !== null ? `v${version} of ${doc.version}` : `v${doc.version} · ${relAgo(doc.updatedAt)}`}
        </span>
      </div>
      {props.meta && pane === 'preview' && <div className="sd-by">{props.meta}</div>}
      {pane === 'preview' ? (
        <DocBody
          key={doc.id}
          doc={doc}
          mode={props.mode}
          version={version}
          onVersion={setVersion}
          onRestore={restore}
          section={props.section}
          scrollKey={props.scrollKey}
          seenVersion={props.seenVersion}
          stream={props.stream}
          onAsk={props.onAsk}
          onSeen={props.onSeen}
          onOpenCard={props.onOpenCard}
          onDeleted={props.onDeleted}
          onError={onError}
        />
      ) : pane === 'source' ? (
        <Source key={doc.id} doc={doc} version={version} stream={props.stream} onError={onError} />
      ) : (
        <History
          doc={doc}
          viewing={version}
          onView={(v) => {
            setVersion(v);
            setPane('preview');
          }}
          onRestore={restore}
          onError={onError}
        />
      )}
    </div>
  );
}

/** History: every kept version, latest first; view one, or restore it. */
function History(props: { doc: Doc; viewing: number | null; onView(v: number | null): void; onRestore(v: number): void; onError(e: unknown): void }) {
  const { doc, onError } = props;
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  useEffect(() => {
    api.docVersions(doc.id).then(setVersions, onError);
  }, [doc.id, doc.version, onError]);
  if (!versions) return <div className="sd-body loading" />;
  const shown = props.viewing ?? doc.version;
  return (
    <div className="sd-body sd-hist" role="list">
      {versions.map((v, i) => (
        <div key={v.version} role="listitem" className={'sd-hrow' + (v.version === shown ? ' on' : '')}>
          <b>v{v.version}</b>
          <span className="sd-hwho">{v.updatedBy === 'user' ? 'you' : '@' + v.updatedBy}</span>
          <span className="sd-hwhen" title={new Date(v.updatedAt).toLocaleString()}>
            {relAgo(v.updatedAt)}
          </span>
          <span className="sd-sp" />
          {i === 0 ? (
            <>
              <span className="sd-latest">latest</span>
              {props.viewing !== null && (
                <button type="button" className="head-btn" onClick={() => props.onView(null)}>
                  View
                </button>
              )}
            </>
          ) : (
            <>
              {doc.kind !== 'whiteboard' && (
                <button type="button" className="head-btn" onClick={() => props.onView(v.version)}>
                  View
                </button>
              )}
              <button type="button" className="head-btn" onClick={() => props.onRestore(v.version)}>
                Restore
              </button>
            </>
          )}
        </div>
      ))}
      <p className="sd-hnote">The last 50 versions are kept. Restoring adds a new version: nothing is lost.</p>
    </div>
  );
}

/** Source: the file's text at the version shown (whiteboards: the canvas nodes as JSON). */
function Source({ doc, version, stream, onError }: { doc: Doc; version: number | null; stream: MessageStream; onError(e: unknown): void }) {
  const [text, setText] = useState<string | null>(null);
  const latestKey = version === null ? doc.version : -1;
  useEffect(() => {
    let live = true;
    if (doc.kind === 'whiteboard') {
      const show = (c: Canvas) => live && setText(JSON.stringify(c.nodes, null, 2));
      api.canvas(doc.canvasId!).then(show, onError);
      const off = stream.listen('canvas:' + doc.canvasId, (e) => e.type === 'canvas' && show(e.canvas));
      return () => {
        live = false;
        off();
      };
    }
    api.document(doc.id, version ?? undefined).then((d) => live && setText(d.content), onError);
    return () => {
      live = false;
    };
  }, [doc.id, doc.kind, doc.canvasId, version, latestKey, stream, onError]);
  if (text === null) return <div className="sd-body loading" />;
  return (
    <div className="sd-body sd-src">
      <pre>{text}</pre>
    </div>
  );
}

/**
 * Preview: the document rendered by kind. Markdown at a readable width, sections with « Ask about this » and
 * « changed » marks; an html page at real size, sandboxed; an svg diagram fit to the width (text kept readable); a
 * whiteboard live (in the Library: its editor).
 */
function DocBody(props: {
  doc: Doc;
  mode: ViewerMode;
  /** null: the latest version, live. */
  version: number | null;
  onVersion(v: number | null): void;
  onRestore(v: number): void;
  section?: string | null;
  scrollKey?: string;
  seenVersion?: number;
  stream: MessageStream;
  onAsk?(section: DocSection | null, version: number): void;
  onSeen?(): void;
  onOpenCard?(id: string): void;
  onDeleted?(): void;
  onError(e: unknown): void;
}) {
  const { doc, version, onError } = props;
  const [data, setData] = useState<DocContent | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const scrolled = useRef<string | null>(null);

  // The latest version follows the document (doc.version changes on every edit); an old one is fixed.
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
      {version !== null && (
        <div className="sd-old">
          Viewing v{version} of {doc.version}.
          <button className="sd-link" onClick={() => props.onRestore(version)}>
            Restore this version
          </button>
          <button className="sd-link" onClick={() => props.onVersion(null)}>
            Back to latest
          </button>
        </div>
      )}
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
              <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _n, ...a }) => <a {...a} target="_blank" rel="noreferrer" /> }}>
                {s.text}
              </Markdown>
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
            src={`/api/files/${encodeURIComponent(doc.agentId)}/${doc.path!.split('/').map(encodeURIComponent).join('/')}${props.section ? '#' + encodeURIComponent(props.section) : ''}`}
          />
        ) : (
          <iframe className="doc-frame" title={doc.title} sandbox={SANDBOX} srcDoc={data.content} />
        )
      ) : doc.kind === 'diagram' ? (
        <Diagram svg={data.content} title={doc.title} />
      ) : props.mode === 'library' ? (
        <Suspense fallback={<div className="canvas-board loading">Loading canvas…</div>}>
          <CanvasBoard id={doc.canvasId!} stream={props.stream} onOpenCard={props.onOpenCard ?? (() => undefined)} onError={onError} onDeleted={props.onDeleted ?? (() => undefined)} />
        </Suspense>
      ) : (
        <Whiteboard canvasId={doc.canvasId!} stream={props.stream} onError={onError} />
      )}
    </div>
  );
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

/** A canvas shown whole, live (panel, card): « Open in Library » in its header goes to the editor. */
function Whiteboard({ canvasId, stream, onError }: { canvasId: string; stream: MessageStream; onError(e: unknown): void }) {
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  useEffect(() => {
    api.canvas(canvasId).then(setCanvas, onError);
    return stream.listen('canvas:' + canvasId, (e) => e.type === 'canvas' && setCanvas(e.canvas));
  }, [canvasId, stream, onError]);
  if (!canvas) return null;
  if (!canvas.nodes.length) return <p className="muted doc-empty">This canvas is empty.</p>;
  return <InlineCanvas canvasId={canvasId} nodeIds={canvas.nodes.map((n) => n.id)} stream={stream} />;
}
