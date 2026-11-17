import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cardRef, type Doc, type Agent, type Card, type ChatGptStatus, type Inbox as InboxData, type Model, type Schedule, type Settings } from '@atlas/shared';
import { api, subscribe, type AuthState } from './api.ts';
import { Board } from './Board.tsx';
import { Inbox } from './Inbox.tsx';
import { systemTitle } from './inboxView.ts';
import { CardModal } from './CardModal.tsx';
import { findCard, splitHash, withCard } from './cardModal.ts';
import { useMessageStream } from './useMessages.ts';
import { useMemoryDigest } from './MemoryDigest.tsx';
import { withDigest } from './memoryView.ts';
import { Library } from './Library.tsx';
import { SchedulesView } from './SchedulesView.tsx';
import { Welcome } from './Profile.tsx';
import { ChatView } from './ChatView.tsx';
import { PlanWelcome } from './ChatGptSection.tsx';
import { ClaudeWelcome } from './ClaudePlanSection.tsx';
import { useTheme } from './theme.ts';
import { SettingsView } from './SettingsView.tsx';
import { settingsLabel, settingsRoute, type SettingsPage } from './settingsPages.ts';
import { registerAgents } from './agentTint.ts';
import { ChatHistory } from './ChatHistory.tsx';
import { deletedChatRoute } from './chatHistoryMenu.ts';
import { tint } from './agentTint.ts';
import { HeaderSlot, Icon } from './ScreenHeader.tsx';
import { Palette, ShortcutsSheet, type PaletteContext } from './Palette.tsx';
import { GO_HASH, globalKey, nextRow } from './keys.ts';
import { LAST_AGENT, TOGGLE_PANEL } from './ChatView.tsx';

/**
 * Route in the URL hash, so reloads and the Electron window keep the place: #/inbox/<item>, #/board, #/library/<docId>,
 * #/schedules, #/chat/<id> or #/settings/<page>. Old links #/doc/<id> and #/canvas/<id> go to the Library viewer. Old settings hashes (#/agents, #/models, #/settings/canvas) are rewritten in place.
 * `?card=<id>` on any route opens that card's ticket modal over it (#/chat/c_1?card=c_2).
 */
type View = 'inbox' | 'chat' | 'board' | 'library' | 'canvas' | 'schedules' | 'settings';
type Route = { view: View; canvasId: string | null; card: string | null; /** What follows #/settings/memory: a scope or m12. */ rest: string };
function useRoute(): [Route, (hash: string) => void] {
  const parse = (): Route => ({ rest: '', ...parseView(), card: splitHash(location.hash).card });
  const parseView = (): { view: View; canvasId: string | null; rest?: string } => {
    const { path, card } = splitHash(location.hash);
    const [, view, id] = path.split('/');
    // Settings pages, old settings hashes, and #/settings/memory[/<scope> | /m12] (old #/library/memory… links too, #87).
    const settings = settingsRoute(path);
    if (settings) {
      // The query stays (?card=…&msg=… from a memory's source link).
      if (path !== settings.path) history.replaceState(null, '', settings.path + location.hash.slice(path.length));
      return { view: 'settings', canvasId: settings.page, rest: settings.rest };
    }
    if (view === 'library') return { view: 'library', canvasId: id ? decodeURIComponent(id) : null };
    // Old links: #/doc/<id> is the Library viewer; #/canvas/<id> too, once its whiteboard document is known.
    if (view === 'doc' || (view === 'canvas' && !id)) {
      const want = withCard('#/library' + (view === 'doc' && id ? '/' + id : ''), card);
      history.replaceState(null, '', want);
      return { view: 'library', canvasId: view === 'doc' && id ? decodeURIComponent(id) : null };
    }
    if (view === 'canvas') return { view: 'canvas', canvasId: id! };
    if (view === 'chat') return { view: 'chat', canvasId: id || null };
    if (view === 'schedules') return { view: 'schedules', canvasId: null };
    if (view === 'inbox') return { view: 'inbox', canvasId: id ? decodeURIComponent(id) : null };
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
        <h1 className="login-title"><Mark size={28} /> Atlas</h1>
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
  const [route, go] = useRoute();
  const [themeChoice, theme, setThemeChoice] = useTheme();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  /** « New card » asked from outside the Board (C, the palette): the Board opens its composer. */
  const [createAsk, setCreateAsk] = useState(0);
  const [menu, setMenu] = useState(false);
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null);
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
  const [inbox, setInbox] = useState<InboxData | null>(null);
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
    // The Inbox follows the board and the notifications; bursts of events reload it once.
    let inboxTimer: ReturnType<typeof setTimeout> | undefined;
    const reloadInbox = () => {
      clearTimeout(inboxTimer);
      inboxTimer = setTimeout(() => api.inbox().then(setInbox, (e: Error) => setError(e.message)), 120);
    };
    const unsubscribe = subscribe(
      (e) => {
        if (e.type === 'card.updated' && e.card.board === 'direct')
          // Direct chats aren't on the board: they are the sidebar's chat history, latest activity first.
          setChats((cs) =>
            [e.card, ...cs.filter((c) => c.id !== e.card.id)]
              .filter((c) => c.status !== 'archived')
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          );
        else if (e.type === 'card.updated') {
          reloadInbox();
          setCards((cs) => {
            const i = cs.findIndex((c) => c.id === e.card.id);
            if (e.card.status === 'archived') return cs.filter((c) => c.id !== e.card.id);
            if (i < 0) return [...cs, e.card];
            const next = cs.slice();
            next[i] = e.card;
            return next;
          });
        } else if (e.type === 'card.deleted') {
          reloadInbox();
          setCards((cs) => cs.filter((c) => c.id !== e.id));
          setChats((cs) => cs.filter((c) => c.id !== e.id));
        }
        else if (e.type === 'message.appended') stream.push(e.message.conversationId, { type: 'message', message: e.message });
        else if (e.type === 'run.delta') stream.push(e.conversationId, { type: 'delta', runId: e.runId, text: e.text });
        else if (e.type === 'run.thinking') stream.push(e.conversationId, { type: 'thinking', runId: e.runId, text: e.text });
        else if (e.type === 'run.updated') stream.push(e.run.cardId, { type: 'run', run: e.run });
        else if (e.type === 'toolcall.updated') stream.push(e.cardId, { type: 'toolcall', call: e.call });
        else if (e.type === 'conversation.rewound') stream.push(e.conversationId, { type: 'rewound' });
        else if (e.type === 'canvas.updated') {
          stream.push('canvas:' + e.canvas.id, { type: 'canvas', canvas: e.canvas });
          stream.push('canvases', { type: 'canvases' });
        } else if (e.type === 'canvas.deleted') stream.push('canvases', { type: 'canvases' });
        else if (e.type === 'document.updated') {
          stream.push('doc:' + e.doc.id, { type: 'doc', doc: e.doc });
          stream.push('docs', { type: 'doc', doc: e.doc });
        } else if (e.type === 'memory.updated') stream.push('memories', { type: 'memory', memory: e.memory });
        else if (e.type === 'memory.proposal') stream.push('memories', { type: 'proposal', proposal: e.proposal });
        else if (e.type === 'panel.updated') stream.push('panel:' + e.chatId, { type: 'panel', tabs: e.tabs });
        else if (e.type === 'schedule.updated') setSchedules((ss) => { const i = ss.findIndex(s => s.id === e.schedule.id); const next = ss.slice(); if (i < 0) return [...ss, e.schedule]; next[i] = e.schedule; return next; });
        else if (e.type === 'schedule.deleted') setSchedules((ss) => ss.filter(s => s.id !== e.id));
        else if (e.type === 'local.updated') stream.push('local', { type: 'local', status: e.status });
        else if (e.type === 'local.pull') stream.push('local', { type: 'pull', pull: e.pull });
        else if (e.type === 'voice.updated') stream.push('voice', { type: 'voice', status: e.status });
        else if (e.type === 'usage.recorded') {
          if (e.cardId) stream.push('usage:' + e.cardId, { type: 'usage' });
          stream.push('usage', { type: 'usage' });
        } else if (e.type === 'chatgpt.updated') {
          setChatgpt(e.status);
          api.models().then(setModels, (err: Error) => setError(err.message));
        } else if (e.type === 'notification.created') {
          notify(systemTitle(e.notification), e.notification.body);
          reloadInbox();
        } else if (e.type === 'inbox.changed') {
          reloadInbox();
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
          reloadInbox();
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
    return () => {
      clearTimeout(inboxTimer);
      unsubscribe();
    };
  }, [auth, stream]);

  // Agent tints are handed out in agent order; set before children render.
  registerAgents(agents.map((a) => a.id));
  const openId = route.card;
  const open = cards.find((c) => c.id === openId) ?? null;
  /** Opens a card's ticket modal over the current view (or closes it): `?card=` in the hash, so it survives reloads. */
  const cardsNow = useRef(cards);
  cardsNow.current = cards;
  const setOpenId = useCallback((ref: string | null) => {
    // "#12" references (links in messages) open the card with that number; ids open as they are.
    const id = ref === null ? null : (findCard(cardsNow.current, ref)?.id ?? ref);
    location.hash = withCard(location.hash, id);
  }, []);
  useEffect(() => {
    if (route.view === 'settings' && route.canvasId) localStorage.setItem('atlas.settings', route.canvasId);
  }, [route.view, route.canvasId]);
  // #/canvas/<id> (old links, « Open in Library » on inline canvases): to its whiteboard in the Library.
  useEffect(() => {
    if (route.view !== 'canvas' || !route.canvasId) return;
    api.whiteboardDoc(route.canvasId).then(
      (d) => location.replace(withCard('#/library/' + d.id, splitHash(location.hash).card)),
      (e) => {
        fail(e);
        location.replace('#/library');
      },
    );
  }, [route.view, route.canvasId]);
  /** The Inbox item in the URL: replaces the history entry (J/K would fill Back with every row). */
  const selectInbox = useCallback((key: string | null) => {
    location.replace(withCard('#/inbox' + (key ? '/' + encodeURIComponent(key) : ''), splitHash(location.hash).card));
  }, []);
  // App-wide shortcuts (keys.ts): ⌘K, ⌘N, ⌘\, ?, C, G then B/L/I/S, J/K in lists. The Inbox keeps its own J/K/E/R.
  const keyState = useRef({ gAt: null as number | null, view: route.view, palette, help });
  keyState.current = { ...keyState.current, view: route.view, palette, help };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = keyState.current;
      const blocked = st.palette || st.help || !!document.querySelector('.card-modal, .modal-scrim, .new-card-modal');
      const a = globalKey(e, e.target, { gAt: st.gAt, now: Date.now(), blocked });
      if (a?.kind !== 'goPrefix') st.gAt = null;
      if (!a) return;
      switch (a.kind) {
        case 'palette':
          setHelp(false);
          setPalette((p) => !p);
          break;
        case 'help':
          setHelp(true);
          break;
        case 'newChat':
          location.hash = '#/chat/new';
          break;
        case 'togglePanel':
          if (st.view !== 'chat') return;
          window.dispatchEvent(new Event(TOGGLE_PANEL));
          break;
        case 'newCard':
          if (st.view !== 'board') location.hash = '#/board';
          setCreateAsk((n) => n + 1);
          break;
        case 'goPrefix':
          st.gAt = Date.now();
          return; // not prevented: a lone G does nothing else
        case 'go':
          location.hash = GO_HASH[a.to];
          break;
        case 'listNext':
        case 'listPrev': {
          if (st.view === 'inbox') return; // the Inbox moves its own selection
          const rows = [...document.querySelectorAll<HTMLElement>('main [data-row]')].filter((r) => r.offsetParent !== null);
          const i = nextRow(rows.length, rows.indexOf(document.activeElement as HTMLElement), a.kind === 'listNext' ? 1 : -1);
          if (i === null) return;
          rows[i]!.focus();
          rows[i]!.scrollIntoView({ block: 'nearest' });
          break;
        }
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  /** The open Library document's title, for the breadcrumb. */
  const [libraryTitle, setLibraryTitle] = useState<string | null>(null);
  /** An agent's main chat (v3): created on first use; replaces the #/chat/<agent> or #/chat/new entry in the history. */
  const openMain = useCallback((agentId: string) => {
    api.mainChat(agentId).then(
      (c) => {
        localStorage.setItem(LAST_AGENT, agentId);
        setChats((cs) => (cs.some((x) => x.id === c.id) ? cs : [c, ...cs]));
        setAgents((as) => as.map((a) => (a.id === agentId ? { ...a, mainChat: c.id } : a)));
        location.replace(withCard('#/chat/' + c.id, splitHash(location.hash).card));
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  const clearCreateAsk = useCallback(() => setCreateAsk(0), []);
  const closePalette = useCallback(() => setPalette(false), []);
  const closeHelp = useCallback(() => setHelp(false), []);
  // The daily memory digest (#82): one Inbox update, counted in the badge while unread.
  const digest = useMemoryDigest(stream, fail, !!auth && (auth.authenticated || !auth.enabled));
  const shownInbox = useMemo(() => inbox && withDigest(inbox, digest.item), [inbox, digest.item]);
  /** Deletes a chat after a confirm (sidebar menu, chat header); leaves it if it was on screen. */
  const deleteChat = useCallback(
    (chat: Card) => {
      if (!confirm(`Delete the chat “${chat.title}”?`)) return;
      api.deleteCard(chat.id).then(() => {
        setChats((cs) => cs.filter((c) => c.id !== chat.id));
        const next = deletedChatRoute(location.hash, chat.id);
        if (next) location.hash = next;
      }, fail);
    },
    [fail],
  );
  /** Out of History; the chat stays in the database (status archived). */
  const archiveChat = useCallback(
    (chat: Card) => {
      api.updateCard(chat.id, { status: 'archived' }).then(() => {
        setChats((cs) => cs.filter((c) => c.id !== chat.id));
        const next = deletedChatRoute(location.hash, chat.id);
        if (next) location.hash = next;
      }, fail);
    },
    [fail],
  );
  const onPlan = (m: Model | undefined) => m?.provider === 'chatgpt';
  const planAgents = new Set(agents.filter((a) => onPlan(models.find((m) => m.id === a.modelId))).map((a) => a.id));
  /** A chat or card on the plan: its own model if picked, else its agent's. */
  const onPlanCard = (c: Card) => (c.modelId ? onPlan(models.find((m) => m.id === c.modelId)) : planAgents.has(c.assignee ?? ''));

  // Not authenticated and auth is enabled → show login screen
  if (auth?.enabled && !auth.authenticated) return <LoginScreen />;
  // Auth not yet checked → blank (will load in <100 ms)
  if (!auth) return null;

  const nav: { view: View; label: string; hash: string; icon: ReactNode; keys: string }[] = [
    { view: 'inbox', label: 'Inbox', hash: '#/inbox', icon: <Icon.inbox />, keys: 'G then I' },
    { view: 'board', label: 'Tasks', hash: '#/board', icon: <Icon.board />, keys: 'G then T' },
    { view: 'library', label: 'Library', hash: '#/library', icon: <Icon.library />, keys: 'G then L' },
    { view: 'schedules', label: 'Schedules', hash: '#/schedules', icon: <Icon.clock />, keys: 'G then S' },
  ];
  const openChat = route.view === 'chat' ? chats.find((c) => c.id === route.canvasId) : undefined;
  const badge = shownInbox?.badge ?? 0;
  const activeSchedules = schedules.filter((s) => s.enabled).length;
  /** An agent is busy while one of its cards runs or one of its chats is answering. */
  const busy = (id: string) => cards.some((c) => c.assignee === id && c.status === 'running') || chats.some((c) => c.assignee === id && c.working);
  const mainChats = new Set(agents.flatMap((a) => (a.mainChat ? [a.mainChat] : [])));
  const history = chats.filter((c) => !mainChats.has(c.id));
  const runningTasks = cards.filter((c) => c.status === 'running');
  const nav0 = (hash: string) => {
    go(hash);
    setMenu(false);
  };
  /** The header's breadcrumb (parts before the title), its title and a faint note after it. */
  const openIsMain = !!openChat && mainChats.has(openChat.id);
  const agentDot = (id: string) => (
    <span className="dot-avatar" aria-hidden="true" style={tint(id)}>{(id || '?').slice(0, 1).toUpperCase()}</span>
  );
  const crumb: { parts: ReactNode[]; title: string; titleIcon?: ReactNode; sub?: string } =
    route.view === 'chat'
      ? openChat && openIsMain
        ? { parts: [], title: openChat.assignee ?? openChat.title, titleIcon: agentDot(openChat.assignee ?? '') }
        : openChat
        ? {
            parts: [
              <span key="a" className="crumb-part crumb-agent">
                <span className="dot-avatar" aria-hidden="true" style={tint(openChat.assignee ?? '')}>{(openChat.assignee ?? '?').slice(0, 1).toUpperCase()}</span>
                {openChat.assignee}
              </span>,
            ],
            title: openChat.naming ? 'Generating chat name…' : openChat.title,
          }
        : { parts: [], title: 'Chat' }
      : route.view === 'board'
        ? { parts: [], title: 'Tasks' }
        : route.view === 'library' || route.view === 'canvas'
          ? route.canvasId && route.view === 'library'
            ? { parts: [<a key="l" className="crumb-link" href="#/library">Library</a>], title: libraryTitle ?? 'Document' }
            : { parts: [], title: 'Library' }
          : route.view === 'schedules'
            ? { parts: [], title: 'Schedules', sub: `${activeSchedules} active of ${schedules.length}` }
            : route.view === 'settings'
              ? { parts: [<span key="s" className="crumb-part">Settings</span>], title: settingsLabel(route.canvasId as SettingsPage) }
              : { parts: [], title: 'Document' };
  const paletteCtx: PaletteContext = {
    view: route.view,
    label:
      route.view === 'inbox'
        ? 'Inbox'
        : route.view === 'chat' && openChat
          ? openIsMain
            ? `Chat with @${openChat.assignee ?? openChat.title}`
            : openChat.title
          : crumb.title,
    chatId: openChat?.id ?? null,
  };
  const menuButton = (
    <button className="menu-btn ghost" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
      <Icon.menu />
    </button>
  );
  /** The ticket modal's « open on the right »: in the chat the card came from (or the chat on screen), else full size. */
  const openDoc = (doc: Doc, card: Card) => {
    const target = card.originCard && chats.some((c) => c.id === card.originCard) ? card.originCard : (openChat?.id ?? null);
    if (!target) return go('#/library/' + doc.id);
    api.panelOpen(target, doc.id).then(() => go('#/chat/' + target), fail);
  };

  return (
    <div className={'app' + (menu ? ' menu-open' : '')}>
      <aside className="sidebar" aria-label="Navigation">
        <div className="ws-row">
          <Mark />
          <span className="ws-name">Atlas</span>
          <span className="ws-scope">{auth.enabled ? 'Server' : ''}</span>
          <span className="ws-acts">
            <button type="button" className="icon-btn" aria-label="Search" title="Search and commands (⌘K)" onClick={() => (setMenu(false), setPalette(true))}>
              <Icon.search />
            </button>
          </span>
        </div>
        <nav className="nav">
          {nav.map((n) => (
            <button
              key={n.view}
              className={'nav-item' + (route.view === n.view ? ' active' : '')}
              aria-current={route.view === n.view ? 'page' : undefined}
              title={`${n.label} (${n.keys})`}
              onClick={() => nav0(n.hash)}
            >
              {n.icon}
              <span>{n.label}</span>
              {n.view === 'inbox' && badge > 0 && <span className="nav-count" title="Waiting for you and unread">{badge}</span>}
            </button>
          ))}
        </nav>
        {agents.length > 0 && (
          <section className="side-agents" aria-label="Agents">
            <div className="side-group">Agents</div>
            {agents.map((a) => (
              <button
                key={a.id}
                className={'nav-item agent-item' + (route.view === 'chat' && (route.canvasId === a.id || (!!a.mainChat && route.canvasId === a.mainChat)) ? ' active' : '')}
                title={`Chat with @${a.id}${busy(a.id) ? ' · working…' : ''}`}
                onClick={() => nav0('#/chat/' + (a.mainChat ?? a.id))}
              >
                <span className="dot-avatar" aria-hidden="true" style={tint(a.id)}>{a.id.slice(0, 1).toUpperCase()}</span>
                <span>{a.id}</span>
                {busy(a.id) && <span className="spin" aria-label="working" />}
              </button>
            ))}
          </section>
        )}
        {runningTasks.length > 0 && (
          <section className="side-running" aria-label="Running tasks">
            <div className="side-group">Running</div>
            {runningTasks.map((c) => (
              <button key={c.id} type="button" className="nav-item running-item" title={`${cardRef(c)} ${c.title}${c.assignee ? ' · @' + c.assignee : ''}`} onClick={() => (setMenu(false), setOpenId(c.id))}>
                <span className="spin" aria-hidden="true" />
                <span className="running-ref">{cardRef(c)}</span>
                <span className="running-title">{c.title}</span>
              </button>
            ))}
          </section>
        )}
        {history.length > 0 && (
          <section className="side-chats" aria-label="History">
            <div className="side-group">History</div>
            <ChatHistory chats={history} selected={openChat?.id}
              onSelect={(id) => nav0('#/chat/' + id)}
              onArchive={archiveChat}
              onDelete={deleteChat} />
          </section>
        )}
        <div className="sidebar-foot">
          <span className="me" aria-hidden="true">{(settings?.userName ?? '?').slice(0, 1).toUpperCase()}</span>
          <span className="me-name">{settings?.userName ?? ''}</span>
          <span className={'conn ' + (online ? 'up' : 'down')} role="status" aria-label={online ? 'Engine connected' : 'Engine offline'} title={online ? 'Engine connected' : 'Engine offline'} />
          {auth.enabled && (
            <button type="button" className="icon-btn" aria-label="Log out" title="Log out" onClick={() => api.authLogout().then(() => location.reload())}>
              <Icon.logout />
            </button>
          )}
          <button
            type="button"
            className={'icon-btn' + (route.view === 'settings' ? ' active' : '')}
            aria-label="Settings"
            title="Settings"
            aria-current={route.view === 'settings' ? 'page' : undefined}
            onClick={() => {
              if (route.view !== 'settings') go('#/settings/' + (localStorage.getItem('atlas.settings') ?? 'agents'));
              setMenu(false);
            }}
          >
            <Icon.gear />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <div className="sheet">
          {route.view !== 'inbox' && <header className="screen-head">
            {menuButton}
            <div className="crumb">
              {crumb.parts.map((p, i) => (
                <span key={i} className="crumb-part">
                  {p}
                  <span className="crumb-sep" aria-hidden="true">
                    <Icon.chev />
                  </span>
                </span>
              ))}
              {crumb.titleIcon}
              <h1>{crumb.title}</h1>
            </div>
            {crumb.sub && <span className="crumb-sub">{crumb.sub}</span>}
            <div className="head-actions" ref={setHeadSlot} />
          </header>}
          {error && (
            <div className="error" role="alert">
              <span>{error}</span>
              <button className="ghost small" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          )}
      <HeaderSlot.Provider value={headSlot}>
      <main>
        {route.view === 'inbox' ? (
          <Inbox
            inbox={shownInbox}
            digest={digest}
            cards={cards}
            agents={agents}
            selected={route.canvasId}
            onSelect={selectInbox}
            onOpenCard={setOpenId}
            menuButton={menuButton}
            stream={stream}
            onError={fail}
          />
        ) : route.view === 'chat' ? (
          <ChatView
            agents={agents}
            chats={chats}
            loaded={chatsLoaded}
            target={route.canvasId}
            planAgents={planAgents}
            models={models}
            userName={settings?.userName ?? null}
            stream={stream}
            cards={cards}
            onOpenChat={(id) => go('#/chat/' + (id ?? 'new'))}
            onOpenMain={openMain}
            onOpenCard={setOpenId}
            onError={fail}
          />
        ) : route.view === 'settings' ? (
          <SettingsView
            page={route.canvasId as SettingsPage}
            memoryRest={route.rest}
            cards={cards}
            chats={chats}
            stream={stream}
            settings={settings}
            agents={agents}
            models={models}
            chatgpt={chatgpt}
            theme={themeChoice}
            onTheme={setThemeChoice}
            onSettings={setSettings}
            onAgentsChanged={() => {
              api.agents().then(setAgents, fail);
              api.models().then(setModels, fail);
            }}
            onModelsChanged={() => api.models().then(setModels, fail)}
            onError={fail}
          />
        ) : route.view === 'library' || route.view === 'canvas' ? (
          <Library
            docId={route.view === 'library' ? route.canvasId : null}
            cards={cards}
            chats={chats}
            stream={stream}
            onOpenCard={setOpenId}
            onTitle={setLibraryTitle}
            onError={fail}
          />
        ) : route.view === 'schedules' ? (
          <SchedulesView schedules={schedules} agents={agents} onOpenCard={setOpenId} onError={fail} />
        ) : (
        <Board
          cards={cards}
          agents={agents}
          openId={openId}
          onOpen={setOpenId}
          onCreate={api.createCard}
          onError={fail}
          onMove={(id, status) => api.moveCard(id, status).catch(fail)}
          createAsk={createAsk}
          onCreateAsked={clearCreateAsk}
        />
        )}
        {open && (
          <CardModal
            key={open.id}
            card={open}
            plan={!!onPlanCard(open)}
            models={models}
            cards={cards}
            chats={chats}
            onOpen={setOpenId}
            onOpenChat={(id) => go('#/chat/' + id)}
            onOpenDoc={(doc) => openDoc(doc, open)}
            agents={agents}
            stream={stream}
            onClose={() => setOpenId(null)}
            onError={fail}
            userName={settings?.userName ?? null}
          />
        )}
      </main>
      </HeaderSlot.Provider>
        </div>
      </div>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      {palette && (
        <Palette
          ctx={paletteCtx}
          cards={cards}
          chats={chats}
          agents={agents}
          theme={theme}
          go={go}
          onOpenCard={setOpenId}
          onNewCard={() => {
            if (route.view !== 'board') go('#/board');
            setCreateAsk((n) => n + 1);
          }}
          onTogglePanel={() => window.dispatchEvent(new Event(TOGGLE_PANEL))}
          onTheme={setThemeChoice}
          onHelp={() => setHelp(true)}
          onClose={closePalette}
          onError={fail}
        />
      )}
      {help && <ShortcutsSheet onClose={closeHelp} />}
      {settings && (!settings.userName || !settings.userAbout) ? (
        <Welcome settings={settings} onSaved={setSettings} />
      ) : null}
      {settings?.userName && settings.userAbout && chatgpt?.showWelcome && <PlanWelcome onDone={() => api.updateChatgpt({ welcomed: true }).then(setChatgpt, fail)} />}
      {settings?.userName && settings.userAbout && claudeWelcome && !chatgpt?.showWelcome && <ClaudeWelcome onDone={() => api.updateClaude({ welcomed: true }).then((c) => setClaudeWelcome(c.showWelcome), fail)} />}
    </div>
  );
}

/** The Atlas mark: a meridian and a parallel on a globe, drawn in the accent. */
function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg className="mark" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="var(--accent)" />
      <circle cx="12" cy="12" r="6.25" fill="none" stroke="var(--on-accent)" strokeWidth="1.5" />
      <ellipse cx="12" cy="12" rx="2.6" ry="6.25" fill="none" stroke="var(--on-accent)" strokeWidth="1.5" />
      <path d="M5.75 12h12.5" stroke="var(--on-accent)" strokeWidth="1.5" />
    </svg>
  );
}

/** A system notification (the desktop app shows it in macOS Notification Center); asks once in a browser. */
function notify(title: string, body: string): void {
  if (typeof Notification === 'undefined') return;
  const show = () => void new Notification(title, { body });
  if (Notification.permission === 'granted') show();
  else if (Notification.permission !== 'denied') void Notification.requestPermission().then((p) => p === 'granted' && show());
}
