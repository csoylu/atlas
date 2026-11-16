import type { Inbox, FileChange, RewindPreview, RewindResult, Doc, DocContent, DocRef, DocVersion, PanelTab, About, CreatePlanAccount, Notification, PlanProvider, UpdatePlanAccount, ChatUsage, UsageSummary, ChatGptModel, ChatGptStatus, UpdateChatGpt, ClaudePlanModel, ClaudePlanStatus, UpdateClaudePlan, Account, CreateAccount, UpdateAccount, LocalModel, LocalPull, LocalStatus, UpdateLocal, Agent, Canvas, CanvasNode, Card, CardStatus, CreateAgent, CreateCard, CreateModel, CreateSchedule, Memory, Message, Model, ModelTest, Run, Schedule, Timeline, ToolCallTiming, ServerEvent, Settings, UpdateVoice, VoiceName, VoiceStatus, UpdateAgent, UpdateModel, UpdateSchedule } from '@atlas/shared';

/** HTTP error with the parsed body (e.g. 409 carries the current canvas). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include', // session cookie with every request
  });
  if (!res.ok) {
    // Session missing or expired (server mode): reload, and the app shows the login screen.
    if (res.status === 401 && !path.startsWith('/auth/')) {
      location.reload();
      throw new ApiError('log in first', 401, {});
    }
    const err = (await res.json().catch(() => ({}))) as { error?: string; issues?: { path?: (string | number)[]; message: string }[] };
    // Validation errors: say which field and why, not just « invalid request ».
    const detail = err.issues?.map((i) => (i.path?.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ');
    throw new ApiError(detail || err.error || `${method} ${path}: HTTP ${res.status}`, res.status, err);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export type AuthState = { authenticated: boolean; enabled: boolean };

export const api = {
  cards: () => call<Card[]>('GET', '/cards'),
  createCard: (card: CreateCard) => call<Card>('POST', '/cards', card),
  updateCard: (id: string, patch: Partial<Pick<Card, 'title' | 'body' | 'status' | 'assignee' | 'priority' | 'parents' | 'modelId' | 'effort'>>) =>
    call<Card>('PATCH', `/cards/${id}`, patch),
  moveCard: (id: string, status: CardStatus) => call<Card>('PATCH', `/cards/${id}`, { status }),
  deleteCard: (id: string) => call<void>('DELETE', `/cards/${id}`),
  messages: (id: string) => call<Message[]>('GET', `/cards/${id}/messages`),
  postMessage: (id: string, text: string, ref?: DocRef) => call<Message>('POST', `/cards/${id}/messages`, ref ? { text, ref } : { text }),
  // ── Documents and the side panel ──
  documents: (cardId?: string) => call<Doc[]>('GET', '/documents' + (cardId ? `?card=${encodeURIComponent(cardId)}` : '')),
  document: (id: string, version?: number) => call<DocContent>('GET', `/documents/${id}` + (version === undefined ? '' : `?version=${version}`)),
  docVersions: (id: string) => call<DocVersion[]>('GET', `/documents/${id}/versions`),
  restoreDoc: (id: string, version: number) => call<Doc>('POST', `/documents/${id}/restore/${version}`),
  pinDoc: (id: string, pinned: boolean) => call<Doc>('POST', `/documents/${id}/pin`, { pinned }),
  /** The whiteboard document of a canvas (created on first use). */
  whiteboardDoc: (canvasId: string) => call<Doc>('POST', `/canvases/${canvasId}/document`, {}),
  panel: (chatId: string) => call<PanelTab[]>('GET', `/chats/${chatId}/panel`),
  panelOpen: (chatId: string, docId: string, section: string | null = null) => call<PanelTab[]>('POST', `/chats/${chatId}/panel/open`, { docId, section }),
  panelClose: (chatId: string, docId: string | null) => call<PanelTab[]>('POST', `/chats/${chatId}/panel/close`, { docId }),
  panelFocus: (chatId: string, docId: string) => call<PanelTab[]>('POST', `/chats/${chatId}/panel/focus`, { docId }),
  panelSeen: (chatId: string, docId: string) => call<PanelTab[]>('POST', `/chats/${chatId}/panel/seen`, { docId }),
  runs: (id: string) => call<Run[]>('GET', `/cards/${id}/runs`),
  toolCalls: (id: string) => call<ToolCallTiming[]>('GET', `/cards/${id}/tool-calls`),
  /** What the chat shows between messages (#66): unfinished runs, rewinds, the context summary point. */
  timeline: (id: string) => call<Timeline>('GET', `/cards/${id}/timeline`),
  stop: (id: string) => call<{ stopped: boolean }>('POST', `/cards/${id}/stop`),
  /** Rewind to your message `seq`, or (no seq) the turn the running run answers; null = the run was just stopped. */
  rewind: (id: string, seq?: number) => call<RewindResult | null>('POST', `/cards/${id}/rewind`, seq ? { seq } : {}),
  rewindPreview: (id: string, seq: number) => call<RewindPreview>('GET', `/cards/${id}/rewind?seq=${seq}`),
  undoRewind: (rewindId: string) => call<{ files: FileChange[]; filesError: string | null }>('POST', `/rewinds/${rewindId}/undo`),
  retry: (id: string) => call<Card>('POST', `/cards/${id}/retry`),
  agents: () => call<Agent[]>('GET', '/agents'),
  chats: () => call<Card[]>('GET', '/chats'),
  newChat: (agentId: string) => call<Card>('POST', `/agents/${agentId}/chats`),
  usage: (days = 30) => call<UsageSummary>('GET', `/usage?days=${days}`),
  cardUsage: (id: string) => call<ChatUsage>('GET', `/cards/${id}/usage`),
  chatgpt: () => call<ChatGptStatus>('GET', '/chatgpt'),
  chatgptLogin: (accountId?: string) => call<{ url: string }>('POST', '/chatgpt/login', { accountId }),
  chatgptCancel: () => call<ChatGptStatus>('POST', '/chatgpt/cancel'),
  chatgptLogout: (accountId?: string) => call<ChatGptStatus>('POST', '/chatgpt/logout', { accountId }),
  updateChatgpt: (patch: UpdateChatGpt) => call<ChatGptStatus>('PATCH', '/chatgpt', patch),
  chatgptModels: () => call<ChatGptModel[]>('GET', '/chatgpt/models'),
  claude: () => call<ClaudePlanStatus>('GET', '/claude'),
  claudeLogin: (accountId?: string) => call<{ url: string }>('POST', '/claude/login', { accountId }),
  claudeComplete: (code: string) => call<ClaudePlanStatus>('POST', '/claude/complete', { code }),
  claudeCancel: () => call<ClaudePlanStatus>('POST', '/claude/cancel'),
  claudeLogout: (accountId?: string) => call<ClaudePlanStatus>('POST', '/claude/logout', { accountId }),
  updateClaude: (patch: UpdateClaudePlan) => call<ClaudePlanStatus>('PATCH', '/claude', patch),
  claudeModels: () => call<ClaudePlanModel[]>('GET', '/claude/models'),
  // ── Plan subscriptions (several per provider, failover in list order) ──
  createPlanAccount: (a: CreatePlanAccount) => call<ClaudePlanStatus | ChatGptStatus>('POST', '/plan-accounts', a),
  updatePlanAccount: (id: string, patch: UpdatePlanAccount) => call<ClaudePlanStatus | ChatGptStatus>('PATCH', `/plan-accounts/${id}`, patch),
  reorderPlanAccounts: (provider: PlanProvider, ids: string[]) => call<ClaudePlanStatus | ChatGptStatus>('PUT', '/plan-accounts/order', { provider, ids }),
  deletePlanAccount: (id: string) => call<ClaudePlanStatus | ChatGptStatus>('DELETE', `/plan-accounts/${id}`),
  notifications: () => call<Notification[]>('GET', '/notifications'),
  // ── Inbox (design §16) ──
  inbox: () => call<Inbox>('GET', '/inbox'),
  readNotification: (id: number) => call<void>('POST', `/notifications/${id}/read`),
  archiveNotification: (id: number) => call<void>('POST', `/notifications/${id}/archive`),
  archiveRead: () => call<{ archived: number }>('POST', '/notifications/archive-read'),
  createAgent: (a: CreateAgent) => call<Agent>('POST', '/agents', a),
  updateAgent: (id: string, patch: UpdateAgent) => call<Agent>('PATCH', `/agents/${id}`, patch),
  deleteAgent: (id: string) => call<void>('DELETE', `/agents/${id}`),
  memory: (agent: string) => call<Memory>('GET', `/memory/${agent}`),
  setMemory: (agent: string, text: string) => call<Memory>('PUT', `/memory/${agent}`, { text }),
  models: () => call<Model[]>('GET', '/models'),
  createModel: (m: CreateModel) => call<Model>('POST', '/models', m),
  updateModel: (id: string, patch: UpdateModel) => call<Model>('PATCH', `/models/${id}`, patch),
  deleteModel: (id: string) => call<void>('DELETE', `/models/${id}`),
  testModel: (id: string) => call<ModelTest>('POST', `/models/${id}/test`),
  secrets: () => call<{ store: string | null; names: string[] }>('GET', '/secrets'),
  setSecret: (name: string, value: string) => call<void>('PUT', `/secrets/${name}`, { value }),
  deleteSecret: (name: string) => call<void>('DELETE', `/secrets/${name}`),
  settings: () => call<Settings>('GET', '/settings'),
  about: () => call<About>('GET', '/about'),
  // ── Voice mode (desktop only) ──
  voice: () => call<VoiceStatus>('GET', '/voice'),
  updateVoice: (patch: UpdateVoice) => call<VoiceStatus>('PATCH', '/voice', patch),
  retryVoiceDownload: () => call<VoiceStatus>('POST', '/voice/download'),
  /** One spoken sentence in that voice, as a WAV blob. */
  testVoice: async (voice: VoiceName) => {
    const res = await fetch('/api/voice/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice }), credentials: 'include' });
    if (!res.ok) throw new ApiError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`, res.status, {});
    return res.blob();
  },
  canvases: () => call<Omit<Canvas, 'nodes'>[]>('GET', '/canvases'),
  canvas: (id: string) => call<Canvas>('GET', `/canvases/${id}`),
  createCanvas: (name: string) => call<Canvas>('POST', '/canvases', { name }),
  saveCanvas: (id: string, nodes: CanvasNode[], baseVersion: number) => call<Canvas>('PUT', `/canvases/${id}`, { nodes, baseVersion }),
  renameCanvas: (id: string, name: string) => call<Canvas>('PATCH', `/canvases/${id}`, { name }),
  deleteCanvas: (id: string) => call<void>('DELETE', `/canvases/${id}`),
  updateSettings: (patch: Partial<Settings>) => call<Settings>('PATCH', '/settings', patch),
  // ── Auth ──────────────────────────────────────────────────────────────
  authCheck: () => call<AuthState>('POST', '/auth/check'),
  authLogin: (password: string) => call<{ ok: boolean }>('POST', '/auth/login', { password }),
  authLogout: () => call<{ ok: boolean }>('POST', '/auth/logout'),
  // ── Anthropic accounts ────────────────────────────────────────────
  accounts: () => call<Account[]>('GET', '/accounts'),
  createAccount: (a: CreateAccount) => call<Account>('POST', '/accounts', a),
  updateAccount: (id: string, patch: UpdateAccount) => call<Account>('PATCH', `/accounts/${id}`, patch),
  reorderAccounts: (ids: string[]) => call<Account[]>('PUT', '/accounts/order', { ids }),
  deleteAccount: (id: string) => call<void>('DELETE', `/accounts/${id}`),
  testAccount: (id: string) => call<{ ok: boolean; error: string | null }>('POST', `/accounts/${id}/test`),
  // ── Local model server ────────────────────────────────────────────
  local: () => call<LocalStatus>('GET', '/local'),
  updateLocal: (patch: UpdateLocal) => call<LocalStatus>('PATCH', '/local', patch),
  startLocal: () => call<LocalStatus>('POST', '/local/start'),
  stopLocal: () => call<LocalStatus>('POST', '/local/stop'),
  installLocal: () => call<LocalStatus>('POST', '/local/install'),
  localModels: () => call<{ models: LocalModel[]; pulls: LocalPull[] }>('GET', '/local/models'),
  pull: (name: string) => call<LocalPull>('POST', '/local/pull', { name }),
  cancelPull: (name: string) => call<void>('DELETE', '/local/pull?name=' + encodeURIComponent(name)),
  deleteLocal: (name: string) => call<void>('DELETE', '/local/models?name=' + encodeURIComponent(name)),
  loadLocal: (name: string, keep: boolean) => call<void>('POST', '/local/load', { name, keep }),
  useLocal: (name: string) => call<Model>('POST', '/local/use', { name }),
  // ── Schedules ───────────────────────────────────────────────────────
  schedules: () => call<Schedule[]>('GET', '/schedules'),
  createSchedule: (s: CreateSchedule) => call<Schedule>('POST', '/schedules', s),
  updateSchedule: (id: string, patch: UpdateSchedule) => call<Schedule>('PATCH', `/schedules/${id}`, patch),
  deleteSchedule: (id: string) => call<void>('DELETE', `/schedules/${id}`),
  runSchedule: (id: string) => call<Card>('POST', `/schedules/${id}/run`),
  /** Next 3 firings of a draft (400 with the reason if the cron or zone is wrong). */
  previewSchedule: (w: Pick<Schedule, 'kind' | 'cron' | 'at' | 'timezone'>) =>
    call<{ timezone: string; next: string[] }>('POST', '/schedules/preview', w),
};

/** One WebSocket to the engine; reconnects with backoff. Returns an unsubscribe function. */
export function subscribe(onEvent: (e: ServerEvent) => void, onStatus: (up: boolean) => void): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  let delay = 500;
  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/events`);
    ws.onopen = () => {
      delay = 500;
      onStatus(true);
    };
    ws.onmessage = (m) => onEvent(JSON.parse(m.data as string) as ServerEvent);
    ws.onclose = () => {
      onStatus(false);
      if (!closed) setTimeout(connect, (delay = Math.min(delay * 2, 8000)));
    };
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
