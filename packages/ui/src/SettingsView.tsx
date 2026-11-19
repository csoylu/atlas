import { useCallback, useEffect, useState } from 'react';
import type { About, ShellPathInfo, UpdateStatus, Agent, Card, ChatGptStatus, Model, SecretStoreStatus, Settings, Workflow } from '@atlas/shared';
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
import { SecretsPage } from './SecretsPage.tsx';
import { VoiceSettings } from './VoiceSettings.tsx';
import { findSettings, MODEL_SECTIONS, modelSectionOf, modelsHref, SETTINGS_GROUPS, SETTINGS_PAGES, type ModelSection, type SettingsPage } from './settingsPages.ts';
import { HeaderActions, Icon } from './ScreenHeader.tsx';
import { ProjectsPage } from './ProjectsPage.tsx';
import { useProjects } from './projects.tsx';
import { THEMES, type ThemeChoice } from './theme.ts';
import type { MessageStream } from './useMessages.ts';
import { UpdateAbout } from './UpdateDialog.tsx';
import { Skeleton } from './Kit.tsx';

/**
 * Settings (design §12, redesign #272 « Agents » / « Memory »): one header (« Settings » and « Find a setting »), a
 * grouped navigation (Team, Models, App) and the page. On a narrow window #/settings is the list of pages and each page
 * has the shell's back button and its name as the title.
 */
export function SettingsView(props: {
  /** null: #/settings alone, the list of pages (a wide window opens the last page instead). */
  page: SettingsPage | null;
  narrow: boolean;
  /** What follows the page: a memory scope or m12, a project, an agent, a models section. */
  memoryRest: string;
  cards: Card[];
  chats: Card[];
  /** For Settings → Projects' counts (#217). */
  workflows: Workflow[];
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
  /** App updates (#123): Settings → About shows the version, the last check and « Check now ». */
  update: UpdateStatus | null;
  onOpenUpdate(): void;
  /** Where secret values are kept and whether the server's file is locked (#208), live. */
  secretStatus: SecretStoreStatus | null;
  onError(e: unknown): void;
}) {
  const { page, stream, onError } = props;

  // Counts in the navigation and the models section links, and the key store the subscription and API key sections mention.
  const [claudeAccounts, setClaudeAccounts] = useState<number | null>(null);
  const [apiKeys, setApiKeys] = useState<number | null>(null);
  const [keyStore, setKeyStore] = useState<string | null>(null);
  const [secretCount, setSecretCount] = useState<number | null>(null);
  // Voice exists only in the desktop app (About.voice): hidden from the navigation elsewhere.
  const [voice, setVoice] = useState(false);
  const loadCounts = useCallback(() => {
    api.claude().then((c) => setClaudeAccounts(c.accounts.length), onError);
    api.accounts().then((a) => setApiKeys(a.length), onError);
  }, [onError]);
  useEffect(() => {
    loadCounts();
    const secrets = () =>
      api.secrets().then((s) => {
        setKeyStore(s.store);
        setSecretCount(s.secrets.length);
      }, onError);
    void secrets();
    api.about().then((a) => setVoice(a.voice), onError);
    const offSecrets = stream.listen('secrets', () => void secrets());
    const offClaude = stream.listen('claude', (e) => {
      if (e.type === 'claude') setClaudeAccounts(e.status.accounts.length);
    });
    return () => {
      offSecrets();
      offClaude();
    };
  }, [loadCounts, stream, onError]);
  const modelsChanged = () => {
    loadCounts();
    props.onModelsChanged();
  };

  // A wide window has the navigation beside the page: #/settings alone opens the last page.
  useEffect(() => {
    if (page === null && !props.narrow) location.replace('#/settings/' + (localStorage.getItem('atlas.settings') ?? 'agents'));
  }, [page, props.narrow]);

  // « Find a setting »: page names and a few words per page (settingsPages.ts), never every control.
  const [find, setFind] = useState('');
  const visible = SETTINGS_PAGES.filter((p) => p.id !== 'voice' || voice);
  const found = new Set(findSettings(find, visible));
  const groups = SETTINGS_GROUPS.map((g) => ({ ...g, pages: g.pages.filter((p) => found.has(p.id)) })).filter((g) => g.pages.length);

  const projects = useProjects();
  const subscriptions = claudeAccounts === null || !props.chatgpt ? null : claudeAccounts + props.chatgpt.accounts.length;
  const counts: Partial<Record<SettingsPage, number | null>> = {
    projects: projects.active.length,
    agents: props.agents.length,
    secrets: secretCount,
    models: props.models.length,
  };

  const nav = (cls: string) => (
    <nav className={cls} aria-label="Settings">
      {groups.map((g) => (
        <div key={g.title} className="settings-group" role="group" aria-label={g.title}>
          <div className="settings-group-title">{g.title}</div>
          {g.pages.map((p) => (
            <a key={p.id} href={'#/settings/' + p.id} className={'nav-item' + (page === p.id ? ' active' : '')} aria-current={page === p.id ? 'page' : undefined}>
              <span>{p.label}</span>
              {counts[p.id] != null && <span className="settings-count">{counts[p.id]}</span>}
              {cls === 'settings-index' && <Icon.chev />}
            </a>
          ))}
        </div>
      ))}
      {!groups.length && (
        <p className="settings-none" role="status">
          No setting matches « {find.trim()} ».
        </p>
      )}
    </nav>
  );

  return (
    <div className="settings">
      {!props.narrow && (
        <HeaderActions>
          <span className="head-sp" />
          <label className="mem-search settings-find">
            <Icon.search />
            <input
              type="search"
              value={find}
              placeholder="Find a setting"
              aria-label="Find a setting"
              onChange={(e) => setFind(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setFind('');
                  e.currentTarget.blur();
                } else if (e.key === 'Enter' && find.trim()) {
                  const first = groups[0]?.pages[0];
                  if (first) {
                    location.hash = '#/settings/' + first.id;
                    setFind('');
                  }
                }
              }}
            />
          </label>
        </HeaderActions>
      )}
      {!props.narrow && nav('settings-nav')}
      {page === null ? (
        props.narrow && <div className="settings-main settings-list">{nav('settings-index')}</div>
      ) : (
        <div className="settings-main settings-view" key={page === 'projects' || page === 'agents' ? page + '/' + props.memoryRest.split('/')[0] : page}>
          <div className="setb">
            {page === 'projects' ? (
              <ProjectsPage rest={props.memoryRest} agents={props.agents} cards={props.cards} workflows={props.workflows} onError={onError} />
            ) : page === 'agents' ? (
              <AgentsView rest={props.memoryRest} settings={props.settings} cards={props.cards} chats={props.chats} onSettings={props.onSettings} onAgentsChanged={props.onAgentsChanged} onError={onError} />
            ) : page === 'memory' ? (
              <MemoryPage rest={props.memoryRest} agents={props.agents} cards={props.cards} chats={props.chats} stream={stream} settings={props.settings} models={props.models} onSettings={props.onSettings} onError={onError} />
            ) : page === 'board' ? (
              <BoardSettings settings={props.settings} agents={props.agents} onSettings={props.onSettings} onError={onError} />
            ) : page === 'secrets' ? (
              <SecretsPage agents={props.agents} cards={props.cards} models={props.models} status={props.secretStatus} userName={props.settings?.userName ?? null} stream={stream} onError={onError} />
            ) : page === 'models' ? (
              <ModelsPage
                section={modelSectionOf(props.memoryRest)}
                counts={{ subscriptions, 'api-keys': apiKeys, local: null, 'model-list': props.models.length }}
                stream={stream}
                keyStore={keyStore}
                agents={props.agents}
                chatgpt={props.chatgpt}
                onChanged={modelsChanged}
                onError={onError}
              />
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
              <AboutData update={props.update} onOpenUpdate={props.onOpenUpdate} onError={onError} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Models & accounts (#272): the four former model pages as four sections of one page, one link each at the top, so
 * API keys or the model list stay one click away (#/settings/models/<section>; the old hashes land here).
 */
function ModelsPage(props: {
  section: ModelSection;
  counts: Record<ModelSection, number | null>;
  stream: MessageStream;
  keyStore: string | null;
  agents: Agent[];
  chatgpt: ChatGptStatus | null;
  onChanged(): void;
  onError(e: unknown): void;
}) {
  const { section: s, stream, onChanged, onError } = props;
  return (
    <>
      <div className="set-head">
        <h2>Models &amp; accounts</h2>
      </div>
      <p className="set-lead">Which models your agents can use, and the plans, keys and local server they run on.</p>
      <nav className="view-tabs set-tabs" aria-label="Models & accounts">
        {MODEL_SECTIONS.map((x) => (
          <a key={x.id} href={modelsHref(x.id)} className={'tabbtn' + (s === x.id ? ' on' : '')} aria-current={s === x.id ? 'page' : undefined}>
            {x.label}
            {props.counts[x.id] != null && <span className="tab-n">{props.counts[x.id]}</span>}
          </a>
        ))}
      </nav>
      {s === 'subscriptions' ? (
        <>
          <ClaudePlanSection stream={stream} keyStore={props.keyStore} onChanged={onChanged} onError={onError} />
          <ChatGptSection status={props.chatgpt} onChanged={onChanged} onError={onError} />
        </>
      ) : s === 'api-keys' ? (
        <AccountsSection keyStore={props.keyStore} onChanged={onChanged} onError={onError} />
      ) : s === 'local' ? (
        <div className="models-view">
          <LocalModels stream={stream} agents={props.agents} onModelsChanged={onChanged} onError={onError} />
        </div>
      ) : (
        <ModelListSection stream={stream} chatgpt={props.chatgpt} onChanged={onChanged} onError={onError} />
      )}
    </>
  );
}

function BoardSettings(props: { settings: Settings | null; agents: Agent[]; onSettings(s: Settings): void; onError(e: unknown): void }) {
  return (
    <section className="set-page">
      <header className="section-head">
        <h2>Board &amp; triage</h2>
        <p>Choose who turns ideas in Triage into actionable tasks, and who checks pull requests.</p>
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
      {props.settings && (
        <label className="field settings-field">
          Review agent
          <select
            value={props.settings.reviewAgent ?? ''}
            onChange={(e) => {
              api.updateSettings({ reviewAgent: e.target.value || null }).then(props.onSettings, props.onError);
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
      )}
      <p className="hint">Checks and merges the pull requests of tasks In review. Its own pull requests go to the triage agent.</p>
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

/** Where agent commands get their PATH (#136). A failure to read the login shell is shown, never hidden. */
function ShellPath({ info }: { info: ShellPathInfo | null }) {
  if (!info) return <>Reading your login shell's PATH…</>;
  const what = info.error
    ? `Could not read the PATH of your login shell${info.shell ? ` (${info.shell})` : ''}: ${info.error}. Commands use the engine's PATH:`
    : info.source === 'login'
      ? `PATH of your login shell (${info.shell}). Commits are made under the agent's name.`
      : "The engine's own PATH. Commits are made under the agent's name.";
  return (
    <>
      <p className={info.error ? 'state-err inline' : 'about-note'}>{what}</p>
      <details className="about-path">
        <summary>{info.path.split(':').filter(Boolean).length} folders</summary>
        <code>{info.path.split(':').filter(Boolean).join('\n')}</code>
      </details>
    </>
  );
}

function AboutData({ update, onOpenUpdate, onError }: { update: UpdateStatus | null; onOpenUpdate(): void; onError(e: unknown): void }) {
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
          <dt>Updates</dt>
          <dd>
            <UpdateAbout status={update} onOpen={onOpenUpdate} onError={onError} />
          </dd>
          <dt>Runs as</dt>
          <dd>{about.server ? 'Server (login required)' : 'Desktop app on this machine'}</dd>
          <dt>Data folder</dt>
          <dd>
            <code>{about.dataDir}</code>
          </dd>
          <dt>Agent shells</dt>
          <dd>
            <ShellPath info={about.shellPath} />
          </dd>
        </dl>
      ) : (
        <Skeleton />
      )}
    </section>
  );
}
