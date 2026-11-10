import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Agent, Card, ChatGptStatus, Model, Schedule, Settings } from '@atlas/shared';
import { api, subscribe, type AuthState } from './api.ts';
import { Board } from './Board.tsx';
import { CardPanel } from './CardPanel.tsx';
import { useMessageStream } from './useMessages.ts';
import { CanvasView } from './canvas/CanvasView.tsx';
import { AgentsView } from './AgentsView.tsx';
import { SchedulesView } from './SchedulesView.tsx';
import { ModelsView } from './ModelsView.tsx';
import { ChatView } from './ChatView.tsx';
import { PlanWelcome } from './ChatGptSection.tsx';
import { ClaudeWelcome } from './ClaudePlanSection.tsx';
import { useTheme } from './theme.ts';
import { SettingsMenu, type SettingsSection } from './SettingsMenu.tsx';
import { SettingsView } from './SettingsView.tsx';
import { registerAgents } from './agentTint.ts';
import { ChatHistory } from './ChatHistory.tsx';
import { deletedChatRoute } from './chatHistoryMenu.ts';

/** Route in the URL hash, so reloads and the Electron window keep the place: #/board, #/canvas/<id>, or #/schedules. */
type View = 'chat' | 'board' | 'canvas' | 'agents' | 'models' | 'schedules' | 'settings';
function useRoute(): [{ view: View; canvasId: string | null }, (hash: string) => void] {
  const parse = (): { view: View; canvasId: string | null } => {
    const [, view, id] = location.hash.split('/');
    if (view === 'settings') {
      if (id === 'models' || id === 'agents') return { view: id, canvasId: null };
      return { view: 'settings', canvasId: id === 'board' ? 'board' : 'canvas' };
    }
    if (view === 'canvas') return { view: 'canvas', canvasId: id || null };
    if (view === 'chat') return { view: 'chat', canvasId: id || null };
    if (view === 'schedules') return { view: 'schedules', canvasId: null };
    if (view === 'agents') return { view: 'agents', canvasId: null };
    if (view === 'models') return { view: 'models', canvasId: null };
    return { view: 'board', canvasId: null };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (hash) => (location.hash = hash)];
}

/* ── Login screen ──────────────────────────────────────────────────────── */
function LoginScreen() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const submit = useCallback(async () => {
    try {
      await api.authLogin(password);
      location.reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [password]);

  return (
    <div className="login">
      <div className="login-card">
        <h1 className="login-title"><Mark /> Atlas</h1>
        <p className="login-sub">This Atlas server needs its password (ATLAS_PASSWORD).</p>
        {error && <div className="login-error">{error}</div>}
        {msg && <div className="login-msg">{msg}</div>}
        <form className="login-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
          />
          <button className="primary" disabled={!password}>Continue</button>
        </form>
      </div>
    </div>
  );
}

/* ── Main app ──────────────────────────────────────────────────────────── */
export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [route, go] = useRoute();
  const [themeChoice, , setThemeChoice] = useTheme();
  const [menu, setMenu] = useState(false);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [chats, setChats] = useState<Card[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [chatgpt, setChatgpt] = useState<ChatGptStatus | null>(null);
  const [claudeWelcome, setClaudeWelcome] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const stream = useMessageStream();
  const pendingAuth = useRef(false);

  // Check auth on mount
  useEffect(() => {
    api.authCheck().then(setAuth, (e: Error) => setError(e.message));
  }, []);

  // Don't subscribe to WebSocket or load data until we know auth state
  useEffect(() => {
    if (!auth) return;
    if (!auth.authenticated && auth.enabled) return;
    const reload = () => api.cards().then(setCards, (e: Error) => setError(e.message));
    return subscribe(
      (e) => {
        if (e.type === 'card.updated' && e.card.board === 'direct')
          // Direct chats aren't on the board: they are the sidebar's chat history, latest activity first.
          setChats((cs) =>
            [e.card, ...cs.filter((c) => c.id !== e.card.id)]
              .filter((c) => c.status !== 'archived')
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          );
        else if (e.type === 'card.updated')
          setCards((cs) => {
            const i = cs.findIndex((c) => c.id === e.card.id);
            if (e.card.status === 'archived') return cs.filter((c) => c.id !== e.card.id);
            if (i < 0) return [...cs, e.card];
            const next = cs.slice();
            next[i] = e.card;
            return next;
          });
        else if (e.type === 'card.deleted') {
          setCards((cs) => cs.filter((c) => c.id !== e.id));
          setChats((cs) => cs.filter((c) => c.id !== e.id));
        }
        else if (e.type === 'message.appended') stream.push(e.message.conversationId, { type: 'message', message: e.message });
        else if (e.type === 'run.delta') stream.push(e.conversationId, { type: 'delta', runId: e.runId, text: e.text });
        else if (e.type === 'run.updated') stream.push(e.run.cardId, { type: 'run', run: e.run });
        else if (e.type === 'canvas.updated') {
          stream.push('canvas:' + e.canvas.id, { type: 'canvas', canvas: e.canvas });
          stream.push('canvases', { type: 'canvases' });
        } else if (e.type === 'canvas.deleted') stream.push('canvases', { type: 'canvases' });
        else if (e.type === 'schedule.updated') setSchedules((ss) => { const i = ss.findIndex(s => s.id === e.schedule.id); const next = ss.slice(); if (i < 0) return [...ss, e.schedule]; next[i] = e.schedule; return next; });
        else if (e.type === 'schedule.deleted') setSchedules((ss) => ss.filter(s => s.id !== e.id));
        else if (e.type === 'local.updated') stream.push('local', { type: 'local', status: e.status });
        else if (e.type === 'local.pull') stream.push('local', { type: 'pull', pull: e.pull });
        else if (e.type === 'usage.recorded') {
          if (e.cardId) stream.push('usage:' + e.cardId, { type: 'usage' });
          stream.push('usage', { type: 'usage' });
        } else if (e.type === 'chatgpt.updated') {
          setChatgpt(e.status);
          api.models().then(setModels, (err: Error) => setError(err.message));
        } else if (e.type === 'claude.updated') {
          stream.push('claude', { type: 'claude', status: e.status });
          setClaudeWelcome(e.status.showWelcome);
          api.models().then(setModels, (err: Error) => setError(err.message));
        }
      },
      (up) => {
        setOnline(up);
        if (up) {
          void reload();
          api.agents().then(setAgents, (e: Error) => setError(e.message));
          api.schedules().then(setSchedules, (e: Error) => setError(e.message));
          api.settings().then(setSettings, (e: Error) => setError(e.message));
          api.chatgpt().then(setChatgpt, (e: Error) => setError(e.message));
          api.claude().then((c) => setClaudeWelcome(c.showWelcome), (e: Error) => setError(e.message));
          api.models().then(setModels, (e: Error) => setError(e.message));
          api.chats().then((cs) => {
            setChats(cs);
            setChatsLoaded(true);
          }, (e: Error) => setError(e.message));
        }
      },
    );
  }, [auth, stream]);

  // Agent tints are handed out in agent order; set before children render.
  registerAgents(agents.map((a) => a.id));
  const open = cards.find((c) => c.id === openId) ?? null;
  const [lastCanvas, setLastCanvas] = useState<string | null>(() => localStorage.getItem('atlas.canvas'));
  useEffect(() => {
    if (route.view === 'canvas' && route.canvasId) {
      setLastCanvas(route.canvasId);
      localStorage.setItem('atlas.canvas', route.canvasId);
    }
  }, [route.view, route.canvasId]);
  const selectCanvas = useCallback((id: string | null) => {
    if (!id) localStorage.removeItem('atlas.canvas');
    location.hash = '#/canvas' + (id ? '/' + id : '');
  }, []);
  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  const onPlan = (m: Model | undefined) => m?.provider === 'chatgpt';
  const planAgents = new Set(agents.filter((a) => onPlan(models.find((m) => m.id === a.modelId))).map((a) => a.id));
  /** A chat or card on the plan: its own model if picked, else its agent's. */
  const onPlanCard = (c: Card) => (c.modelId ? onPlan(models.find((m) => m.id === c.modelId)) : planAgents.has(c.assignee ?? ''));

  // Not authenticated and auth is enabled → show login screen
  if (auth?.enabled && !auth.authenticated) return <LoginScreen />;
  // Auth not yet checked → blank (will load in <100 ms)
  if (!auth) return null;

  const nav: { view: View; label: string; hash: string; icon: ReactNode }[] = [
    { view: 'board', label: 'Board', hash: '#/board', icon: <Icon.board /> },
    { view: 'canvas', label: 'Canvas', hash: '#/canvas' + (lastCanvas ? '/' + lastCanvas : ''), icon: <Icon.canvas /> },
    { view: 'schedules', label: 'Schedules', hash: '#/schedules', icon: <Icon.clock /> },
  ];
  const openChat = route.view === 'chat' ? chats.find((c) => c.id === route.canvasId) : undefined;
  const needYou = cards.filter((c) => c.status === 'blocked' || c.status === 'review').length;
  const runningCount = cards.filter((c) => c.status === 'running').length;
  const activeSchedules = schedules.filter((s) => s.enabled).length;
  const head: Record<View, [string, string]> = {
    chat: openChat
      ? [openChat.title, `Chat with @${openChat.assignee}`]
      : ['New chat', 'Talk to an agent directly, no card needed.'],
    board: [
      'Board',
      cards.length === 0
        ? 'No cards yet. Drop an idea in Triage.'
        : [
            `${cards.length} card${cards.length === 1 ? '' : 's'}`,
            runningCount ? `${runningCount} running` : '',
            needYou ? `${needYou} waiting for you` : '',
          ]
            .filter(Boolean)
            .join(' · '),
    ],
    canvas: ['Canvas', 'System design, drawings, notes and live pages on one surface.'],
    agents: ['Agents', `${agents.length} agent${agents.length === 1 ? '' : 's'}, their models and memory.`],
    models: ['Models', 'What agents run on: Claude, your ChatGPT plan, and models on this machine through Ollama.'],
    settings: [route.canvasId === 'board' ? 'Board settings' : 'Canvas settings', 'Settings'],
    schedules: ['Schedules', `${activeSchedules} active of ${schedules.length}.`],
  };

  return (
    <div className={'app' + (menu ? ' menu-open' : '')}>
      <aside className="sidebar" aria-label="Navigation">
        <div className="brand">
          <Mark />
          <div>
            <div className="brand-name">Atlas</div>
            <div className="brand-scope">{auth.enabled ? 'Server' : 'This Mac'}</div>
          </div>
        </div>
        <nav className="nav">
          {nav.map((n) => (
            <button
              key={n.view}
              className={'nav-item' + (route.view === n.view ? ' active' : '')}
              aria-current={route.view === n.view ? 'page' : undefined}
              onClick={() => {
                go(n.hash);
                setMenu(false);
              }}
            >
              {n.icon}
              <span>{n.label}</span>
              {n.view === 'board' && needYou > 0 && <span className="nav-count" title="Cards waiting for you">{needYou}</span>}
            </button>
          ))}
        </nav>
        <div className="side-rule" role="separator" />
        <section className="side-chats" aria-label="Chats">
          <button
            className={'nav-item new-chat-btn' + (route.view === 'chat' && !openChat ? ' active' : '')}
            onClick={() => {
              go('#/chat/new');
              setMenu(false);
            }}
          >
            <Icon.plus />
            <span>New chat</span>
          </button>
          <ChatHistory chats={chats} selected={openChat?.id}
            onSelect={(id) => { go('#/chat/' + id); setMenu(false); }}
            onDelete={(chat) => {
              if (!confirm(`Delete the chat “${chat.title}”?`)) return;
              api.deleteCard(chat.id).then(() => {
                setChats(cs => cs.filter(c => c.id !== chat.id));
                const next = deletedChatRoute(location.hash, chat.id);
                if (next) go(next);
              }, fail);
            }} />
        </section>
        <div className="sidebar-foot">
          <SettingsMenu
            active={route.view === 'settings' ? route.canvasId as SettingsSection : route.view === 'agents' || route.view === 'models' ? route.view : null}
            onNavigate={() => setMenu(false)}
          />
          <div className="side-status">
            <span className={'conn ' + (online ? 'up' : 'down')}>{online ? 'Engine connected' : 'Engine offline'}</span>
            {auth.enabled && (
              <button className="ghost small" onClick={() => api.authLogout().then(() => location.reload())}>
                Log out
              </button>
            )}
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button className="menu-btn ghost" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon.menu />
          </button>
          <h1>{head[route.view][0]}</h1>
          <p className="topbar-sub">{head[route.view][1]}</p>
        </header>
        <div className="sheet">
          {error && (
            <div className="error" role="alert">
              <span>{error}</span>
              <button className="ghost small" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          )}
      <main className={open ? 'with-panel' : ''}>
        {route.view === 'chat' ? (
          <ChatView
            agents={agents}
            chats={chats}
            loaded={chatsLoaded}
            target={route.canvasId}
            planAgents={planAgents}
            models={models}
            stream={stream}
            cards={cards}
            onOpenChat={(id) => go('#/chat/' + (id ?? 'new'))}
            onOpenCard={(id) => {
              go('#/board');
              setOpenId(id);
            }}
            onError={fail}
          />
        ) : route.view === 'settings' ? (
          <SettingsView section={route.canvasId === 'board' ? 'board' : 'canvas'}
            settings={settings} agents={agents} theme={themeChoice} onTheme={setThemeChoice}
            onSettings={setSettings} onError={fail}
            canvasHash={'#/canvas' + (lastCanvas ? '/' + lastCanvas : '')} />
        ) : route.view === 'models' ? (
          <ModelsView stream={stream} agents={agents} chatgpt={chatgpt} onModelsChanged={() => api.models().then(setModels, fail)} onError={fail} />
        ) : route.view === 'agents' ? (
          <AgentsView
            settings={settings}
            onSettings={setSettings}
            onAgentsChanged={() => {
              api.agents().then(setAgents, fail);
              api.models().then(setModels, fail);
            }}
            onError={fail}
          />
        ) : route.view === 'schedules' ? (
          <SchedulesView schedules={schedules} agents={agents} onOpenCard={setOpenId} onError={fail} />
        ) : route.view === 'canvas' ? (
          <CanvasView
            canvasId={route.canvasId}
            stream={stream}
            onSelect={selectCanvas}
            onOpenCard={(id) => setOpenId(id)}
            onError={fail}
          />
        ) : (
        <Board
          cards={cards}
          openId={openId}
          onOpen={setOpenId}
          onCreate={(title) => api.createCard(title).catch(fail)}
          onMove={(id, status) => api.moveCard(id, status).catch(fail)}
        />
        )}
        {open && (
          <CardPanel
            key={open.id}
            card={open}
            plan={onPlanCard(open)}
            models={models}
            cards={cards}
            onOpen={setOpenId}
            agents={agents}
            stream={stream}
            onClose={() => setOpenId(null)}
            onError={fail}
          />
        )}
      </main>
        </div>
      </div>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      {chatgpt?.showWelcome && <PlanWelcome onDone={() => api.updateChatgpt({ welcomed: true }).then(setChatgpt, fail)} />}
      {claudeWelcome && !chatgpt?.showWelcome && <ClaudeWelcome onDone={() => api.updateClaude({ welcomed: true }).then((c) => setClaudeWelcome(c.showWelcome), fail)} />}
    </div>
  );
}

/** The Atlas mark: a meridian and a parallel on a globe, drawn in the accent. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="var(--accent)" />
      <circle cx="12" cy="12" r="6.25" fill="none" stroke="var(--on-accent)" strokeWidth="1.5" />
      <ellipse cx="12" cy="12" rx="2.6" ry="6.25" fill="none" stroke="var(--on-accent)" strokeWidth="1.5" />
      <path d="M5.75 12h12.5" stroke="var(--on-accent)" strokeWidth="1.5" />
    </svg>
  );
}

const svg = (d: ReactNode) => () => (
  <svg className="icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const Icon = {
  board: svg(<><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M6 2.5v11M10 2.5v11" /></>),
  canvas: svg(<><path d="M2.5 13.5l3-.7 7.3-7.3a1.5 1.5 0 0 0-2.1-2.1L3.4 10.7z" /><path d="M9.5 4.5l2 2" /></>),
  agents: svg(<><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" /></>),
  chat: svg(<path d="M2.75 4.25a2 2 0 0 1 2-2h6.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.5v-2.5h-.25a1 1 0 0 1-1-1z" />),
  chip: svg(<><rect x="4" y="4" width="8" height="8" rx="1.5" /><path d="M6.5 1.75v2.25M9.5 1.75v2.25M6.5 12v2.25M9.5 12v2.25M1.75 6.5H4M1.75 9.5H4M12 6.5h2.25M12 9.5h2.25" /></>),
  plus: svg(<path d="M8 3v10M3 8h10" />),
  clock: svg(<><circle cx="8" cy="8" r="5.75" /><path d="M8 4.75V8l2.25 1.5" /></>),
  menu: svg(<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />),
};
