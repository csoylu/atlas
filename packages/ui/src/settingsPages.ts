/** Settings: one page with a grouped sub-navigation (design §12). Each page lives at #/settings/<id>. */
export const SETTINGS_GROUPS = [
  { title: 'Team', pages: [{ id: 'agents', label: 'Agents' }, { id: 'memory', label: 'Shared memory' }, { id: 'board', label: 'Board & triage' }] },
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
export const settingsLabel = (p: string) => (SETTINGS_PAGES.find((x) => x.id === p) ?? SETTINGS_PAGES[0]!).label;

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
