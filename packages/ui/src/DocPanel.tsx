import { useEffect, useState } from 'react';
import type { Doc, DocRef, PanelTab } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { activeTab, byline, panelMode, type PanelMode } from './docPanel.ts';
import { ArtifactViewer, KindIcon } from './Viewer.tsx';
import { Icon } from './ScreenHeader.tsx';
import { libraryHref } from './library.ts';

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
 * The panel beside a direct chat (design §16 « Chat », mockup linear.html?screen=chat): the shared viewer with the
 * chat's documents as tabs, « Open in Library », close; « opened by @x · attached to card Y » and « Ask about this ».
 */
export function DocPanel(props: {
  chatId: string;
  tabs: PanelTab[];
  mode: PanelMode;
  userName: string | null;
  stream: MessageStream;
  onAsk(q: Quote): void;
  onOpenCard(id: string): void;
  onHide(): void;
  onError(e: unknown): void;
}) {
  const { chatId, tabs, onError } = props;
  const tab = activeTab(tabs);
  if (!tab) return null;
  const doc = tab.doc;
  const unseen = tab.seenVersion < doc.version && doc.kind !== 'whiteboard';
  return (
    <aside className={'side-doc ' + props.mode} aria-label="Documents">
      <ArtifactViewer
        doc={doc}
        mode="panel"
        tabs={tabs.map((t) => ({
          doc: t.doc,
          dot: t.seenVersion < t.doc.version && t.doc.kind !== 'whiteboard',
          onClose: () => void api.panelClose(chatId, t.doc.id).catch(onError),
        }))}
        onTab={(d) => void api.panelFocus(chatId, d.id).catch(onError)}
        actions={
          <>
            <a className="sd-btn icon-only" href={libraryHref(doc.id)} title="Open in Library" aria-label="Open in Library">
              <Icon.ext />
            </a>
            {props.mode !== 'side' && (
              <button className="sd-btn" title="Back to the chat" onClick={props.onHide}>
                ‹ Chat
              </button>
            )}
            <button className="sd-btn icon-only" title="Close the panel" aria-label="Close the panel" onClick={() => api.panelClose(chatId, null).catch(onError)}>
              <Icon.x />
            </button>
          </>
        }
        meta={
          <>
            <span className="sd-by-t">
              {byline(tab, props.userName).replace(/ · attached to card .*$/, '')}
              {tab.cardTitle && doc.cardId && (
                <>
                  {' · attached to task '}
                  <button className="sd-link" onClick={() => props.onOpenCard(doc.cardId!)}>
                    “{tab.cardTitle}”
                  </button>
                </>
              )}
            </span>
            <span className="sd-sp" />
            {unseen && doc.kind !== 'markdown' && (
              <button className="doc-chg" title="Mark as seen" onClick={() => api.panelSeen(chatId, doc.id).catch(onError)}>
                changed
              </button>
            )}
            {doc.kind !== 'markdown' && (
              <button className="sd-ask" onClick={() => props.onAsk({ ref: { docId: doc.id, version: doc.version, section: null }, label: doc.title })}>
                Ask about this
              </button>
            )}
          </>
        }
        section={tab.section}
        scrollKey={tab.focusedAt}
        seenVersion={tab.seenVersion}
        stream={props.stream}
        onAsk={(s, v) => props.onAsk({ ref: { docId: doc.id, version: v, section: s?.id ?? null }, label: s?.title ? `${doc.title} › ${s.title}` : doc.title })}
        onSeen={() => void api.panelSeen(chatId, doc.id).catch(onError)}
        onOpenCard={props.onOpenCard}
        onError={onError}
      />
    </aside>
  );
}

/**
 * The documents attached to a card (ticket modal, inbox item): a list; picking one shows it below in the shared
 * viewer, the card's other documents as tabs. « Open in panel » (when given) shows it beside the card's chat.
 */
export function CardDocs({ cardId, stream, onOpenInPanel, onOpenCard, onError }: { cardId: string; stream: MessageStream; onOpenInPanel?(doc: Doc): void; onOpenCard?(id: string): void; onError(e: unknown): void }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    const load = () => api.documents(cardId).then(setDocs, onError);
    void load();
    return stream.listen('docs', (e) => e.type === 'doc' && e.doc.cardId === cardId && void load());
  }, [cardId, stream, onError]);
  if (!docs.length) return null;
  const doc = docs.find((d) => d.id === shown) ?? null;
  return (
    <>
      <h3 className="cm-h">Documents</h3>
      <div className="cm-docs">
        {docs.map((d) => (
          <button key={d.id} className={'cm-doc' + (d.id === shown ? ' on' : '')} aria-expanded={d.id === shown} onClick={() => setShown(d.id === shown ? null : d.id)}>
            <span className="cm-doc-icon">
              <KindIcon kind={d.kind} />
            </span>
            <span className="cm-doc-title">{d.title}</span>
            <span className="cm-doc-meta">
              {d.path ?? 'whiteboard'} · v{d.version}
            </span>
            <span className="cm-doc-open">{d.id === shown ? 'hide' : 'show ↓'}</span>
          </button>
        ))}
      </div>
      {doc && (
        <ArtifactViewer
          doc={doc}
          mode="inline"
          tabs={docs.length > 1 ? docs.map((d) => ({ doc: d })) : undefined}
          onTab={(d) => setShown(d.id)}
          actions={
            <>
              {onOpenInPanel && (
                <button className="sd-btn" title="Show it beside the task's chat" onClick={() => onOpenInPanel(doc)}>
                  Open in panel
                </button>
              )}
              <a className="sd-btn icon-only" href={libraryHref(doc.id)} title="Open in Library" aria-label="Open in Library">
                <Icon.ext />
              </a>
              <button className="sd-btn icon-only" title="Hide" aria-label="Hide the document" onClick={() => setShown(null)}>
                <Icon.x />
              </button>
            </>
          }
          stream={stream}
          onOpenCard={onOpenCard}
          onError={onError}
        />
      )}
    </>
  );
}
