import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentFace } from './AgentFace.tsx';
import { Mark } from './Mark.tsx';
import { cardRef, type SecretStoreStatus, type UpdateStatus, type Doc, type Agent, type Card, type ChatGptStatus, type Inbox as InboxData, type Model, type Settings, type Workflow, type Project } from '@atlas/shared';
import { api, setViewing, subscribe, type AuthState } from './api.ts';
import { CheckIcon, RowMenu, useRowMenu } from './RowMenu.tsx';
import { Board } from './Board.tsx';
import { Inbox } from './Inbox.tsx';
import { systemTitle } from './inboxView.ts';
import { CHAT_MIN, SCREEN_MIN } from './docPanel.ts';
import { TaskSplit, ThreadPanel } from './ThreadPanel.tsx';
import { findCard, splitHash, withCard } from './cardModal.ts';
import { useMessageStream } from './useMessages.ts';
import { useMemoryDigest } from './MemoryDigest.tsx';
import { withDigest } from './memoryView.ts';
import { Library, type LibraryDocHead } from './Library.tsx';
import { WorkflowsView } from './WorkflowsView.tsx';
import { Welcome } from './Profile.tsx';
import { ChatView } from './ChatView.tsx';
import { PlanWelcome } from './ChatGptSection.tsx';
import { ClaudeWelcome } from './ClaudePlanSection.tsx';
import { useTheme } from './theme.ts';
import { SettingsView } from './SettingsView.tsx';
import { UpdateBadge, UpdateDialog } from './UpdateDialog.tsx';
import { SecretsBadge } from './SecretsPage.tsx';
import { settingsLabel, settingsRoute, type SettingsPage } from './settingsPages.ts';
import { registerAgents } from './agentTint.ts';
import { ChatHistory } from './ChatHistory.tsx';
import { deleteChatQuestion, deletedChatRoute } from './chatHistoryMenu.ts';
import { HeaderSlot, Icon } from './ScreenHeader.tsx';
import { Palette, ShortcutsSheet, type PaletteContext } from './Palette.tsx';
import { GO_HASH, globalKey, nextRow } from './keys.ts';
import { LAST_AGENT, TOGGLE_PANEL } from './ChatView.tsx';
import { groupCount } from './workflowView.ts';
import { effectiveFilter, inFilter, ProjDot, ProjTag, ProjectsCtx, projectsInfo, useProjectFilter } from './projects.tsx';
import { backOf, groupCollapsed, NARROW, setGroupCollapsed, tabOf, type Tab } from './shell.ts';
import { useMedia } from './Inbox.tsx';
import { ErrorState, Toast } from './Kit.tsx';
import { StatusMemory, type ToastMsg } from './toast.ts';

/**
 * Route in the URL hash, so reloads and the Electron window keep the place: #/inbox/<item>, #/board, #/library/<docId>,
 * #/workflows[/<id>[/runs[/<run id>]]], #/chat/<id> or #/settings/<page>. Old links #/doc/<id> go to the Library viewer, #/schedules to #/workflows, #/canvas/<id> to the Library. Old settings hashes (#/agents, #/models, #/settings/canvas) are rewritten in place.
 * `?card=<id>` on any route opens that task in the side panel on the right of it (#/chat/c_1?card=c_2, #222).
 */
type View = 'inbox' | 'chat' | 'board' | 'library' | 'workflows' | 'settings' | 'chats' | 'more';
/** The screen under the task panel, for its « ‹ Back » button (overlay and phone). */
const BACK: Record<View, string> = { inbox: 'Inbox', chat: 'Chat', board: 'Board', library: 'Library', workflows: 'Workflows', settings: 'Settings', chats: 'Chats', more: 'More' };
type Route = { view: View; target: string | null; card: string | null; /** What follows #/settings/memory: a scope or m12. */ rest: string };
function useRoute(): [Route, (hash: string) => void] {
  const parse = (): Route => ({ rest: '', ...parseView(), card: splitHash(location.hash).card });
  const parseView = (): { view: View; target: string | null; rest?: string } => {
    const { path, card } = splitHash(location.hash);
    const [, view, id] = path.split('/');
    // Settings pages, old settings hashes, and #/settings/memory[/<scope> | /m12] (old #/library/memory… links too, #87).
    const settings = settingsRoute(path);
    if (settings) {
      // The query stays (?card=…&msg=… from a memory's source link).
      if (path !== settings.path) history.replaceState(null, '', settings.path + location.hash.slice(path.length));
      // #/settings alone: the list of pages (no target); a wide window opens the last page instead.
      return { view: 'settings', target: settings.index ? null : settings.page, rest: settings.rest };
    }
    if (view === 'library') return { view: 'library', target: id ? decodeURIComponent(id) : null };
    // Old links: #/doc/<id> is the Library viewer; #/canvas/<id> (canvases are gone, #120) the Library's Canvases folder.
    if (view === 'doc' || view === 'canvas') {
      const want = withCard('#/library' + (view === 'doc' && id ? '/' + id : ''), card);
      history.replaceState(null, '', want);
      return { view: 'library', target: view === 'doc' && id ? decodeURIComponent(id) : null };
    }
    if (view === 'chat') return { view: 'chat', target: id || null };
    // Schedules became Workflows (#171): old links land on the list.
    if (view === 'schedules') {
      history.replaceState(null, '', withCard('#/workflows', card));
      return { view: 'workflows', target: null };
    }
    if (view === 'workflows') return { view: 'workflows', target: id ? decodeURIComponent(id) : null, rest: path.split('/').slice(3).join('/') };
    if (view === 'inbox') return { view: 'inbox', target: id ? decodeURIComponent(id) : null };
    // The narrow window's Chats and More tabs (#264): lists of the sidebar's rows; App sends a wide window home.
    if (view === 'chats' || view === 'more') return { view, target: null };
    return { view: 'board', target: null };
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
        {error && <div className="state-err">{error}</div>}
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
          <button className="btn primary" disabled={!password}>Continue</button>
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
  /** One narrow mode (#264): no sidebar, a tab bar at the bottom, back buttons on pushed screens. */
  const narrow = useMedia(NARROW);
  /** Bumped when a sidebar project group folds or unfolds (the state itself is in localStorage, shell.ts). */
  const [, setFolds] = useState(0);
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null);
  const [online, setOnline] = useState(false);
  // App updates (#123): the sidebar badge and its dialog.
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [secretStatus, setSecretStatus] = useState<SecretStoreStatus | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The merged toast (#265): live card moves only, compared with what the app knew (toast.ts).
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const statuses = useRef(new StatusMemory());
  const endToast = useCallback(() => setToast(null), []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [chats, setChats] = useState<Card[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [chatgpt, setChatgpt] = useState<ChatGptStatus | null>(null);
  const [claudeWelcome, setClaudeWelcome] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const pinfo = useMemo(() => projectsInfo(projects), [projects]);
  // The Workflows header counts what the list shows: the workflows of the project filter (#217).
  const [wfFilter] = useProjectFilter();
  const wfShown = useMemo(() => {
    const f = effectiveFilter(wfFilter, pinfo);
    return f === 'archived' ? [] : workflows.filter((w) => inFilter(f, w.projectId, pinfo, true));
  }, [workflows, wfFilter, pinfo]);
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
    const reload = () =>
      api.cards().then((cs) => {
        statuses.current.load(cs);
        setCards(cs);
      }, (e: Error) => setError(e.message));
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
          const t = statuses.current.update(e.card);
          if (t) setToast(t);
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
        else if (e.type === 'folders.updated') stream.push('folders', { type: 'folders', folders: e.folders });
        else if (e.type === 'document.updated') {
          stream.push('doc:' + e.doc.id, { type: 'doc', doc: e.doc });
          stream.push('docs', { type: 'doc', doc: e.doc });
        } else if (e.type === 'document.deleted') {
          stream.push('doc:' + e.id, { type: 'docDeleted', id: e.id });
          stream.push('docs', { type: 'docDeleted', id: e.id });
        } else if (e.type === 'memory.updated') stream.push('memories', { type: 'memory', memory: e.memory });
        else if (e.type === 'memory.proposal') stream.push('memories', { type: 'proposal', proposal: e.proposal });
        else if (e.type === 'panel.updated') stream.push('panel:' + e.chatId, { type: 'panel', tabs: e.tabs });
        else if (e.type === 'browser.updated') stream.push('browser:' + e.tab.chatId, { type: 'browser', tab: e.tab, blocked: !!e.blocked });
        else if (e.type === 'browser.closed') stream.push('browser:' + e.chatId, { type: 'browserClosed' });
        else if (e.type === 'workflow.updated') setWorkflows((ws) => { const i = ws.findIndex(w => w.id === e.workflow.id); const next = ws.slice(); if (i < 0) return [...ws, e.workflow]; next[i] = e.workflow; return next; });
        else if (e.type === 'project.updated')
          setProjects((ps) => (ps.some((p) => p.id === e.project.id) ? ps.map((p) => (p.id === e.project.id ? e.project : p)) : [...ps, e.project]));
        else if (e.type === 'workflow.deleted') setWorkflows((ws) => ws.filter(w => w.id !== e.id));
        else if (e.type === 'workflow.run') {
          stream.push('workflow-runs:' + e.run.workflowId, { type: 'workflowRun', run: e.run });
          stream.push('workflow-runs', { type: 'workflowRun', run: e.run }); // every run: the task view's « Workflows on this task » (#259)
        }
        else if (e.type === 'local.updated') stream.push('local', { type: 'local', status: e.status });
        else if (e.type === 'local.pull') stream.push('local', { type: 'pull', pull: e.pull });
        else if (e.type === 'voice.updated') stream.push('voice', { type: 'voice', status: e.status });
        else if (e.type === 'update.updated') setUpdate(e.status);
        else if (e.type === 'secrets.updated') stream.push('secrets', { type: 'secrets' });
        else if (e.type === 'secrets.status') setSecretStatus(e.status);
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
        } else if (e.type === 'settings.updated') {
          setSettings(e.settings);
        } else if (e.type === 'chat.replied') {
          // Sent only when no window has that chat on screen and focused (#338).
          const l = latest.current;
          if (l.settings?.notifyReplies !== false) {
            const project = l.projects.find((p) => p.id === e.projectId)?.name ?? e.projectId;
            notify(`${e.agentId} · ${project}`, e.text, {
              tag: `${e.chatId}:${e.seq}`,
              onClick: () => {
                window.focus();
                l.go('#/chat/' + e.chatId);
              },
            });
          }
        } else if (e.type === 'claude.updated') {
          stream.push('claude', { type: 'claude', status: e.status });
          setClaudeWelcome(e.status.showWelcome);
          api.models().then(setModels, (err: Error) => setError(err.message));
        }
      },
      (up) => {
        setOnline(up);
        if (!up) statuses.current.forget();
        if (up) {
          void reload();
          reloadInbox();
          api.agents().then(setAgents, (e: Error) => setError(e.message));
          api.workflows().then(setWorkflows, (e: Error) => setError(e.message));
          api.projects().then(setProjects, (e: Error) => setError(e.message));
          api.settings().then(setSettings, (e: Error) => setError(e.message));
          api.update().then(setUpdate, (e: Error) => setError(e.message));
          api.secretsStatus().then(setSecretStatus, (e: Error) => setError(e.message));
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
  /** Opens a task in the side panel beside the current view (or closes it): `?card=` in the hash, so it survives reloads. */
  const cardsNow = useRef(cards);
  cardsNow.current = cards;
  const setOpenId = useCallback((ref: string | null) => {
    // "#12" references (links in messages) open the card with that number; ids open as they are.
    const id = ref === null ? null : (findCard(cardsNow.current, ref)?.id ?? ref);
    location.hash = withCard(location.hash, id);
  }, []);
  const closeCard = useCallback(() => setOpenId(null), [setOpenId]);
  useEffect(() => {
    if (route.view === 'settings' && route.target) localStorage.setItem('atlas.settings', route.target);
  }, [route.view, route.target]);
  // Chats and More are the narrow window's tabs: a wide window has them in the sidebar, so it goes home.
  useEffect(() => {
    if (!narrow && (route.view === 'chats' || route.view === 'more')) location.replace('#/');
  }, [narrow, route.view]);
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
      const blocked = st.palette || st.help || !!document.querySelector('.modal-scrim, .new-card-modal') || !!document.activeElement?.closest('.thread-panel');
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
  /** The open Library document, for the header: « Library / folder / title » and its project tag. */
  const [libraryDoc, setLibraryDoc] = useState<LibraryDocHead | null>(null);
  /** An agent's main chat (v3): created on first use; replaces the #/chat/<agent> or #/chat/new entry in the history. */
  const openMain = useCallback((agentId: string, project?: Project) => {
    const other = project && !project.isDefault ? project : undefined;
    api.mainChat(agentId, other?.id).then(
      (c) => {
        localStorage.setItem(LAST_AGENT, agentId);
        setChats((cs) => (cs.some((x) => x.id === c.id) ? cs : [c, ...cs]));
        if (other)
          setProjects((ps) => ps.map((p) => (p.id !== other.id ? p : { ...p, members: p.members.map((m) => (m.agentId === agentId ? { ...m, mainChat: c.id } : m)) })));
        else setAgents((as) => as.map((a) => (a.id === agentId ? { ...a, mainChat: c.id } : a)));
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
  /** Deletes a History chat after a confirm (sidebar menu; never a main chat); leaves it if it was on screen. */
  const deleteChat = useCallback(
    (chat: Card) => {
      if (!confirm(deleteChatQuestion(chat, false))) return;
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
  // Unread replies (#338). The chat on screen while Atlas is focused is the one this window views: the engine reads it.
  const focused = useFocused();
  const viewedChat = focused && route.view === 'chat' ? (chats.find((c) => c.id === route.target)?.id ?? null) : null;
  useEffect(() => setViewing(viewedChat), [viewedChat]);
  const unreadChats = chats.filter((c) => c.unread).length;
  // « (3) Atlas »: unread chats + the Inbox count, in the window or tab title; the desktop app copies it to the Dock.
  const titleCount = settings?.countBadge === false ? 0 : unreadChats + (shownInbox?.badge ?? 0);
  useEffect(() => {
    document.title = titleCount > 0 ? `(${titleCount}) Atlas` : 'Atlas';
  }, [titleCount]);
  const readChat = useCallback((chat: Card) => void api.readChat(chat.id).catch(fail), [fail]);
  const readAllChats = useCallback(() => void api.readAllChats().catch(fail), [fail]);
  const agentMenu = useRowMenu();
  const closeAgentMenu = useCallback(() => agentMenu.setAt(null), [agentMenu.setAt]);
  // What the events socket needs at the time of an event, not of its subscription.
  const latest = useRef({ settings, projects, go });
  latest.current = { settings, projects, go };
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
    { view: 'workflows', label: 'Workflows', hash: '#/workflows', icon: <Icon.workflows />, keys: 'G then W' },
  ];
  const openChat = route.view === 'chat' ? chats.find((c) => c.id === route.target) : undefined;
  const badge = shownInbox?.badge ?? 0;
  const openWorkflow = route.view === 'workflows' && route.target ? workflows.find((w) => w.id === route.target) : undefined;
  /** An agent is busy while one of its cards runs or one of its chats is answering. */
  const busy = (id: string) => cards.some((c) => c.assignee === id && c.status === 'running') || chats.some((c) => c.assignee === id && c.working);
  // Main chats: one per agent and project (#214); none of them is in History.
  const mainChats = new Set([...agents.flatMap((a) => (a.mainChat ? [a.mainChat] : [])), ...projects.flatMap((p) => p.members.flatMap((m) => (m.mainChat ? [m.mainChat] : [])))]);
  /** With two active projects or more, the sidebar has one agent group per project. */
  const groups = pinfo.active.length >= 2 ? pinfo.active : null;
  // « Project › agent » (redesign #271): the project is named even with one project, as the mockup draws it.
  const chatProject = openChat ? pinfo.byId(openChat.projectId) : undefined;
  const projCrumb = chatProject ? (
    <span key="p" className="crumb-part proj-crumb">
      <ProjDot hue={chatProject.colour} />
      {chatProject.name}
    </span>
  ) : null;
  const history = chats.filter((c) => !mainChats.has(c.id));
  /** A chat with an unread reply (#338): bold name and a teal dot on its row. */
  const isUnread = (chatId: string | null | undefined) => !!chatId && !!chats.find((c) => c.id === chatId)?.unread;
  const menuChat = agentMenu.at ? chats.find((c) => c.id === agentMenu.at!.key) : undefined;
  const agentRowMenu = agentMenu.at && menuChat && (
    <RowMenu
      at={agentMenu.at}
      label={`Actions for your chat with @${menuChat.assignee ?? menuChat.title}`}
      onClose={closeAgentMenu}
      items={[
        { label: 'Mark as read', icon: <CheckIcon />, onClick: () => readChat(menuChat) },
        { label: 'Mark all as read', onClick: readAllChats },
      ]}
    />
  );
  const runningTasks = cards.filter((c) => c.status === 'running');
  /** The header's breadcrumb (parts before the title), its title and a faint note after it. */
  const openIsMain = !!openChat && mainChats.has(openChat.id);
  /** « team lead · idle »: the role's first line and whether the agent is working, after its name in a main chat. */
  const agentSub = (chat: Card) => {
    const a = agents.find((x) => x.id === chat.assignee);
    if (!a) return undefined;
    const role = a.rolePrompt.split('\n')[0]?.trim();
    return [role, busy(a.id) ? 'working' : 'idle'].filter(Boolean).join(' · ');
  };
  const agentDot = (id: string) => (
    <AgentFace id={id} />
  );
  const crumb: { parts: ReactNode[]; title: string; titleIcon?: ReactNode; sub?: string; tag?: ReactNode } =
    route.view === 'chat'
      ? openChat && openIsMain
        ? { parts: projCrumb ? [projCrumb] : [], title: openChat.assignee ?? openChat.title, titleIcon: agentDot(openChat.assignee ?? ''), sub: agentSub(openChat) }
        : openChat
        ? {
            parts: [
              ...(projCrumb ? [projCrumb] : []),
              <span key="a" className="crumb-part crumb-agent">
                <AgentFace id={openChat.assignee} />
                {openChat.assignee}
              </span>,
            ],
            title: openChat.naming ? 'Generating chat name…' : openChat.title,
          }
        : { parts: [], title: 'Chat' }
      : route.view === 'chats' || route.view === 'more'
        ? { parts: [], title: BACK[route.view] }
      : route.view === 'board'
        ? { parts: [], title: 'Tasks' }
        : route.view === 'library'
          ? route.target
            ? {
                parts: [
                  <a key="l" className="crumb-link" href="#/library">Library</a>,
                  ...(libraryDoc?.folder ? [<span key="f" className="crumb-folder">{libraryDoc.folder}</span>] : []),
                ],
                title: libraryDoc?.title ?? 'Document',
                tag: libraryDoc && pinfo.multi && <ProjTag id={libraryDoc.projectId} />,
              }
            : { parts: [], title: 'Library' }
          : route.view === 'workflows'
            ? route.target
              ? { parts: [<a key="w" className="crumb-link" href="#/workflows">Workflows</a>], title: openWorkflow?.name ?? 'Workflow', tag: openWorkflow && <ProjTag id={openWorkflow.projectId} global /> }
              : { parts: [], title: 'Workflows', sub: groupCount(wfShown) }
            : route.view === 'settings'
              ? route.target === 'projects' && route.rest
              ? {
                  parts: [<span key="s" className="crumb-part">Settings</span>, <a key="p" className="crumb-link" href="#/settings/projects">Projects</a>],
                  title: pinfo.byId(route.rest.split('/')[0])?.name ?? (route.rest === 'new' ? 'New project' : 'Project'),
                }
              : route.target === 'agents' && route.rest
                ? { parts: [<span key="s" className="crumb-part">Settings</span>, <a key="a" className="crumb-link" href="#/settings/agents">Agents</a>], title: '@' + route.rest }
                : route.target
                  ? { parts: [<span key="s" className="crumb-part">Settings</span>], title: settingsLabel(route.target as SettingsPage) }
                  : { parts: [], title: 'Settings' }
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
  /** A pushed screen's way back on a narrow window (no sidebar there): Chats for a chat, More for settings… */
  const back = narrow ? backOf(route.view, route.target, route.rest) : null;
  const backButton = back && (
    <button type="button" className="head-back" aria-label={back.label} title={back.label} onClick={() => go(back.hash)}>
      <Icon.back />
    </button>
  );
  /** The task panel's « open on the right »: in the chat the card came from (or the chat on screen), else full size. */
  const openDoc = (doc: Doc, card: Card) => {
    const target = card.originCard && chats.some((c) => c.id === card.originCard) ? card.originCard : (openChat?.id ?? null);
    if (!target) return go('#/library/' + doc.id);
    api.panelOpen(target, doc.id).then(() => go('#/chat/' + target), fail);
  };

  /** The Library viewer's « Open in side panel »: beside the chat the artifact came from, else its author's main chat. */
  const openInPanel = (doc: Doc) => {
    const proj = pinfo.byId(doc.projectId);
    const chat =
      doc.chatId && chats.some((c) => c.id === doc.chatId)
        ? Promise.resolve(doc.chatId)
        : api.mainChat(doc.agentId, proj && !proj.isDefault ? proj.id : undefined).then((c) => {
            setChats((cs) => (cs.some((x) => x.id === c.id) ? cs : [c, ...cs]));
            return c.id;
          });
    chat.then((id) => api.panelOpen(id, doc.id).then(() => go('#/chat/' + id)), fail);
  };

  // ⌘K as the nav's first row (#349): it opens the palette, it is not a route, so never active.
  const searchRow = (
    <button type="button" className="nav-item" title="Search and commands (⌘K)" onClick={() => setPalette(true)}>
      <Icon.search />
      <span>Search</span>
      <kbd className="nav-kbd">⌘K</kbd>
    </button>
  );
  const navRows = (only?: View[]) => (
    <nav className="nav">
      {!only && searchRow}
      {nav
        .filter((n) => !only || only.includes(n.view))
        .map((n) => (
          <button
            key={n.view}
            className={'nav-item' + (route.view === n.view ? ' active' : '')}
            aria-current={route.view === n.view ? 'page' : undefined}
            title={`${n.label} (${n.keys})`}
            onClick={() => go(n.hash)}
          >
            {n.icon}
            <span>{n.label}</span>
            {n.view === 'inbox' && badge > 0 && <span className="nav-count" title="Waiting for you and unread">{badge}</span>}
          </button>
        ))}
    </nav>
  );
  const agentsSection = groups
    ? // A project shows up once one member has a workspace there (cloning or failed: nothing to open yet).
      groups.filter((p) => p.members.some((m) => m.home || m.cloneState === 'ready')).map((p) => {
        const folded = groupCollapsed(p.id);
        // A folded group keeps one dot when one of its agents' chats has an unread reply (#338).
        const groupUnread = folded && p.members.some((m) => isUnread(p.isDefault ? agents.find((a) => a.id === m.agentId)?.mainChat : m.mainChat));
        return (
          <section key={p.id} className="side-agents" aria-label={p.name}>
            <button
              type="button"
              className="side-group side-proj"
              aria-expanded={!folded}
              title={(folded ? 'Show' : 'Hide') + ` ${p.name}'s agents` + (groupUnread ? ' · unread reply' : '')}
              onClick={() => (setGroupCollapsed(p.id, !folded), setFolds((n) => n + 1))}
            >
              <ProjDot hue={p.colour} />
              <span className="side-proj-name">{p.name}</span>
              {groupUnread && <span className="unread-dot" aria-label="unread reply" />}
              <Icon.chevDown />
            </button>
            {!folded &&
              agents
                .filter((a) => p.members.some((m) => m.agentId === a.id && (m.home || m.cloneState === 'ready')))
                .map((a) => {
                  const m = p.members.find((x) => x.agentId === a.id)!;
                  const main = p.isDefault ? a.mainChat : m.mainChat;
                  const working = cards.some((c) => c.projectId === p.id && c.assignee === a.id && c.status === 'running') || chats.some((c) => c.projectId === p.id && c.assignee === a.id && c.working);
                  const unread = isUnread(main);
                  return (
                    <button
                      key={a.id}
                      className={'nav-item agent-item' + (route.view === 'chat' && ((p.isDefault && route.target === a.id) || (!!main && route.target === main)) ? ' active' : '') + (unread ? ' unread' : '')}
                      title={`Chat with @${a.id} in ${p.name}${working ? ' · working…' : ''}${unread ? ' · unread reply' : ''}`}
                      {...(main ? agentMenu.bind(main) : {})}
                      onClick={() => agentMenu.clicked() && (main ? go('#/chat/' + main) : openMain(a.id, p))}
                    >
                      <AgentFace id={a.id} />
                      <span>{a.id}</span>
                      {working ? <span className="spin" aria-label="working" /> : unread && <span className="unread-dot" aria-label="unread reply" />}
                    </button>
                  );
                })}
          </section>
        );
      })
    : agents.length > 0 && (
        <section className="side-agents" aria-label="Agents">
          <div className="side-group">Agents</div>
          {agents.map((a) => {
            const unread = isUnread(a.mainChat);
            return (
              <button
                key={a.id}
                className={'nav-item agent-item' + (route.view === 'chat' && (route.target === a.id || (!!a.mainChat && route.target === a.mainChat)) ? ' active' : '') + (unread ? ' unread' : '')}
                title={`Chat with @${a.id}${busy(a.id) ? ' · working…' : ''}${unread ? ' · unread reply' : ''}`}
                {...(a.mainChat ? agentMenu.bind(a.mainChat) : {})}
                onClick={() => agentMenu.clicked() && go('#/chat/' + (a.mainChat ?? a.id))}
              >
                <AgentFace id={a.id} />
                <span>{a.id}</span>
                {busy(a.id) ? <span className="spin" aria-label="working" /> : unread && <span className="unread-dot" aria-label="unread reply" />}
              </button>
            );
          })}
        </section>
      );
  const runningSection = runningTasks.length > 0 && (
    <section className="side-running" aria-label="Running tasks">
      <div className="side-group">Running</div>
      {runningTasks.map((c) => (
        <button key={c.id} type="button" className="nav-item running-item" title={`${cardRef(c)} ${c.title}${c.assignee ? ' · @' + c.assignee : ''}${pinfo.multi && pinfo.byId(c.projectId) ? ' · ' + pinfo.byId(c.projectId)!.name : ''}`} onClick={() => setOpenId(c.id)}>
          <span className="spin" aria-hidden="true" />
          <span className="running-ref">{cardRef(c)}</span>
          <span className="running-title">{c.title}</span>
        </button>
      ))}
    </section>
  );
  const historySection = history.length > 0 && (
    <section className="side-chats" aria-label="History">
      <div className="side-group">History</div>
      <ChatHistory chats={history} selected={openChat?.id} onSelect={(id) => go('#/chat/' + id)} onArchive={archiveChat} onDelete={deleteChat} onRead={readChat} onReadAll={readAllChats} />
    </section>
  );
  const badges = (
    <>
      <SecretsBadge status={secretStatus} onOpen={() => go('#/settings/secrets')} />
      <UpdateBadge status={update} onOpen={() => setUpdateOpen(true)} />
    </>
  );
  const foot = (
    <div className="sidebar-foot">
      <span className="me" aria-hidden="true">{(settings?.userName ?? '?').slice(0, 1).toUpperCase()}</span>
      <span className="me-name">{settings?.userName ?? ''}</span>
      {auth.enabled && <span className="me-scope">Server</span>}
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
          if (route.view !== 'settings') go(narrow ? '#/settings' : '#/settings/' + (localStorage.getItem('atlas.settings') ?? 'agents'));
        }}
      >
        <Icon.gear />
      </button>
    </div>
  );
  const tab = tabOf(route.view);
  const tabs: { id: Tab; label: string; hash: string; icon: ReactNode }[] = [
    { id: 'inbox', label: 'Inbox', hash: '#/inbox', icon: <Icon.inbox /> },
    { id: 'tasks', label: 'Tasks', hash: '#/board', icon: <Icon.board /> },
    { id: 'chats', label: 'Chats', hash: '#/chats', icon: <Icon.ask /> },
    { id: 'library', label: 'Library', hash: '#/library', icon: <Icon.library /> },
    { id: 'more', label: 'More', hash: '#/more', icon: <Icon.dots /> },
  ];

  return (
    <ProjectsCtx.Provider value={pinfo}>
    <div className={'app' + (narrow ? ' narrow' : '')}>
      {!narrow && (
        <aside className="sidebar" aria-label="Navigation">
          {navRows()}
          {agentsSection}
          {runningSection}
          {historySection}
          {badges}
          {foot}
        </aside>
      )}
      <div className="workspace">
        <div className="sheet">
          {route.view !== 'inbox' && <header className="screen-head">
            {backButton}
            <div className="crumb">
              {/* A settings page on a narrow window: the back button and the page's name only (#272). */}
              {(narrow && route.view === 'settings' ? [] : crumb.parts).map((p, i) => (
                <span key={i} className="crumb-part">
                  {p}
                  <span className="crumb-sep" aria-hidden="true">
                    <Icon.chev />
                  </span>
                </span>
              ))}
              {crumb.titleIcon}
              <h1>{crumb.title}</h1>
              {crumb.tag}
            </div>
            {crumb.sub && <span className="crumb-sub">{crumb.sub}</span>}
            <div className="head-actions" ref={setHeadSlot} />
          </header>}
          {error && (
            <ErrorState className="app-error" action={<button className="btn small" onClick={() => setError(null)}>Dismiss</button>}>
              <span>{error}</span>
            </ErrorState>
          )}
          <Toast toast={toast} onOpen={setOpenId} onDone={endToast} />
      <HeaderSlot.Provider value={headSlot}>
      <main>
        {route.view === 'chat' ? (
          <ChatView
            agents={agents}
            chats={chats}
            loaded={chatsLoaded}
            target={route.target}
            planAgents={planAgents}
            models={models}
            userName={settings?.userName ?? null}
            stream={stream}
            cards={cards}
            onOpenChat={(id) => go('#/chat/' + (id ?? 'new'))}
            onOpenMain={openMain}
            onOpenCard={setOpenId}
            openCard={open}
            onCloseCard={closeCard}
            onError={fail}
          />
        ) : (
        <TaskSplit
          open={!!open}
          screenMin={route.view === 'board' ? CHAT_MIN : SCREEN_MIN}
          panel={(mode, resize) =>
            open && (
              <ThreadPanel
                key={open.id}
                card={open}
                mode={mode}
                resize={resize}
                back={BACK[route.view]}
                autoFocus
                plan={!!onPlanCard(open)}
                models={models}
                cards={cards}
                chats={chats}
                onOpen={setOpenId}
                onOpenChat={(id) => go('#/chat/' + id)}
                onOpenDoc={(doc) => openDoc(doc, open)}
                agents={agents}
                stream={stream}
                onClose={closeCard}
                onError={fail}
                userName={settings?.userName ?? null}
              />
            )
          }
        >
        {route.view === 'inbox' ? (
          <Inbox
            inbox={shownInbox}
            digest={digest}
            cards={cards}
            agents={agents}
            selected={route.target}
            onSelect={selectInbox}
            onOpenCard={setOpenId}
            stream={stream}
            onError={fail}
          />
        ) : route.view === 'settings' ? (
          <SettingsView
            page={route.target as SettingsPage | null}
            narrow={narrow}
            memoryRest={route.rest}
            cards={cards}
            chats={chats}
            workflows={workflows}
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
            update={update}
            onOpenUpdate={() => setUpdateOpen(true)}
            secretStatus={secretStatus}
            onError={fail}
          />
        ) : route.view === 'library' ? (
          <Library
            docId={route.target}
            cards={cards}
            chats={chats}
            stream={stream}
            onOpenCard={setOpenId}
            onDoc={setLibraryDoc}
            onOpenInPanel={openInPanel}
            onError={fail}
          />
        ) : route.view === 'chats' ? (
          // The narrow window's Chats tab: the sidebar's agents (by project) and History.
          <div className="side-list" aria-label="Chats">
            {agentsSection}
            {historySection}
          </div>
        ) : route.view === 'more' ? (
          // The narrow window's More tab: what the sidebar has that the other four tabs don't.
          <div className="side-list" aria-label="More">
            {searchRow}
            {navRows(['workflows'])}
            {runningSection}
            {badges}
            {foot}
          </div>
        ) : route.view === 'workflows' ? (
          <WorkflowsView
            workflows={workflows}
            agents={agents}
            cards={cards}
            target={route.target}
            rest={route.rest}
            stream={stream}
            go={go}
            onOpenCard={setOpenId}
            onError={fail}
          />
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
        </TaskSplit>
        )}
      </main>
      </HeaderSlot.Provider>
        </div>
      </div>
      {narrow && (
        <nav className="tabbar" aria-label="Tabs">
          {tabs.map((t) => (
            <button key={t.id} type="button" className={'tabbar-btn' + (tab === t.id ? ' on' : '')} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.hash)}>
              {t.icon}
              <span>{t.label}</span>
              {t.id === 'inbox' && badge > 0 && <span className="tabbar-n" title="Waiting for you and unread">{badge}</span>}
              {t.id === 'chats' && unreadChats > 0 && <span className="tabbar-n" title="Chats with an unread reply">{unreadChats}</span>}
            </button>
          ))}
        </nav>
      )}
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
      {agentRowMenu}
      {help && <ShortcutsSheet onClose={closeHelp} />}
      {updateOpen && update && <UpdateDialog status={update} onClose={() => setUpdateOpen(false)} onError={fail} />}
      {settings && (!settings.userName || !settings.userAbout) ? (
        <Welcome settings={settings} onSaved={setSettings} />
      ) : null}
      {settings?.userName && settings.userAbout && chatgpt?.showWelcome && <PlanWelcome onDone={() => api.updateChatgpt({ welcomed: true }).then(setChatgpt, fail)} />}
      {settings?.userName && settings.userAbout && claudeWelcome && !chatgpt?.showWelcome && <ClaudeWelcome onDone={() => api.updateClaude({ welcomed: true }).then((c) => setClaudeWelcome(c.showWelcome), fail)} />}
    </div>
    </ProjectsCtx.Provider>
  );
}

/** A system notification (the desktop app shows it in macOS Notification Center); asks once in a browser. */
function notify(title: string, body: string, o: { tag?: string; onClick?(): void } = {}): void {
  if (typeof Notification === 'undefined') return;
  const show = () => {
    // The same tag in two windows is one notification.
    const n = new Notification(title, { body, ...(o.tag ? { tag: o.tag } : {}) });
    if (o.onClick) n.onclick = o.onClick;
  };
  if (Notification.permission === 'granted') show();
  else if (Notification.permission !== 'denied') void Notification.requestPermission().then((p) => p === 'granted' && show());
}

/** Atlas is in front: the window has the focus and the page is visible (#338: only then is a chat on screen read). */
function useFocused(): boolean {
  const now = () => document.visibilityState === 'visible' && document.hasFocus();
  const [on, setOn] = useState(now);
  useEffect(() => {
    const change = () => setOn(now());
    window.addEventListener('focus', change);
    window.addEventListener('blur', change);
    document.addEventListener('visibilitychange', change);
    return () => {
      window.removeEventListener('focus', change);
      window.removeEventListener('blur', change);
      document.removeEventListener('visibilitychange', change);
    };
  }, []);
  return on;
}
