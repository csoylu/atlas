import type { About, Account, Agent, Card, CardStatus, ChatGptModel, ChatGptStatus, ChatUsage, ClaudePlanModel, ClaudePlanStatus, ClearEvent, CompactResult, CreateAccount, CreateAgent, CreateCard, CreateModelRequest, CreatePlanAccount, CreateWorkflow, Doc, DocContent, DocHit, DocRef, DocVersion, FileChange, Folder, Inbox, LocalModel, LocalPull, LocalStatus, Memory, MemoryBudget, MemoryChange, MemoryProposal, MemoryQuery, Message, Model, ModelTest, Notification, PanelTab, PlanProvider, RewindPreview, RewindResult, Run, CreateSecret, SecretInfo, SecretList, SecretStoreStatus, UpdateSecret, SaveWorkflowGraph, ServerEvent, Settings, Timeline, ToolCallTiming, UpdateAccount, UpdateAgent, UpdateChatGpt, UpdateClaudePlan, UpdateLocal, UpdateMemory, UpdateModelRequest, UpdatePlanAccount, UpdateStatus, UpdateVoice, Upload, UsageSummary, VoiceName, VoiceStatus, TriggerPreview, UpdateWorkflow, Workflow, WorkflowRun, Project, CreateProject, UpdateProject, RepoCheck } from '@atlas/shared';

/** HTTP error with the parsed body (e.g. a 409's details). */
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
  /** `archived`: also the cards of archived projects (the project filter's « Archived »). */
  cards: (archived = false) => call<Card[]>('GET', '/cards' + (archived ? '?archived=1' : '')),
  createCard: (card: CreateCard) => call<Card>('POST', '/cards', card),
  updateCard: (id: string, patch: Partial<Pick<Card, 'title' | 'body' | 'status' | 'assignee' | 'priority' | 'parents' | 'modelId' | 'effort'>>) =>
    call<Card>('PATCH', `/cards/${id}`, patch),
  moveCard: (id: string, status: CardStatus) => call<Card>('PATCH', `/cards/${id}`, { status }),
  deleteCard: (id: string) => call<void>('DELETE', `/cards/${id}`),
  messages: (id: string) => call<Message[]>('GET', `/cards/${id}/messages`),
  postMessage: (id: string, text: string, ref?: DocRef, uploads?: string[]) =>
    call<Message>('POST', `/cards/${id}/messages`, { text, ...(ref ? { ref } : {}), ...(uploads?.length ? { uploads } : {}) }),
  /** Stage a pasted/dropped image; its id goes with the next message. */
  uploadImage: async (id: string | null, file: File): Promise<Upload> => {
    // No task yet (the New task dialog): staged without one, attached by createCard({ uploads }).
    const res = await fetch(`${id ? `/api/cards/${id}/uploads` : '/api/uploads'}?name=${encodeURIComponent(file.name || 'image')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
      credentials: 'include',
    });
    const body = (await res.json().catch(() => ({}))) as Upload & { error?: string };
    if (!res.ok) throw new ApiError(body.error || `upload failed: HTTP ${res.status}`, res.status, body as unknown as Record<string, unknown>);
    return body;
  },
  /** A staged image removed before it was sent: its file goes now (else pruned after a day). */
  discardUpload: (id: string) => call<void>('DELETE', `/uploads/${encodeURIComponent(id)}`),
  /** The task's own images (#119). */
  addCardImages: (id: string, uploads: string[]) => call<Card>('POST', `/cards/${id}/images`, { uploads }),
  removeCardImage: (id: string, path: string) => call<Card>('DELETE', `/cards/${id}/images?path=${encodeURIComponent(path)}`),
  // ── Documents and the side panel ──
  documents: (cardId?: string, archived = false) => call<Doc[]>('GET', '/documents' + (cardId ? `?card=${encodeURIComponent(cardId)}` : archived ? '?archived=1' : '')),
  /** The Library with the artifacts of archived projects too (the project filter's « Archived »). */
  documentsArchived: () => call<Doc[]>('GET', '/documents?archived=1'),
  document: (id: string, version?: number) => call<DocContent>('GET', `/documents/${id}` + (version === undefined ? '' : `?version=${version}`)),
  docVersions: (id: string) => call<DocVersion[]>('GET', `/documents/${id}/versions`),
  restoreDoc: (id: string, version: number) => call<Doc>('POST', `/documents/${id}/restore/${version}`),
  pinDoc: (id: string, pinned: boolean) => call<Doc>('POST', `/documents/${id}/pin`, { pinned }),
  deleteDoc: (id: string) => call<{ id: string; versions: number; file: boolean }>('DELETE', `/documents/${id}`),
  moveDoc: (id: string, folderId: string | null) => call<Doc>('POST', `/documents/${id}/move`, { folderId }),
  searchDocs: (q: string) => call<DocHit[]>('GET', `/documents/search?q=${encodeURIComponent(q)}`),
  folders: () => call<Folder[]>('GET', '/folders'),
  createFolder: (name: string, projectId?: string) => call<Folder>('POST', '/folders', projectId ? { name, projectId } : { name }),
  renameFolder: (id: string, name: string) => call<Folder>('PATCH', `/folders/${id}`, { name }),
  deleteFolder: (id: string) => call<void>('DELETE', `/folders/${id}`),
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
  /** Composer slash commands (#99): /clear, /compact [focus]. A running agent is stopped first. */
  command: (id: string, command: 'clear' | 'compact', arg?: string) =>
    call<{ clear?: ClearEvent; compact?: CompactResult }>('POST', `/cards/${id}/command`, arg ? { command, arg } : { command }),
  undoClear: (clearId: string) => call<{ cardId: string }>('POST', `/clears/${clearId}/undo`),
  undoRewind: (rewindId: string) => call<{ files: FileChange[]; filesError: string | null }>('POST', `/rewinds/${rewindId}/undo`),
  retry: (id: string) => call<Card>('POST', `/cards/${id}/retry`),
  agents: () => call<Agent[]>('GET', '/agents'),
  chats: () => call<Card[]>('GET', '/chats'),
  newChat: (agentId: string) => call<Card>('POST', `/agents/${agentId}/chats`),
  /** `project`: its main chat in that project (#214); omitted = the default project. */
  mainChat: (agentId: string, project?: string) => call<Card>('POST', `/agents/${agentId}/main-chat` + (project ? `?project=${encodeURIComponent(project)}` : '')),
  /** A fresh main chat; the previous one stays in History (the composer's /clear clears the context instead, #99). */
  newMainChat: (agentId: string) => call<Card>('POST', `/agents/${agentId}/main-chat/new`),
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
  // ── Memory v2 (design §8): Settings → Memory, the Inbox digest ──
  memories: (q: MemoryQuery = {}) => call<Memory[]>('GET', '/memories?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()),
  memory: (id: number) => call<Memory>('GET', `/memories/${id}`),
  updateMemory: (id: number, patch: UpdateMemory) => call<Memory>('PATCH', `/memories/${id}`, patch),
  /** Changes since `since` (default: the last 24 h), newest first. */
  memoryChanges: (since?: string) => call<MemoryChange[]>('GET', '/memories/changes' + (since ? `?since=${encodeURIComponent(since)}` : '')),
  undoMemoryChange: (changeId: number) => call<Memory>('POST', `/memories/changes/${changeId}/undo`),
  memoryProposals: (cardId: string) => call<MemoryProposal[]>('GET', '/memory-proposals?cardId=' + encodeURIComponent(cardId)),
  approveProposal: (id: number) => call<MemoryProposal>('POST', `/memory-proposals/${id}/approve`),
  rejectProposal: (id: number) => call<MemoryProposal>('POST', `/memory-proposals/${id}/reject`),
  memoryBudget: (agentId: string) => call<MemoryBudget>('GET', `/agents/${agentId}/memory-budget`),
  models: () => call<Model[]>('GET', '/models'),
  createModel: (m: CreateModelRequest) => call<Model>('POST', '/models', m),
  updateModel: (id: string, patch: UpdateModelRequest) => call<Model>('PATCH', `/models/${id}`, patch),
  deleteModel: (id: string) => call<void>('DELETE', `/models/${id}`),
  testModel: (id: string) => call<ModelTest>('POST', `/models/${id}/test`),
  secrets: () => call<SecretList>('GET', '/secrets'),
  setSecret: (name: string, value: string) => call<void>('PUT', `/secrets/${name}`, { value }),
  deleteSecret: (name: string) => call<void>('DELETE', `/secrets/${name}`),
  // ── Secrets (#206–#209): metadata only, values go in and never come back ──
  createSecret: (s: CreateSecret) => call<SecretInfo>('POST', '/secrets', s),
  updateSecret: (name: string, patch: UpdateSecret) => call<SecretInfo>('PATCH', `/secrets/${name}`, patch),
  secretsStatus: () => call<SecretStoreStatus>('GET', '/secrets/status'),
  unlockSecrets: (password: string) => call<SecretStoreStatus>('POST', '/secrets/unlock', { password }),
  lockSecrets: () => call<SecretStoreStatus>('POST', '/secrets/lock'),
  secretsPassword: (p: { current?: string; next: string }) => call<SecretStoreStatus>('POST', '/secrets/password', p),
  settings: () => call<Settings>('GET', '/settings'),
  about: () => call<About>('GET', '/about'),
  // ── App updates (#123) ──
  update: () => call<UpdateStatus>('GET', '/update'),
  checkUpdate: () => call<UpdateStatus>('POST', '/update/check'),
  installUpdate: () => call<UpdateStatus>('POST', '/update/install'),
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
  // ── Workflows (#170; the Schedules page shows the one-step ones) ──────
  // ── Projects (#213, #214) ──
  /** Every project, archived ones too: the UI filters. */
  projects: () => call<Project[]>('GET', '/projects?archived=1'),
  createProject: (p: CreateProject) => call<Project>('POST', '/projects', p),
  updateProject: (id: string, patch: UpdateProject) => call<Project>('PATCH', `/projects/${id}`, patch),
  archiveProject: (id: string) => call<Project>('POST', `/projects/${id}/archive`),
  restoreProject: (id: string) => call<Project>('POST', `/projects/${id}/restore`),
  repoCheck: (repo: string) => call<RepoCheck>('GET', `/projects/repo-check?repo=${encodeURIComponent(repo)}`),
  retryClone: (id: string, agentId: string) => call<Project>('POST', `/projects/${id}/members/${agentId}/retry`),
  deleteKept: (id: string, agentId: string) => call<Project>('DELETE', `/projects/${id}/kept/${agentId}`),
  workflows: (archived = false) => call<Workflow[]>('GET', '/workflows' + (archived ? '?archived=1' : '')),
  createWorkflow: (w: CreateWorkflow) => call<Workflow>('POST', '/workflows', w),
  saveWorkflowGraph: (id: string, g: SaveWorkflowGraph) => call<Workflow>('PUT', `/workflows/${id}/graph`, g),
  updateWorkflow: (id: string, patch: UpdateWorkflow) => call<Workflow>('PATCH', `/workflows/${id}`, patch),
  deleteWorkflow: (id: string) => call<void>('DELETE', `/workflows/${id}`),
  runWorkflow: (id: string) => call<WorkflowRun>('POST', `/workflows/${id}/run`),
  workflowRuns: (id: string) => call<WorkflowRun[]>('GET', `/workflows/${id}/runs`),
  workflowRun: (id: string) => call<WorkflowRun>('GET', `/workflow-runs/${id}`),
  stopWorkflowRun: (id: string) => call<WorkflowRun>('POST', `/workflow-runs/${id}/stop`),
  /** Next firings of a draft time trigger; a bad cron or zone rejects with the reason. */
  previewTrigger: (t: TriggerPreview) => call<{ timezone: string; next: string[] }>('POST', '/workflows/preview', t),
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
