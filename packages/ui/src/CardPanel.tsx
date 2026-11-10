import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CARD_STATUSES, type Agent, type Card, type ContentBlock, type Message, type Model, type Run } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { submitOnEnter } from './composerKeys.ts';
import { ComposerMeta, useChatUsage } from './Usage.tsx';

type ToolResult = Extract<ContentBlock, { type: 'tool_result' }>;

export function CardPanel(props: {
  card: Card;
  cards: Card[];
  onOpen(id: string): void;
  agents: Agent[];
  stream: MessageStream;
  onClose(): void;
  onError(e: unknown): void;
  /** Direct chat with the card's agent (ChatView): only the conversation, no card fields. */
  chat?: boolean;
  /** The card's agent runs on Can's ChatGPT plan: say so by the composer (OpenAI's guidelines). */
  plan?: boolean;
  /** All models, for the model chooser above the composer. */
  models: Model[];
}) {
  const { card, stream, onError } = props;
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const usage = useChatUsage(card.id, stream, onError);
  const [draft, setDraft] = useState('');
  const [text, setText] = useState('');
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const end = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Agents edit cards too: follow server changes unless Can is typing in that field.
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(card.title);
  }, [card.title]);
  useEffect(() => {
    if (document.activeElement !== bodyRef.current) setBody(card.body);
  }, [card.body]);

  useEffect(() => {
    const offMsg = stream.listen(card.conversationId, (e) => {
      if (e.type === 'message') {
        setMessages((ms) => (ms.some((x) => x.id === e.message.id) ? ms : [...ms, e.message]));
        if (e.message.role === 'assistant') setDraft('');
      } else if (e.type === 'delta') setDraft((d) => d + e.text);
    });
    const offRun = stream.listen(card.id, (e) => {
      if (e.type !== 'run') return;
      setRun(e.run);
      if (e.run.status !== 'running') setDraft('');
    });
    api.messages(card.id).then((ms) => setMessages((live) => merge(ms, live)), onError);
    api.runs(card.id).then((rs) => setRun((live) => live ?? rs[0] ?? null), onError);
    return () => {
      offMsg();
      offRun();
    };
  }, [card.id, card.conversationId, stream, onError]);

  // Block body on purpose: scrollIntoView returns a Promise in recent Chromium, which must not become the cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, draft]);

  const results = useMemo(() => {
    const map = new Map<string, ToolResult>();
    for (const m of messages) for (const b of m.content) if (b.type === 'tool_result') map.set(b.tool_use_id, b);
    return map;
  }, [messages]);

  const save = (patch: Partial<Card>) => api.updateCard(card.id, patch).catch(onError);
  const send = (t: string) => api.postMessage(card.id, t).catch(onError);
  const running = run?.status === 'running';
  const byId = new Map(props.cards.map((c) => [c.id, c]));
  const children = props.cards.filter((c) => c.parents.includes(card.id));
  const linkable = props.cards.filter((c) => c.id !== card.id && !card.parents.includes(c.id));

  const agent = props.agents.find((a) => a.id === card.assignee);
  return (
    <aside className={props.chat ? 'panel chat-pane' : 'panel'}>
      {props.chat ? (
        <button
          type="button"
          className="chat-delete"
          aria-label="Delete chat"
          title="Delete chat"
          onClick={() => {
            if (confirm(`Delete the chat “${card.title}”?`)) api.deleteCard(card.id).then(props.onClose, onError);
          }}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3.5 5.5h13M8 3h4l1 2.5H7L8 3ZM5.5 5.5l.7 11h7.6l.7-11M8.5 8.5v5M11.5 8.5v5" />
          </svg>
        </button>
      ) : (
      <>
      <div className="panel-head">
        <span className="id">{card.id}</span>
        <select
          className="assignee-select"
          value={card.assignee ?? ''}
          onChange={(e) => save({ assignee: e.target.value || null })}
          title="Assignee"
        >
          <option value="">unassigned</option>
          {props.agents.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.id}
            </option>
          ))}
        </select>
        <select value={card.status} onChange={(e) => save({ status: e.target.value as Card['status'] })}>
          {CARD_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <button
          className="ghost danger"
          onClick={() => {
            if (confirm(`Delete ${card.id} and its chat?`)) api.deleteCard(card.id).then(props.onClose, onError);
          }}
        >
          Delete
        </button>
        <button className="ghost" onClick={props.onClose} aria-label="Close">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <input
        ref={titleRef}
        className="title-edit"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== card.title && save({ title })}
      />
      <textarea
        ref={bodyRef}
        className="body-edit"
        value={body}
        placeholder="Description, acceptance criteria…"
        onChange={(e) => setBody(e.target.value)}
        onBlur={() => body !== card.body && save({ body })}
      />
      <div className="relations">
        <span className="label">after</span>
        {card.parents.map((p) => (
          <span key={p} className="chip">
            <span className={'dot ' + (byId.get(p)?.status ?? 'done')} />
            <button className="link" onClick={() => props.onOpen(p)} title={byId.get(p)?.title}>
              {byId.get(p)?.title ?? p}
            </button>
            <button className="x" onClick={() => save({ parents: card.parents.filter((x) => x !== p) })} aria-label="Unlink">
              ×
            </button>
          </span>
        ))}
        <select
          className="add-link"
          value=""
          onChange={(e) => e.target.value && save({ parents: [...card.parents, e.target.value] })}
        >
          <option value="">+ parent</option>
          {linkable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        {children.length > 0 && (
          <>
            <span className="label">then</span>
            {children.map((c) => (
              <span key={c.id} className="chip">
                <span className={'dot ' + c.status} />
                <button className="link" onClick={() => props.onOpen(c.id)}>
                  {c.title}
                </button>
              </span>
            ))}
          </>
        )}
      </div>
      </>
      )}
      {card.block && (
        <div className={'block-box ' + card.block.kind}>
          <div className="block-kind">{blockLabel[card.block.kind]}</div>
          <div className="block-reason">{card.block.reason}</div>
          {card.block.options.length > 0 && (
            <div className="options">
              {card.block.options.map((o, i) => (
                <button key={o} className={i === 0 ? 'option recommended' : 'option'} onClick={() => send(o)}>
                  {o}
                  {i === 0 && <span className="rec">recommended</span>}
                </button>
              ))}
            </div>
          )}
          <div className="hint">
            Answer below; the card goes back to ready.
            {card.block.kind !== 'needs_input' && (
              <button className="ghost retry" onClick={() => api.retry(card.id).catch(onError)}>
                Retry now
              </button>
            )}
          </div>
        </div>
      )}
      {card.status === 'review' && (
        <div className="block-box review">
          <div className="block-kind">Waiting for your review</div>
          <div className="options">
            <button className="option recommended" onClick={() => save({ status: 'done' })}>
              Approve → done
            </button>
          </div>
          <div className="hint">Or write the changes you want below; the card goes back to ready.</div>
        </div>
      )}
      {card.waiting && !card.block && card.status !== 'review' && (
        <div className="waiting-line">
          {card.waiting}
          {card.waiting.includes('Retry') && (
            <button className="ghost retry" onClick={() => api.retry(card.id).catch(onError)}>
              Retry
            </button>
          )}
        </div>
      )}
      <div className="chat">
        {messages.length === 0 && (
          <p className="empty">
            {props.chat
              ? `Ask @${card.assignee} anything. For work to track, it creates cards on the board.`
              : card.assignee
                ? `Write to @${card.assignee}: it works here and answers live.`
                : 'Assign an agent, then write to it here.'}
          </p>
        )}
        {messages
          .filter((m) => m.author !== 'tool')
          .map((m, i, shown) =>
            m.author === 'system' ? (
              <div key={m.id} className="sys-note">
                {m.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ')}
              </div>
            ) : (
            <div key={m.id} className={'msg ' + m.role + (shown[i - 1]?.author === m.author ? ' cont' : '')}>
              {shown[i - 1]?.author !== m.author && <div className="who">{m.author}</div>}
              {m.content.map((b, i) => (
                <Block key={i} block={b} results={results} />
              ))}
            </div>
            ),
          )}
        {draft && (
          <div className="msg assistant">
            <div className="who">{card.assignee}</div>
            <div className="text streaming">{draft}</div>
          </div>
        )}
        <div ref={end} />
      </div>
      {run && run.status !== 'done' && (
        <div className={'run-status ' + run.status}>
          {running ? (
            <>
              <span className="pulse" /> @{run.agentId} is working…
              <button className="ghost" onClick={() => api.stop(card.id).catch(onError)}>
                Stop
              </button>
            </>
          ) : (
            <>
              Run {run.status}
              {run.error ? `: ${run.error}` : ''}
            </>
          )}
        </div>
      )}
      <ComposerMeta
        usage={usage}
        plan={!!props.plan}
        pick={{
          models: props.models,
          agentModelId: agent?.modelId ?? null,
          modelId: card.modelId,
          effort: card.effort,
          onChange: (p) => void api.updateCard(card.id, p).catch(onError),
        }}
      />
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          setText('');
          void send(t);
        }}
      >
        <textarea
          value={text}
          placeholder={card.assignee ? `Message @${card.assignee}…  (Enter to send · Shift+Enter for newline)` : 'Message…  (Enter to send · Shift+Enter for newline)'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={submitOnEnter}
        />
      </form>
    </aside>
  );
}

const blockLabel: Record<NonNullable<Card['block']>['kind'], string> = {
  needs_input: 'Question for you',
  dependency: 'Waiting on other work',
  capability: 'Missing access or a broken setup',
  transient: 'Temporary problem, will retry',
};

function Block({ block: b, results }: { block: ContentBlock; results: Map<string, ToolResult> }) {
  switch (b.type) {
    case 'text':
      return (
        <div className="text md">
          <Markdown remarkPlugins={[remarkGfm]}>{b.text}</Markdown>
        </div>
      );
    case 'thinking':
      return (
        <details className="tool thinking">
          <summary>thinking</summary>
          <pre>{b.thinking}</pre>
        </details>
      );
    case 'redacted_thinking':
      return null;
    case 'tool_use': {
      const r = results.get(b.id);
      return (
        <details className={'tool' + (r?.is_error ? ' err' : '') + (r ? '' : ' pending')}>
          <summary>
            {r ? (r.is_error ? '✕' : '✓') : '…'} {b.name} <span className="arg">{summarize(b.input)}</span>
          </summary>
          <pre>{JSON.stringify(b.input, null, 2)}</pre>
          {r && <pre className="out">{r.content}</pre>}
        </details>
      );
    }
    case 'tool_result':
      return null;
  }
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.path ?? o.title ?? o.id ?? Object.values(o).find((x) => typeof x === "string" && x);
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

function merge(a: Message[], b: Message[]): Message[] {
  const byId = new Map([...a, ...b].map((m) => [m.id, m]));
  return [...byId.values()].sort((x, y) => x.seq - y.seq);
}
