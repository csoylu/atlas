/** Settings: one page with a grouped sub-navigation (design §12). Each page lives at #/settings/<id>. */
export const SETTINGS_GROUPS = [
  { title: 'Team', pages: [{ id: 'projects', label: 'Projects' }, { id: 'agents', label: 'Agents' }, { id: 'memory', label: 'Memory' }, { id: 'board', label: 'Board & triage' }, { id: 'secrets', label: 'Secrets' }] },
  {
    title: 'Models',
    pages: [
      { id: 'subscriptions', label: 'Subscriptions' },
      { id: 'api-keys', label: 'API keys' },
      { id: 'local', label: 'Local (Ollama)' },
      { id: 'model-list', label: 'Model list' },
    ],
  },
  { title: 'Insight', pages: [{ id: 'usage', label: 'Usage' }] },
  { title: 'App', pages: [{ id: 'profile', label: 'About you' }, { id: 'appearance', label: 'Appearance' }, { id: 'voice', label: 'Voice' }, { id: 'about', label: 'About & data' }] },
] as const;

export type SettingsPage = (typeof SETTINGS_GROUPS)[number]['pages'][number]['id'];
export const SETTINGS_PAGES: { id: SettingsPage; label: string }[] = SETTINGS_GROUPS.flatMap((g) => [...g.pages]);
/** Never throws: an unknown page (stale hash, old localStorage) reads as the first page, where the route sends it. */
/** An unknown page is labelled like the page it opens: Agents (Projects is listed first but isn't the default, #217). */
export const settingsLabel = (p: string) => (SETTINGS_PAGES.find((x) => x.id === p) ?? SETTINGS_PAGES.find((x) => x.id === 'agents')!).label;

/** Hashes from before the restructure (#/agents, #/models, #/settings/board, #/settings/canvas…) → their new page. */
const LEGACY: Record<string, SettingsPage> = { models: 'subscriptions', canvas: 'appearance' };

/**
 * The settings page a hash points to, or null when it isn't a settings hash. `view` and `id` are the hash's first two
 * segments (#/view/id). An unknown or missing page opens Agents.
 */
export function settingsPageOf(view: string | undefined, id: string | undefined): SettingsPage | null {
  if (view === 'agents') return 'agents';
  if (view === 'models') return 'subscriptions';
  if (view !== 'settings') return null;
  const known = SETTINGS_PAGES.find((p) => p.id === id);
  return known ? known.id : (LEGACY[id ?? ''] ?? 'agents');
}

/**
 * The settings route of a hash path (« #/settings/memory/m12 », no « ?… »), or null when it isn't one: its page, what
 * follows #/settings/memory (a scope or m12, decoded) and the canonical path to rewrite the hash to. The Memory page
 * moved from the Library (#87): old #/library/memory… links (posted Inbox digests) land on Settings → Memory.
 */
export function settingsRoute(path: string): { page: SettingsPage; rest: string; path: string } | null {
  const [, view, id, ...more] = path.split('/');
  if ((view === 'library' || view === 'settings') && id === 'memory') {
    const raw = more.join('/');
    return { page: 'memory', rest: more.map(decodeURIComponent).join('/'), path: '#/settings/memory' + (raw ? '/' + raw : '') };
  }
  // A project's page (#217): #/settings/projects/<id>[/repo].
  if (view === 'settings' && id === 'projects' && more.length) return { page: 'projects', rest: more.map(decodeURIComponent).join('/'), path: '#/settings/projects/' + more.join('/') };
  const page = settingsPageOf(view, id);
  return page ? { page, rest: '', path: '#/settings/' + page } : null;
}
