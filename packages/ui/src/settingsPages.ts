/**
 * Settings: one page with a grouped sub-navigation (design §12, redesign #272). Each page lives at #/settings/<id>;
 * #/settings alone is the list of pages (the phone's settings screen; a wide window opens the last page instead).
 */
export const SETTINGS_GROUPS = [
  { title: 'Team', pages: [{ id: 'projects', label: 'Projects' }, { id: 'agents', label: 'Agents' }, { id: 'memory', label: 'Memory' }, { id: 'board', label: 'Board & triage' }, { id: 'secrets', label: 'Secrets' }] },
  { title: 'Models', pages: [{ id: 'models', label: 'Models & accounts' }] },
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

/**
 * Models & accounts (#272): today's four model pages are the four sections of one page, chosen by a row of links at
 * its top (#/settings/models/<section>), so each stays one click away. The first one is the default.
 */
export const MODEL_SECTIONS = [
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'api-keys', label: 'API keys' },
  { id: 'local', label: 'Local (Ollama)' },
  { id: 'model-list', label: 'Model list' },
] as const;
export type ModelSection = (typeof MODEL_SECTIONS)[number]['id'];
export const modelSectionOf = (rest: string): ModelSection => MODEL_SECTIONS.find((s) => s.id === rest)?.id ?? 'subscriptions';
export const modelsHref = (s: ModelSection) => '#/settings/models' + (s === 'subscriptions' ? '' : '/' + s);

/** Hashes from before a restructure → their page and what follows it (#/settings/api-keys → models, api-keys). */
const LEGACY: Record<string, { page: SettingsPage; rest: string }> = {
  canvas: { page: 'appearance', rest: '' },
  subscriptions: { page: 'models', rest: '' },
  'api-keys': { page: 'models', rest: 'api-keys' },
  local: { page: 'models', rest: 'local' },
  'model-list': { page: 'models', rest: 'model-list' },
};

/**
 * The settings page a hash points to, or null when it isn't a settings hash. `view` and `id` are the hash's first two
 * segments (#/view/id). An unknown or missing page opens Agents.
 */
export function settingsPageOf(view: string | undefined, id: string | undefined): SettingsPage | null {
  if (view === 'agents') return 'agents';
  if (view === 'models') return 'models';
  if (view !== 'settings') return null;
  const known = SETTINGS_PAGES.find((p) => p.id === id);
  return known ? known.id : (LEGACY[id ?? '']?.page ?? 'agents');
}

export type SettingsRoute = {
  page: SettingsPage;
  /** What follows the page: a memory scope or m12, a project id, an agent id, a models section. */
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
  if (view === 'models' || (view === 'settings' && id === 'models')) {
    const s = modelSectionOf(view === 'models' ? '' : (more[0] ?? ''));
    return { page: 'models', rest: s === 'subscriptions' ? '' : s, path: modelsHref(s) };
  }
  const legacy = view === 'settings' ? LEGACY[id ?? ''] : undefined;
  if (legacy) return { page: legacy.page, rest: legacy.rest, path: legacy.page === 'models' ? modelsHref(modelSectionOf(legacy.rest)) : '#/settings/' + legacy.page };
  const page = settingsPageOf(view, id);
  return page ? { page, rest: '', path: '#/settings/' + page } : null;
}

/**
 * « Find a setting » (#272): page names plus a short fixed list of words per page, never an index of every control.
 * Returns the pages that match, in navigation order; an empty query matches every page.
 */
const KEYWORDS: Partial<Record<SettingsPage, string[]>> = {
  projects: ['repo', 'github', 'members', 'changelog'],
  agents: ['role', 'model', 'parallel', 'folder', 'workspace', 'enable', 'new agent'],
  memory: ['rules', 'preferences', 'facts', 'task notes', 'background review', 'pin', 'archive'],
  board: ['triage', 'review', 'reviewer', 'qa'],
  secrets: ['token', 'password', 'env', 'grant', 'keychain'],
  models: ['subscriptions', 'claude', 'chatgpt', 'api keys', 'anthropic', 'openai', 'ollama', 'local', 'model list', 'accounts'],
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
