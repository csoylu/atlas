/**
 * Settings: one page with a grouped sub-navigation (design §12, redesign #272, remake #307). Each page lives at
 * #/settings/<id>; #/settings alone is the list of pages (the phone's settings screen; a wide window opens the last
 * page instead). The four model pages are pages of their own again (#307): no « Models & accounts » tab strip.
 */
export const SETTINGS_GROUPS = [
  { title: 'Team', pages: [{ id: 'projects', label: 'Projects' }, { id: 'agents', label: 'Agents' }, { id: 'memory', label: 'Memory' }, { id: 'secrets', label: 'Secrets' }, { id: 'board', label: 'Board & triage' }] },
  {
    title: 'Models',
    pages: [
      { id: 'model-list', label: 'Model list' },
      { id: 'subscriptions', label: 'Subscriptions' },
      { id: 'api-keys', label: 'API keys' },
      { id: 'local', label: 'Local models' },
    ],
  },
  {
    title: 'App',
    pages: [
      { id: 'profile', label: 'About you' },
      { id: 'appearance', label: 'Appearance' },
      { id: 'voice', label: 'Voice' },
      { id: 'usage', label: 'Usage' },
      { id: 'about', label: 'About & data' },
    ],
  },
] as const;

export type SettingsPage = (typeof SETTINGS_GROUPS)[number]['pages'][number]['id'];
export const SETTINGS_PAGES: { id: SettingsPage; label: string }[] = SETTINGS_GROUPS.flatMap((g) => [...g.pages]);
/** Never throws: an unknown page (stale hash, old localStorage) is labelled like the page it opens, Agents. */
export const settingsLabel = (p: string) => (SETTINGS_PAGES.find((x) => x.id === p) ?? SETTINGS_PAGES.find((x) => x.id === 'agents')!).label;

/** The model pages, which « Models & accounts » (#272) showed as tabs: #/settings/models[/<page>] lands on them. */
const MODEL_PAGES: SettingsPage[] = ['model-list', 'subscriptions', 'api-keys', 'local'];
const modelPageOf = (rest: string | undefined): SettingsPage => MODEL_PAGES.find((p) => p === rest) ?? 'subscriptions';

/** Hashes from before a restructure → their page (#/settings/canvas → appearance). */
const LEGACY: Record<string, SettingsPage> = { canvas: 'appearance' };

/**
 * The settings page a hash points to, or null when it isn't a settings hash. `view` and `id` are the hash's first two
 * segments (#/view/id). An unknown or missing page opens Agents.
 */
export function settingsPageOf(view: string | undefined, id: string | undefined): SettingsPage | null {
  if (view === 'agents') return 'agents';
  if (view === 'models') return 'subscriptions';
  if (view !== 'settings') return null;
  const known = SETTINGS_PAGES.find((p) => p.id === id);
  return known ? known.id : id === 'models' ? 'subscriptions' : (LEGACY[id ?? ''] ?? 'agents');
}

export type SettingsRoute = {
  page: SettingsPage;
  /** What follows the page: a memory scope or m12, a project id, an agent id. */
  rest: string;
  /** The canonical path to rewrite the hash to. */
  path: string;
  /** #/settings alone: the list of pages (phone). `page` is then the page a wide window opens. */
  index?: true;
};

/**
 * The settings route of a hash path (« #/settings/memory/m12 », no « ?… »), or null when it isn't one. The Memory page
 * moved from the Library (#87): old #/library/memory… links (posted Inbox digests) land on Settings → Memory.
 */
export function settingsRoute(path: string): SettingsRoute | null {
  const [, view, id, ...more] = path.split('/');
  if ((view === 'library' || view === 'settings') && id === 'memory') {
    const raw = more.join('/');
    return { page: 'memory', rest: more.map(decodeURIComponent).join('/'), path: '#/settings/memory' + (raw ? '/' + raw : '') };
  }
  if (view === 'settings' && !id) return { page: 'agents', rest: '', path: '#/settings', index: true };
  // A project's page (#217): #/settings/projects/<id>[/repo]; an agent's page (#272): #/settings/agents/<id>.
  if (view === 'settings' && (id === 'projects' || id === 'agents') && more.length)
    return { page: id, rest: more.map(decodeURIComponent).join('/'), path: `#/settings/${id}/` + more.join('/') };
  // « Models & accounts » and its tabs (#272) → the model page of its own (#307).
  if (view === 'models' || (view === 'settings' && id === 'models')) {
    const page = modelPageOf(view === 'models' ? undefined : more[0]);
    return { page, rest: '', path: '#/settings/' + page };
  }
  const page = settingsPageOf(view, id);
  return page ? { page, rest: '', path: '#/settings/' + page } : null;
}

/**
 * « Find a setting » (#272): page names plus a short fixed list of words per page, never an index of every control.
 * Returns the pages that match, in navigation order; an empty query matches every page.
 */
const KEYWORDS: Partial<Record<SettingsPage, string[]>> = {
  projects: ['repo', 'github', 'members', 'changelog'],
  agents: ['role', 'model', 'tasks at once', 'parallel', 'folder', 'workspace', 'enable', 'new agent'],
  memory: ['rules', 'preferences', 'facts', 'task notes', 'background review', 'pin', 'archive'],
  board: ['triage', 'review', 'reviewer', 'qa'],
  secrets: ['token', 'password', 'env', 'grant', 'keychain'],
  'model-list': ['models', 'available', 'limits', 'add a model'],
  subscriptions: ['claude', 'chatgpt', 'plan', 'sign in', 'accounts'],
  'api-keys': ['anthropic', 'openai', 'accounts', 'key'],
  local: ['ollama', 'llama', 'download', 'installed'],
  profile: ['name', 'profile'],
  appearance: ['theme', 'dark', 'light', 'auto'],
  voice: ['speech', 'microphone', 'wake word'],
  usage: ['tokens', 'cost', 'calls', 'limits'],
  about: ['version', 'updates', 'data folder', 'path', 'shell'],
};
export function findSettings(query: string, pages: readonly { id: SettingsPage; label: string }[] = SETTINGS_PAGES): SettingsPage[] {
  const q = query.trim().toLowerCase();
  if (!q) return pages.map((p) => p.id);
  return pages.filter((p) => [p.label.toLowerCase(), ...(KEYWORDS[p.id] ?? [])].some((w) => w.includes(q))).map((p) => p.id);
}
