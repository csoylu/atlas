import { useCallback, useEffect, useRef, useState } from 'react';
import { usePanelResize } from './PanelResizer.tsx';
import { paneLine, type Agent, type Card, type Doc, type Model, type PaneSees } from '@atlas/shared';
import { ThreadPanel } from './ThreadPanel.tsx';
import { api } from './api.ts';
import { CardPanel } from './CardPanel.tsx';
import type { MessageStream } from './useMessages.ts';
import { DocPanel, usePanelMode, usePanelTabs } from './DocPanel.tsx';
import { activeTab } from './docPanel.ts';
import { useComments } from './comments.ts';

export const LAST_AGENT = 'atlas.chat.agent';
/** Window event: show / hide the documents panel of the chat on screen (⌘\, the palette). */
export const TOGGLE_PANEL = 'atlas:toggle-panel';

/**
 * Direct chats (v3): each agent has one main chat (#/chat/<agentId> opens it, created on first use); older chats are
 * History (#/chat/<cardId>, still open to continue). #/chat/new opens the main chat of the agent last talked to.
 */
export function ChatView(props: {
  agents: Agent[];
  chats: Card[];
  /** The chat history has loaded (until then an unknown chat id is "loading", not "gone"). */
  loaded: boolean;
  /** Card id of a chat, an agent id (its main chat), or null / 'new'. */
  target: string | null;
  stream: MessageStream;
  cards: Card[];
  /** Agents whose model runs on the user's ChatGPT plan. */
  planAgents: Set<string>;
  models: Model[];
  userName: string | null;
  onOpenChat(cardId: string | null): void;
  /** Open an agent's main chat (App: creates it if needed, refreshes the agents, navigates). */
  onOpenMain(agentId: string): void;
  onOpenCard(id: string): void;
  /** The task open in the side panel (`?card=` in the route, #222), and closing it. */
  openCard: Card | null;
  onCloseCard(): void;
  onError(e: unknown): void;
}) {
  const { agents, onError } = props;
  const chat = props.chats.find((c) => c.id === props.target);
  if (!agents.length) return <div className="state-empty chat-empty">No agents yet. Add one on the Agents page.</div>;
  if (chat) return <ChatWithPanel key={chat.id} {...props} chat={chat} />;
  if (props.target?.startsWith('c_') && !props.loaded) return <div className="chat-pane loading" />;
  const enabled = agents.filter((a) => a.enabled);
  const last = localStorage.getItem(LAST_AGENT);
  const agentId = agents.some((a) => a.id === props.target) ? props.target! : (enabled.find((a) => a.id === last) ?? enabled[0] ?? agents[0])!.id;
  return <OpenMain key={agentId} agentId={agentId} onOpenMain={props.onOpenMain} />;
}

/** Resolves #/chat/<agent> or #/chat/new to the agent's main chat. */
function OpenMain({ agentId, onOpenMain }: { agentId: string; onOpenMain(agentId: string): void }) {
  useEffect(() => onOpenMain(agentId), [agentId, onOpenMain]);
  return <div className="chat-pane loading" />;
}

/**
 * A direct chat and its side panel (documents the agent opened, design §16): side by side above 960px, an overlay
 * below, full screen on phones. Comment mode on the panel (#304) puts numbered chips in the composer.
 */
function ChatWithPanel(props: Parameters<typeof ChatView>[0] & { chat: Card }) {
  const { chat, stream, onError } = props;
  const tabs = usePanelTabs(chat.id, stream, onError);
  const mode = usePanelMode();
  const viewRef = useRef<HTMLDivElement>(null);
  const resize = usePanelResize(viewRef, mode);
  const comments = useComments(chat.id);
  const [hidden, setHidden] = useState(false);
  const [want, setWant] = useState<{ docId: string; version: number; key: string } | null>(null);
  // An agent opening or focusing a tab shows the panel again.
  const lastFocus = tabs.reduce((m, t) => (t.focusedAt > m ? t.focusedAt : m), '');
  useEffect(() => setHidden(false), [lastFocus]);
  // Every task opens beside the chat (#107, #222), in the documents panel's place: `?card=` in the route.
  const thread = props.openCard && props.openCard.board !== 'direct' ? props.openCard : undefined;
  const openCard = props.onOpenCard;
  const closeThread = props.onCloseCard;
  const show = tabs.length > 0 && !hidden && !thread;
  // « What the agent sees » (#305): the tab open in the pane (or the task beside the chat), sent with Master's message;
  // the engine also hears it at each change, for a voice message (no composer). Closed, or hidden beside the chat: nothing.
  const [shown, setShown] = useState<{ doc: Doc; version: number } | null>(null);
  const onShown = useCallback((doc: Doc, version: number) => setShown((s) => (s?.doc === doc && s.version === version ? s : { doc, version })), []);
  // Beside the chat: on screen. Overlay or phone: the pane covers the chat, so « Back » to write keeps it open (the
  // mockup's phone composer shows the eye); closing its last tab closes it.
  const active = show || (hidden && mode !== 'side' && !thread) ? activeTab(tabs) : undefined;
  const sees: PaneSees | null = thread
    ? thread.number != null
      ? { kind: 'task', number: thread.number, title: thread.title }
      : null
    : active
      ? {
          kind: 'artifact',
          docId: active.doc.id,
          title: active.doc.title,
          agentId: active.doc.agentId,
          path: active.doc.path,
          version: shown?.doc.id === active.doc.id ? shown.version : active.doc.version,
        }
      : null;
  const seesKey = sees ? paneLine(sees) : '';
  useEffect(() => {
    const t = setTimeout(() => void api.reportPane(chat.id, sees).catch(onError), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id, seesKey]);
  // ⌘\ (App) and the palette toggle the panel of the chat on screen.
  const hasTabs = tabs.length > 0;
  useEffect(() => {
    const toggle = () => hasTabs && setHidden((h) => !h);
    window.addEventListener(TOGGLE_PANEL, toggle);
    return () => window.removeEventListener(TOGGLE_PANEL, toggle);
  }, [hasTabs]);
  return (
    <div ref={viewRef} className={'chat-view' + (show || thread ? ' with-doc ' + mode : '')}>
      <CardPanel
        plan={chat.modelId ? props.models.find((m) => m.id === chat.modelId)?.provider === 'chatgpt' : props.planAgents.has(chat.assignee ?? '')}
        models={props.models}
        card={chat}
        onOpen={openCard}
        agents={props.agents}
        stream={stream}
        onClose={() => props.onOpenChat(null)}
        onError={onError}
        userName={props.userName}
        cards={props.cards}
        sees={sees}
        comments={comments}
        hiddenDocs={hidden ? tabs.length : 0}
        onShowDocs={() => setHidden(false)}
        onHideDocs={show ? () => setHidden(true) : undefined}
        onOpenRef={(r) => {
          // A chat card opens its own version (an older card shows the version it was posted with).
          api.panelOpen(chat.id, r.docId, r.section).then(() => {
            setWant({ docId: r.docId, version: r.version, key: String(Date.now()) });
            setHidden(false);
          }, onError);
        }}
      />
      {thread && (
        <ThreadPanel
          key={thread.id}
          card={thread}
          cards={props.cards}
          chats={props.chats}
          agents={props.agents}
          models={props.models}
          plan={thread.modelId ? props.models.find((m) => m.id === thread.modelId)?.provider === 'chatgpt' : props.planAgents.has(thread.assignee ?? '')}
          mode={mode}
          resize={resize}
          back="Chat"
          stream={stream}
          userName={props.userName}
          onOpen={openCard}
          onOpenChat={(id) => (id === chat.id ? closeThread() : props.onOpenChat(id))}
          // A document of the task opens in this chat's documents panel, in the thread's place.
          onOpenDoc={(doc) => api.panelOpen(chat.id, doc.id).then(() => (closeThread(), setHidden(false)), onError)}
          // A chip in the task's thread (#192): its version and section, in the same panel.
          onOpenRef={(r) =>
            api.panelOpen(chat.id, r.docId, r.section).then(() => {
              setWant({ docId: r.docId, version: r.version, key: String(Date.now()) });
              closeThread();
              setHidden(false);
            }, onError)
          }
          onClose={closeThread}
          onError={onError}
        />
      )}
      {show && (
        <DocPanel
          chatId={chat.id}
          projectId={chat.projectId}
          tabs={tabs}
          mode={mode}
          resize={resize}
          userName={props.userName}
          want={want}
          stream={stream}
          onOpenCard={props.onOpenCard}
          onHide={() => setHidden(true)}
          onShown={onShown}
          onError={onError}
          comments={comments}
        />
      )}
    </div>
  );
}
