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
import { findSettings, SETTINGS_GROUPS, SETTINGS_PAGES, type SettingsPage } from './settingsPages.ts';
import { Icon } from './ScreenHeader.tsx';
import { SetRow, SetRows, SetSec } from './SettingsKit.tsx';
import { ProjectsPage } from './ProjectsPage.tsx';
import { useProjects } from './projects.tsx';
import { THEMES, type ThemeChoice } from './theme.ts';
import type { MessageStream } from './useMessages.ts';
import { UpdateAbout } from './UpdateDialog.tsx';
import { Skeleton } from './Kit.tsx';

/**
 * Settings (design §12, redesign #272, remake #307): one header row naming the page, a grouped navigation (Team,
 * Models, App) with « Find a setting » at its top, and the page, which never repeats its title. On a narrow window
 * #/settings is the list of pages and each page has the shell's back button and its name as the title.
 */
export function SettingsView(props: {
  /** null: #/settings alone, the list of pages (a wide window opens the last page instead). */
  page: SettingsPage | null;
  narrow: boolean;
  /** What follows the page: a memory scope or m12, a project, an agent. */
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
  // Counts appear only in the navigation (#307), never again on the page.
  const counts: Partial<Record<SettingsPage, number | null>> = {
    projects: projects.active.length,
    agents: props.agents.length,
    secrets: secretCount,
    'model-list': props.models.length,
    subscriptions,
    'api-keys': apiKeys,
  };

  const findBox = (
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
  );

  const nav = (cls: string) => (
    <nav className={cls} aria-label="Settings">
      {cls === 'settings-nav' && findBox}
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
            ) : page === 'subscriptions' ? (
              <>
                <p className="set-lead">Claude and ChatGPT subscriptions your agents can run on.</p>
                <ClaudePlanSection stream={stream} keyStore={keyStore} onChanged={modelsChanged} onError={onError} />
                <ChatGptSection status={props.chatgpt} onChanged={modelsChanged} onError={onError} />
              </>
            ) : page === 'api-keys' ? (
              <>
                <p className="set-lead">Pay-as-you-go API keys. Claude models use them from top to bottom.</p>
                <AccountsSection keyStore={keyStore} onChanged={modelsChanged} onError={onError} />
              </>
            ) : page === 'local' ? (
              <LocalModels stream={stream} agents={props.agents} onModelsChanged={modelsChanged} onError={onError} />
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
                <p className="set-lead">Voice mode runs on the Mac with the Atlas desktop app: open Settings → Voice there.</p>
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

function BoardSettings(props: { settings: Settings | null; agents: Agent[]; onSettings(s: Settings): void; onError(e: unknown): void }) {
  return (
    <>
      <p className="set-lead">
        Choose who turns ideas in Triage into actionable tasks. Each project's review agent is set in <a href="#/settings/projects">Projects</a>.
      </p>
      <SetSec first>
        <SetRows>
          <SetRow label="Triage agent" help="Nobody: triage tasks wait for you to organize them.">
            {props.settings ? (
              <select
                aria-label="Triage agent"
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
            ) : (
              <span className="hint">Waiting for engine settings…</span>
            )}
          </SetRow>
        </SetRows>
      </SetSec>
    </>
  );
}

function Appearance(props: { theme: ThemeChoice; onTheme(t: ThemeChoice): void }) {
  return (
    <SetSec first>
      <SetRows>
        <SetRow label="Theme" help="For this device, across Atlas. Auto follows your system." auto>
          <span className="segmented" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t} type="button" role="radio" aria-checked={props.theme === t} className={props.theme === t ? 'on' : ''} onClick={() => props.onTheme(t)}>
                {t === 'system' ? 'Auto' : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </span>
        </SetRow>
      </SetRows>
    </SetSec>
  );
}

/** Where agent commands get their PATH (#136). A failure to read the login shell is shown, never hidden. */
function shellPathText(info: ShellPathInfo | null) {
  if (!info) return "Reading your login shell's PATH…";
  const n = info.path.split(':').filter(Boolean).length;
  return info.error
    ? `Could not read the PATH of your login shell${info.shell ? ` (${info.shell})` : ''}: ${info.error}. Commands use the engine's PATH (${n} folders).`
    : info.source === 'login'
      ? `PATH of your login shell (${info.shell}), ${n} folders. Commits are made under the agent's name.`
      : `The engine's own PATH, ${n} folders. Commits are made under the agent's name.`;
}

function AboutData({ update, onOpenUpdate, onError }: { update: UpdateStatus | null; onOpenUpdate(): void; onError(e: unknown): void }) {
  const [about, setAbout] = useState<About | null>(null);
  const [folders, setFolders] = useState(false);
  useEffect(() => {
    api.about().then(setAbout, onError);
  }, [onError]);
  const sp = about?.shellPath ?? null;
  return (
    <>
      <p className="set-lead">Everything Atlas keeps (database, agent workspaces, artifacts) is in its data folder on the engine's machine.</p>
      {about ? (
        <SetSec first>
          <SetRows>
            <SetRow label="Version">
              <span className="set-val num">{about.version}</span>
            </SetRow>
            <SetRow label="Updates" stack>
              <UpdateAbout status={update} onOpen={onOpenUpdate} onError={onError} />
            </SetRow>
            <SetRow label="Runs as">
              <span className="set-val">{about.server ? 'Server (login required)' : 'Desktop app on this machine'}</span>
            </SetRow>
            <SetRow label="Data folder" help={<code>{about.dataDir}</code>} />
            <SetRow label="Agent shells" help={<span className={sp?.error ? 'set-help-err' : undefined}>{shellPathText(sp)}</span>} auto>
              {sp && (
                <button type="button" className="btn ghost small" aria-expanded={folders} onClick={() => setFolders(!folders)}>
                  {folders ? 'Hide folders' : 'Show folders'}
                </button>
              )}
            </SetRow>
            {folders && sp && (
              <div className="set-row">
                <code className="about-folders">{sp.path.split(':').filter(Boolean).join('\n')}</code>
              </div>
            )}
          </SetRows>
        </SetSec>
      ) : (
        <Skeleton />
      )}
    </>
  );
}
