import { useEffect, useRef, useState } from 'react';
import type { Agent, Card, Effort, Model } from '@atlas/shared';
import { api } from './api.ts';
import { CardPanel } from './CardPanel.tsx';
import type { MessageStream } from './useMessages.ts';
import { tint } from './agentTint.ts';
import { submitOnEnter } from './composerKeys.ts';
import { ComposerMeta } from './Usage.tsx';

const LAST_AGENT = 'atlas.chat.agent';

/**
 * Direct chats: talk to any agent without making a card first. The history lives in the sidebar (App); this pane
 * shows one chat (#/chat/<cardId>) or a new one (#/chat/new, or #/chat/<agentId> to start with that agent).
 * A new chat is only created when Can sends its first message, so "New chat" clicks leave no empty chats behind.
 */
export function ChatView(props: {
  agents: Agent[];
  chats: Card[];
  /** The chat history has loaded (until then an unknown chat id is "loading", not "gone"). */
  loaded: boolean;
  /** Card id of a chat, an agent id to start a chat with, or null / 'new'. */
  target: string | null;
  stream: MessageStream;
  cards: Card[];
  /** Agents whose model runs on Can's ChatGPT plan. */
  planAgents: Set<string>;
  models: Model[];
  onOpenChat(cardId: string | null): void;
  onOpenCard(id: string): void;
  onError(e: unknown): void;
}) {
  const { agents, onError } = props;
  const chat = props.chats.find((c) => c.id === props.target);
  if (!agents.length) return <div className="empty-note chat-empty">No agents yet. Add one on the Agents page.</div>;
  if (chat)
    return (
      <div className="chat-view">
        <CardPanel
          key={chat.id}
          chat
          plan={chat.modelId ? props.models.find((m) => m.id === chat.modelId)?.provider === 'chatgpt' : props.planAgents.has(chat.assignee ?? '')}
          models={props.models}
          card={chat}
          cards={props.cards}
          onOpen={props.onOpenCard}
          agents={agents}
          stream={props.stream}
          onClose={() => props.onOpenChat(null)}
          onError={onError}
        />
      </div>
    );
  if (props.target?.startsWith('c_') && !props.loaded) return <div className="chat-pane loading" />;
  const start = agents.some((a) => a.id === props.target) ? props.target : null;
  return <NewChat key={start ?? 'new'} agents={agents} planAgents={props.planAgents} models={props.models} start={start} onCreated={props.onOpenChat} onError={onError} />;
}

/** A chat that doesn't exist yet: pick the agent, write, and the first message creates it. */
function NewChat(props: { agents: Agent[]; planAgents: Set<string>; models: Model[]; start: string | null; onCreated(cardId: string): void; onError(e: unknown): void }) {
  const enabled = props.agents.filter((a) => a.enabled);
  const remembered = localStorage.getItem(LAST_AGENT);
  const [agentId, setAgentId] = useState(
    props.start ?? (enabled.some((a) => a.id === remembered) ? remembered! : (enabled[0] ?? props.agents[0])!.id),
  );
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pick, setPick] = useState<{ modelId: string | null; effort: Effort | null }>({ modelId: null, effort: null });
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, [agentId]);
  const agent = props.agents.find((a) => a.id === agentId);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const card = await api.newChat(agentId);
      if (pick.modelId || pick.effort) await api.updateCard(card.id, pick);
      await api.postMessage(card.id, t);
      localStorage.setItem(LAST_AGENT, agentId);
      props.onCreated(card.id);
    } catch (e) {
      setSending(false);
      props.onError(e);
    }
  };

  return (
    <div className="chat-view">
      <aside className="panel chat-pane new-chat">
        <div className="new-chat-body">
          <h2>New chat</h2>
          <div className="agent-pick" role="radiogroup" aria-label="Agent">
            {props.agents.map((a) => (
              <button
                key={a.id}
                role="radio"
                aria-checked={a.id === agentId}
                className={'agent-chip' + (a.id === agentId ? ' on' : '')}
                onClick={() => setAgentId(a.id)}
                title={a.enabled ? a.modelId : `${a.modelId} · disabled`}
              >
                <span className="avatar small" style={tint(a.id)}>
                  {a.id.slice(0, 1).toUpperCase()}
                </span>
                <span>@{a.id}</span>
              </button>
            ))}
          </div>
          <p className="muted">
            {agent?.rolePrompt.split('\n')[0] || `Ask @${agentId} anything.`} For work to track, it creates cards on the board.
          </p>
        </div>
        <ComposerMeta
          usage={null}
          plan={pick.modelId ? props.models.find((m) => m.id === pick.modelId)?.provider === 'chatgpt' : props.planAgents.has(agentId)}
          pick={{
            models: props.models,
            agentModelId: agent?.modelId ?? null,
            modelId: pick.modelId,
            effort: pick.effort,
            onChange: (p) => setPick((cur) => ({ ...cur, ...p })),
          }}
        />
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={input}
            value={text}
            placeholder={`Message @${agentId}…  (Enter to send · Shift+Enter for newline)`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={submitOnEnter}
          />
        </form>
      </aside>
    </div>
  );
}
