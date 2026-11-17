import { useCallback, useEffect, useState } from 'react';
import type { About, Agent, Card, ChatGptStatus, Model, Settings } from '@atlas/shared';
import { api } from './api.ts';
import { AgentsView } from './AgentsView.tsx';
import { MemoryPage } from './MemoryPage.tsx';
import { AccountsSection } from './AccountsSection.tsx';
import { ChatGptSection } from './ChatGptSection.tsx';
import { ClaudePlanSection } from './ClaudePlanSection.tsx';
import { LocalModels } from './LocalModels.tsx';
import { ModelListSection } from './ModelSections.tsx';
import { UsageSection } from './Usage.tsx';
import { ProfileSettings } from './Profile.tsx';
import { VoiceSettings } from './VoiceSettings.tsx';
import { SETTINGS_GROUPS, type SettingsPage } from './settingsPages.ts';
import { THEMES, type ThemeChoice } from './theme.ts';
import type { MessageStream } from './useMessages.ts';

/**
 * Settings (design §12): a second navigation inside the sheet, grouped (Team, Models, Insight, App), and the page on
 * the right. Each page reuses the section components that used to live on the Agents and Models pages.
 */
export function SettingsView(props: {
  page: SettingsPage;
  /** What follows #/settings/memory: a scope (« agent:atlas »), a memory (« m12 ») or nothing. */
  memoryRest: string;
  cards: Card[];
  chats: Card[];
  stream: MessageStream;
  settings: Settings | null;
  agents: Agent[];
  models: Model[];
  chatgpt: ChatGptStatus | null;
  theme: ThemeChoice;
  onTheme(t: ThemeChoice): void;
  onSettings(s: Settings): void;
  onAgentsChanged(): void;
  onModelsChanged(): void;
  onError(e: unknown): void;
}) {
  const { page, stream, onError } = props;
  const go = (p: SettingsPage) => (location.hash = '#/settings/' + p);

  // Counts in the sub-navigation, and the key store the subscription and API key sections mention.
  const [claudeAccounts, setClaudeAccounts] = useState<number | null>(null);
  const [apiKeys, setApiKeys] = useState<number | null>(null);
  const [keyStore, setKeyStore] = useState<string | null>(null);
  // Voice exists only in the desktop app (About.voice): hidden from the navigation elsewhere.
  const [voice, setVoice] = useState(false);
  const groups = SETTINGS_GROUPS.map((g) => ({ ...g, pages: g.pages.filter((p) => p.id !== 'voice' || voice) }));
  const loadCounts = useCallback(() => {
    api.claude().then((c) => setClaudeAccounts(c.accounts.length), onError);
    api.accounts().then((a) => setApiKeys(a.length), onError);
  }, [onError]);
  useEffect(() => {
    loadCounts();
    api.secrets().then((s) => setKeyStore(s.store), onError);
    api.about().then((a) => setVoice(a.voice), onError);
    return stream.listen('claude', (e) => {
      if (e.type === 'claude') setClaudeAccounts(e.status.accounts.length);
    });
  }, [loadCounts, stream, onError]);
  const modelsChanged = () => {
    loadCounts();
    props.onModelsChanged();
  };

  const counts: Partial<Record<SettingsPage, number | null>> = {
    agents: props.agents.length,
    subscriptions: claudeAccounts === null || !props.chatgpt ? null : claudeAccounts + props.chatgpt.accounts.length,
    'api-keys': apiKeys,
    'model-list': props.models.length,
  };

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings">
        {groups.map((g) => (
          <div key={g.title} className="settings-group" role="group" aria-label={g.title}>
            <div className="settings-group-title">{g.title}</div>
            {g.pages.map((p) => (
              <a
                key={p.id}
                href={'#/settings/' + p.id}
                className={'nav-item' + (page === p.id ? ' active' : '')}
                aria-current={page === p.id ? 'page' : undefined}
              >
                <span>{p.label}</span>
                {counts[p.id] != null && <span className="settings-count">{counts[p.id]}</span>}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-main">
        <div className="settings-select">
          <select aria-label="Settings page" value={page} onChange={(e) => go(e.target.value as SettingsPage)}>
            {groups.map((g) => (
              <optgroup key={g.title} label={g.title}>
                {g.pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {counts[p.id] != null ? ` (${counts[p.id]})` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        {page === 'memory' ? (
          // Memory (#87, from the Library): a full-height list with its own scroller, not a padded settings column.
          <div className="settings-view settings-memory">
            <MemoryPage rest={props.memoryRest} agents={props.agents} cards={props.cards} chats={props.chats} stream={stream} settings={props.settings} models={props.models} onSettings={props.onSettings} onError={onError} />
          </div>
        ) : (
        <div className="agents-view settings-view" key={page}>
          {page === 'agents' ? (
            <AgentsView settings={props.settings} onSettings={props.onSettings} onAgentsChanged={props.onAgentsChanged} onError={onError} />
          ) : page === 'board' ? (
            <BoardSettings settings={props.settings} agents={props.agents} onSettings={props.onSettings} onError={onError} />
          ) : page === 'subscriptions' ? (
            <>
              <ClaudePlanSection stream={stream} keyStore={keyStore} onChanged={modelsChanged} onError={onError} />
              <ChatGptSection status={props.chatgpt} onChanged={modelsChanged} onError={onError} />
            </>
          ) : page === 'api-keys' ? (
            <AccountsSection keyStore={keyStore} onChanged={modelsChanged} onError={onError} />
          ) : page === 'local' ? (
            <div className="models-view">
              <LocalModels stream={stream} agents={props.agents} onModelsChanged={modelsChanged} onError={onError} />
            </div>
          ) : page === 'model-list' ? (
            <ModelListSection stream={stream} chatgpt={props.chatgpt} onChanged={modelsChanged} onError={onError} />
          ) : page === 'usage' ? (
            <UsageSection stream={stream} onError={onError} />
          ) : page === 'profile' ? (
            <ProfileSettings settings={props.settings} onSettings={props.onSettings} />
          ) : page === 'appearance' ? (
            <Appearance theme={props.theme} onTheme={props.onTheme} />
          ) : page === 'voice' ? (
            voice ? (
              <VoiceSettings stream={stream} onError={onError} />
            ) : (
              <section>
                <header className="section-head">
                  <h2>Voice</h2>
                  <p>Voice mode runs on the Mac with the Atlas desktop app: open Settings → Voice there.</p>
                </header>
              </section>
            )
          ) : (
            <AboutData onError={onError} />
          )}
        </div>
        )}
      </div>
    </div>
  );
}

function BoardSettings(props: { settings: Settings | null; agents: Agent[]; onSettings(s: Settings): void; onError(e: unknown): void }) {
  return (
    <section>
      <header className="section-head">
        <h2>Board &amp; triage</h2>
        <p>Choose who turns ideas in Triage into actionable tasks.</p>
      </header>
      {props.settings ? (
        <label className="field settings-field">
          Triage agent
          <select
            value={props.settings.triageAgent ?? ''}
            onChange={(e) => {
              api.updateSettings({ triageAgent: e.target.value || null }).then(props.onSettings, props.onError);
            }}
          >
            <option value="">Nobody</option>
            {props.agents.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.id}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="hint">Waiting for engine settings…</p>
      )}
      <p className="hint">Nobody leaves triage tasks for you to organize manually.</p>
    </section>
  );
}

function Appearance(props: { theme: ThemeChoice; onTheme(t: ThemeChoice): void }) {
  return (
    <section>
      <header className="section-head">
        <h2>Appearance</h2>
        <p>Theme for this device, across Atlas. Auto follows your system.</p>
      </header>
      <label className="field settings-field">
        Theme
        <select value={props.theme} onChange={(e) => props.onTheme(e.target.value as ThemeChoice)}>
          {THEMES.map((t) => (
            <option key={t} value={t}>
              {t === 'system' ? 'Auto' : t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

function AboutData({ onError }: { onError(e: unknown): void }) {
  const [about, setAbout] = useState<About | null>(null);
  useEffect(() => {
    api.about().then(setAbout, onError);
  }, [onError]);
  return (
    <section>
      <header className="section-head">
        <h2>About &amp; data</h2>
        <p>Everything Atlas keeps (database, agent workspaces, canvases) is in its data folder on the engine's machine.</p>
      </header>
      {about ? (
        <dl className="about-list">
          <dt>Version</dt>
          <dd className="num">{about.version}</dd>
          <dt>Runs as</dt>
          <dd>{about.server ? 'Server (login required)' : 'Desktop app on this machine'}</dd>
          <dt>Data folder</dt>
          <dd>
            <code>{about.dataDir}</code>
          </dd>
        </dl>
      ) : (
        <div className="model-row skeleton" />
      )}
    </section>
  );
}
