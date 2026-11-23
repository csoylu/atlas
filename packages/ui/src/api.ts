import type { ClientEvent, PaneSees, About, Account, Agent, Card, CardStatus, ChatGptModel, ChatGptStatus, ChatUsage, ClaudePlanModel, ClaudePlanStatus, ClearEvent, CompactResult, CreateAccount, CreateAgent, CreateCard, CreateModel, CreatePlanAccount, CreateWorkflow, Doc, DocContent, DocHit, PostComment, DocVersion, FileChange, Folder, Inbox, LocalModel, LocalPull, LocalStatus, Memory, MemoryBudget, MemoryChange, MemoryProposal, MemoryQuery, Message, Model, ModelTest, Notification, PanelTab, PlanProvider, WsListing, WsFile, WsStat, WsSaveResult, SaveWsFile, RewindPreview, RewindResult, Run, CreateSecret, SecretInfo, SecretList, SecretStoreStatus, UpdateSecret, SaveWorkflowGraph, ServerEvent, Settings, Timeline, ToolCallTiming, UpdateAccount, UpdateAgent, UpdateChatGpt, UpdateClaudePlan, UpdateLocal, UpdateMemory, UpdateModel, UpdatePlanAccount, UpdateStatus, UpdateVoice, Upload, UsageSummary, VoiceName, VoiceStatus, TriggerPreview, UpdateWorkflow, Workflow, WorkflowRun, WorkflowField, WorkflowRunContext, TaskWorkflow, RunWorkflow, Project, CreateProject, UpdateProject, UpdateMember, NetworkRefusal, NetworkPending, SandboxStatus, RepoCheck, WebhookInfo, TryCondition, ConditionTryResult, BrowserTab, BrowserStatus, BrowserShot, BrowserInspected, BrowserBounds } from '@atlas/shared';

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
  /** comments: the notes made in comment mode on the pane (#304); `pane`: the open pane tab, the eye on (#305); null = the pane closed or the eye off. */
  postMessage: (id: string, text: string, uploads?: string[], comments?: PostComment[], pane: PaneSees | null = null) =>
    call<Message>('POST', `/cards/${id}/messages`, { text, ...(uploads?.length ? { uploads } : {}), ...(comments?.length ? { comments } : {}), pane }),
  /** What the chat's pane shows now (#305): a voice message, which has no composer, is sent with it. */
  reportPane: (id: string, pane: PaneSees | null) => call<void>('PUT', `/cards/${id}/pane`, { pane }),
  /**
   * Stage a pasted/dropped/picked file (#348: any kind); its id goes with the next message. An XHR, for its progress
   * (`onProgress`: bytes sent) and `abort` (× on an uploading chip: `done` rejects with an AbortError).
   */
  uploadFile: (id: string | null, file: File, onProgress?: (loaded: number) => void): { done: Promise<Upload>; abort(): void } => {
    const xhr = new XMLHttpRequest();
    const done = new Promise<Upload>((resolve, reject) => {
      // No task yet (the New task dialog): staged without one, attached by createCard({ uploads }).
      xhr.open('POST', `${id ? `/api/cards/${id}/uploads` : '/api/uploads'}?name=${encodeURIComponent(file.name || 'file')}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
      xhr.onabort = () => reject(new DOMException('upload cancelled', 'AbortError'));
      xhr.onerror = () => reject(new ApiError('the upload failed. Remove it (×) and attach it again', 0, {}));
      xhr.onload = () => {
        let body: Upload & { error?: string };
        try {
          body = JSON.parse(xhr.responseText) as Upload & { error?: string };
        } catch {
          body = {} as Upload & { error?: string };
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new ApiError(body.error || `the upload failed (HTTP ${xhr.status}). Remove it (×) and attach it again`, xhr.status, body as unknown as Record<string, unknown>));
      };
      xhr.send(file);
    });
    return { done, abort: () => xhr.abort() };
  },
  /** A staged file removed before it was sent: its file goes now (else pruned after a day). */
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
  // ── The chat's browser (#298 S6, #306) ──
  browserStatus: () => call<BrowserStatus>('GET', '/browser'),
  browserTabs: () => call<BrowserTab[]>('GET', '/browser/tabs'),
  browserTab: (chatId: string) => call<BrowserTab | null>('GET', `/browser/tabs/${chatId}`),
  browserOpen: (chatId: string, url: string, via: 'link' | 'typed' = 'typed') => call<BrowserTab>('POST', `/browser/tabs/${chatId}/open`, { url, via }),
  browserCreate: (chatId: string) => call<BrowserTab>('POST', `/browser/tabs/${chatId}/create`, {}),
  browserFocus: (chatId: string) => call<BrowserTab>('POST', `/browser/tabs/${chatId}/focus`, {}),
  browserNav: (chatId: string, action: 'back' | 'forward' | 'reload' | 'stop') => call<BrowserTab>('POST', `/browser/tabs/${chatId}/nav`, { action }),
  browserOwner: (chatId: string, owner: 'agent' | 'master') => call<BrowserTab>('POST', `/browser/tabs/${chatId}/owner`, { owner }),
  browserClose: (chatId: string) => call<void>('DELETE', `/browser/tabs/${chatId}`),
  browserShot: (chatId: string) => call<BrowserShot>('GET', `/browser/tabs/${chatId}/shot`),
  browserInspect: (chatId: string, box: { x: number; y: number; w: number; h: number }) => call<BrowserInspected>('POST', `/browser/tabs/${chatId}/inspect`, box),
  browserView: (chatId: string | null, bounds: BrowserBounds | null) => call<void>('PUT', '/browser/view', { chatId, bounds }),
  // ── Files of the chat's agent workspace (#303) ──
  panelOpenFile: (chatId: string, path: string, line: number | null = null) => call<PanelTab[]>('POST', `/chats/${chatId}/panel/file/open`, { path, line }),
  /** A link to a file Atlas serves (#339): its artifact or (in the chat's workspace) its file, in the panel; else 404. */
  panelOpenLink: (chatId: string, url: string) => call<PanelTab[]>('POST', `/chats/${chatId}/panel/link`, { url }),
  panelCloseFile: (chatId: string, path: string) => call<PanelTab[]>('POST', `/chats/${chatId}/panel/file/close`, { path }),
  panelFocusFile: (chatId: string, path: string) => call<PanelTab[]>('POST', `/chats/${chatId}/panel/file/focus`, { path }),
  filesList: (chatId: string, dir: string) => call<WsListing>('GET', `/chats/${chatId}/files/list?dir=${encodeURIComponent(dir)}`),
  fileRead: (chatId: string, path: string) => call<WsFile>('GET', `/chats/${chatId}/files/read?path=${encodeURIComponent(path)}`),
  fileStat: (chatId: string, path: string) => call<WsStat>('GET', `/chats/${chatId}/files/stat?path=${encodeURIComponent(path)}`),
  /** A workspace file as itself (#348: Files' « can't be shown » card): in a browser tab, or downloaded. */
  fileRawUrl: (chatId: string, path: string, download = false) => `/api/chats/${encodeURIComponent(chatId)}/files/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`,
  fileImageUrl: (chatId: string, path: string, stamp: string) => `/api/chats/${chatId}/files/image?path=${encodeURIComponent(path)}&v=${encodeURIComponent(stamp)}`,
  filesFind: (chatId: string, q: string) => call<{ paths: string[]; truncated: boolean }>('GET', `/chats/${chatId}/files/find?q=${encodeURIComponent(q)}`),
  fileLinks: (chatId: string, paths: string[]) => call<Record<string, string | null>>('POST', `/chats/${chatId}/files/links`, { paths }),
  fileSave: (chatId: string, s: SaveWsFile) => call<WsSaveResult>('POST', `/chats/${chatId}/files/save`, s),
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
  /** The value of the secret a blocked task waits for (#297): stored, granted to its agent, the task restarts. 204. */
  saveCardSecret: (id: string, value: string) => call<void>('POST', `/cards/${id}/secret`, { value }),
  agents: () => call<Agent[]>('GET', '/agents'),
  chats: () => call<Card[]>('GET', '/chats'),
  /** « Mark as read » and « Mark all as read » (#338). */
  readChat: (id: string) => call<{ ok: true }>('POST', `/chats/${id}/read`),
  readAllChats: () => call<{ ok: true }>('POST', '/chats/read'),
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
  createModel: (m: CreateModel) => call<Model>('POST', '/models', m),
  updateModel: (id: string, patch: UpdateModel) => call<Model>('PATCH', `/models/${id}`, patch),
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
  /** check: also ask Homebrew for a newer Ollama (when the page opens, #326). */
  local: (check = false) => call<LocalStatus>('GET', '/local' + (check ? '?check=1' : '')),
  upgradeLocal: () => call<LocalStatus>('POST', '/local/update'),
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
  // ── Settings → Workspaces (#308, #298 §2.5) ──
  sandbox: () => call<SandboxStatus>('GET', '/sandbox'),
  updateMember: (id: string, agentId: string, patch: UpdateMember) => call<Project>('PATCH', `/projects/${id}/members/${agentId}`, patch),
  refusals: (id: string) => call<NetworkRefusal[]>('GET', `/projects/${id}/refusals`),
  networkPending: (id: string) => call<NetworkPending[]>('GET', `/projects/${id}/pending`),
  clearBrowserData: (id: string, agentId: string) => call<void>('POST', `/projects/${id}/members/${agentId}/browser-data/clear`),
  workflows: (archived = false) => call<Workflow[]>('GET', '/workflows' + (archived ? '?archived=1' : '')),
  createWorkflow: (w: CreateWorkflow) => call<Workflow>('POST', '/workflows', w),
  saveWorkflowGraph: (id: string, g: SaveWorkflowGraph) => call<Workflow>('PUT', `/workflows/${id}/graph`, g),
  updateWorkflow: (id: string, patch: UpdateWorkflow) => call<Workflow>('PATCH', `/workflows/${id}`, patch),
  deleteWorkflow: (id: string) => call<void>('DELETE', `/workflows/${id}`),
  runWorkflow: (id: string, on: RunWorkflow = {}) => call<WorkflowRun>('POST', `/workflows/${id}/run`, on),
  workflowFields: (id: string, node?: string) => call<WorkflowField[]>('GET', `/workflows/${id}/fields` + (node ? `?node=${encodeURIComponent(node)}` : '')),
  workflowRunContext: (id: string) => call<WorkflowRunContext>('GET', `/workflow-runs/${id}/context`),
  cardWorkflows: (id: string) => call<TaskWorkflow[]>('GET', `/cards/${encodeURIComponent(id)}/workflows`),
  workflowRuns: (id: string) => call<WorkflowRun[]>('GET', `/workflows/${id}/runs`),
  workflowRun: (id: string) => call<WorkflowRun>('GET', `/workflow-runs/${id}`),
  stopWorkflowRun: (id: string) => call<WorkflowRun>('POST', `/workflow-runs/${id}/stop`),
  /** A step that couldn't run (#261): try it again now, or take its negative exit. */
  retryWorkflowRun: (id: string) => call<WorkflowRun>('POST', `/workflow-runs/${id}/retry`),
  followWorkflowRun: (id: string) => call<WorkflowRun>('POST', `/workflow-runs/${id}/follow`),
  /** Master approves the command steps of that revision, or rejects them (the workflow turns off), #273. */
  /** « Reset to default » of a project's Review workflow (#263). */
  resetWorkflow: (id: string) => call<Workflow>('POST', `/workflows/${id}/reset`),
  /** « Turn it on » (#263): the project's Review workflow on, or made again if deleted. */
  turnOnReview: (projectId: string) => call<Workflow>('POST', `/projects/${projectId}/review-workflow`),
  /** « Validate by hand » (#263): Master validates and merges the task's PR at `sha`, same gate as the terminal. */
  validateByHand: (cardId: string, sha: string) => call<{ result: string[]; card: Card }>('POST', `/cards/${cardId}/validate`, { sha }),
  approveWorkflow: (id: string, revision: number) => call<Workflow>('POST', `/workflows/${id}/approve`, { revision }),
  rejectWorkflow: (id: string) => call<Workflow>('POST', `/workflows/${id}/reject`),
  tryCondition: (id: string, t: TryCondition) => call<ConditionTryResult>('POST', `/workflows/${id}/try-condition`, t),
  /** Next firings of a draft time trigger; a bad cron or zone rejects with the reason. */
  webhook: (id: string) => call<WebhookInfo>('GET', `/workflows/${id}/hook`),
  webhookSeen: (id: string) => call<{ ok: true }>('POST', `/workflows/${id}/hook/seen`),
  regenerateWebhook: (id: string) => call<WebhookInfo>('POST', `/workflows/${id}/hook/regenerate`),
  previewTrigger: (t: TriggerPreview) => call<{ timezone: string; next: string[] }>('POST', '/workflows/preview', t),
};

/** One WebSocket to the engine; reconnects with backoff. Returns an unsubscribe function. */
export function subscribe(onEvent: (e: ServerEvent) => void, onStatus: (up: boolean) => void): () => void {
  let ws: WebSocket | undefined;
  socket = { send: (e) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(e)) };
  let closed = false;
  let delay = 500;
  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/events`);
    ws.onopen = () => {
      delay = 500;
      // A new socket is a new viewer for the engine: say again which chat this window shows.
      if (viewingNow !== undefined) socket?.send({ type: 'viewing', chatId: viewingNow });
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
    socket = null;
    ws?.close();
  };
}

let socket: { send(e: ClientEvent): void } | null = null;
let viewingNow: string | null | undefined;
/**
 * The chat this window has on screen while Atlas is focused (#338), null for none: the engine marks it read and never
 * turns it unread while it stays there. Sent again on every reconnect.
 */
export function setViewing(chatId: string | null): void {
  if (viewingNow === chatId) return;
  viewingNow = chatId;
  socket?.send({ type: 'viewing', chatId });
}
