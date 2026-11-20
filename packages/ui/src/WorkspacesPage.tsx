import { useCallback, useEffect, useState } from 'react';
import { HostRule, type Agent, type NetworkLevel, type NetworkPending, type NetworkRefusal, type Project, type ProjectMember, type SandboxStatus, type SecretInfo } from '@atlas/shared';
import { api } from './api.ts';
import { AgentFace } from './AgentFace.tsx';
import { Icon } from './ScreenHeader.tsx';
import { SetRow, SetRows, SetSec } from './SettingsKit.tsx';
import { ProjDot, useProjects } from './projects.tsx';
import type { MessageStream } from './useMessages.ts';
import { Skeleton } from './Kit.tsx';
import { allowPatch, commands, effective, gitAccess, LEVEL_LABEL, LEVEL_STATE, LEVELS, pendingFor, projectPending, refusedFor, workspacePath } from './workspaces.ts';

/** How often refusals and pending background commands are read again while the page is open (neither has an event). */
const POLL_MS = 5000;

const SANDBOX_KIND: Record<string, string> = { seatbelt: 'macOS Seatbelt', bwrap: 'bubblewrap' };

/**
 * Settings → Workspaces (#308, mockup #299 v8, #298 §2.5): the sandbox's state, then per project its default internet
 * access, its allowed hosts and its git access, and per member (one agent's workspace in that project) its own level,
 * own hosts, recently refused hosts and its browser data. A change applies from the workspace's next command; a
 * background command already running keeps its sandbox until it ends (« Change pending »).
 */
export function WorkspacesPage(props: { agents: Agent[]; stream: MessageStream; onError(e: unknown): void }) {
  const { onError, stream } = props;
  const projects = useProjects();
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null);
  const [secrets, setSecrets] = useState<SecretInfo[] | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [browser, setBrowser] = useState<{ available: boolean; reason: string | null } | null>(null);
  const [refusals, setRefusals] = useState<Record<string, NetworkRefusal[]>>({});
  const [pending, setPending] = useState<Record<string, NetworkPending[]>>({});

  useEffect(() => {
    api.sandbox().then(setSandbox, onError);
    api.about().then((a) => setDataDir(a.dataDir), onError);
    api.browserStatus().then(setBrowser, onError);
    const secrets = () => api.secrets().then((l) => setSecrets(l.secrets), onError);
    void secrets();
    return stream.listen('secrets', () => void secrets());
  }, [onError, stream]);

  const ids = projects.active.map((p) => p.id).join(',');
  const poll = useCallback(() => {
    for (const id of ids ? ids.split(',') : []) {
      api.refusals(id).then((r) => setRefusals((x) => ({ ...x, [id]: r })), onError);
      api.networkPending(id).then((r) => setPending((x) => ({ ...x, [id]: r })), onError);
    }
  }, [ids, onError]);
  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  const saveProject = (p: Project, patch: { network?: NetworkLevel; allowedHosts?: string[] }) => api.updateProject(p.id, patch).then(poll, onError);
  const saveMember = (p: Project, agentId: string, patch: { network?: NetworkLevel | null; allowedHosts?: string[] | null }) => api.updateMember(p.id, agentId, patch).then(poll, onError);

  if (!sandbox || !secrets) return <Skeleton />;
  return (
    <>
      <SandboxTop status={sandbox} />
      {projects.active.map((p) => (
        <ProjectSection
          key={p.id}
          project={p}
          agents={props.agents}
          secrets={secrets}
          dataDir={dataDir}
          browser={browser}
          refusals={refusals[p.id] ?? []}
          pending={pending[p.id] ?? []}
          onProject={(patch) => saveProject(p, patch)}
          onMember={(a, patch) => saveMember(p, a, patch)}
          onClear={(a) => api.clearBrowserData(p.id, a)}
        />
      ))}
    </>
  );
}

function SandboxTop({ status }: { status: SandboxStatus }) {
  if (status.enabled && !status.ok)
    return (
      <div className="state-err ws-top" role="alert">
        <b>Sandbox unavailable: {status.reason}. Agent commands are stopped.</b>
        <span>Every run that needs a command stops with this error on its card. Atlas never runs them outside the sandbox.</span>
      </div>
    );
  return (
    <SetSec first>
      <SetRows>
        <SetRow
          label="Sandbox"
          help="An agent's commands reach only its own workspace and a private temp folder, plus the internet as set below. Never your home, other workspaces, Atlas's data or the keychain. Model calls, PR checks and clones go through Atlas and always work."
          auto
        >
          {status.enabled ? (
            <span className="badge ok">Active ({SANDBOX_KIND[status.kind ?? ''] ?? status.kind})</span>
          ) : (
            <span className="badge warn">Off on this engine</span>
          )}
        </SetRow>
      </SetRows>
    </SetSec>
  );
}

function ProjectSection(props: {
  project: Project;
  agents: Agent[];
  secrets: SecretInfo[];
  dataDir: string | null;
  browser: { available: boolean; reason: string | null } | null;
  refusals: NetworkRefusal[];
  pending: NetworkPending[];
  onProject(patch: { network?: NetworkLevel; allowedHosts?: string[] }): Promise<void>;
  onMember(agentId: string, patch: { network?: NetworkLevel | null; allowedHosts?: string[] | null }): Promise<void>;
  onClear(agentId: string): Promise<void>;
}) {
  const p = props.project;
  const git = gitAccess(p, props.secrets);
  const projPending = projectPending(p, props.pending);
  return (
    <SetSec
      label={p.name}
      title={
        <>
          <ProjDot hue={p.colour} /> {p.name}
        </>
      }
    >
      <SetRows label={`${p.name}: internet and git`}>
        <SetRow label="Default internet" help={`For every agent's commands in ${p.name}, unless set per agent below. Applies from each agent's next command.`} auto>
          <span className="segmented" role="radiogroup" aria-label={`Default internet in ${p.name}`}>
            {LEVELS.map((l) => (
              <button key={l} type="button" role="radio" aria-checked={p.network === l} className={p.network === l ? 'on' : ''} onClick={() => p.network !== l && void props.onProject({ network: l })}>
                {LEVEL_LABEL[l]}
              </button>
            ))}
          </span>
        </SetRow>
        <SetRow
          label="Allowed hosts"
          help={
            <>
              <code>github.com</code> for one host, <code>*.npmjs.org</code> for its subdomains. Used by every agent set to Allowed hosts.
            </>
          }
          stack
        >
          <HostList hosts={p.allowedHosts} label={`${p.name}'s allowed hosts`} empty="None yet: agents at Allowed hosts reach no host." onChange={(h) => props.onProject({ allowedHosts: h })} />
        </SetRow>
        <SetRow
          label="git access"
          help={
            p.repo ? (
              <>
                Agents clone, push and open PRs on <code>{p.repo}</code> with the project secret <code>GH_TOKEN</code>. Only members it is granted to get it.
              </>
            ) : (
              'This project has no GitHub repo.'
            )
          }
          auto
        >
          <span className="set-val ws-git">
            {git.kind === 'norepo' ? (
              'No repo'
            ) : git.kind === 'missing' ? (
              <>
                <span className="ws-warn">No GH_TOKEN secret: agents cannot push</span>
                <br />
                <a href="#/settings/secrets">Add it in Secrets</a>
              </>
            ) : (
              <a href="#/settings/secrets" className={git.granted ? undefined : 'ws-warn'}>
                GH_TOKEN granted to {git.granted} of {git.members} members
              </a>
            )}
          </span>
        </SetRow>
      </SetRows>
      {projPending && (
        <div className="ws-msg info ws-pmsg" role="status">
          <b>Change pending</b>
          <span>You changed {p.name}'s default internet. {commands(projPending)} keep the old setting until they end.</span>
        </div>
      )}
      <SetRows label={`${p.name}: workspaces`}>
        {p.members.map((m) => (
          <MemberRow
            key={m.agentId}
            project={p}
            member={m}
            agent={props.agents.find((a) => a.id === m.agentId) ?? null}
            dataDir={props.dataDir}
            browser={props.browser}
            refused={refusedFor(p, m, props.refusals)}
            pending={pendingFor(m, props.pending)}
            onMember={(patch) => props.onMember(m.agentId, patch)}
            onProject={props.onProject}
            onClear={() => props.onClear(m.agentId)}
          />
        ))}
      </SetRows>
    </SetSec>
  );
}

function MemberRow(props: {
  project: Project;
  member: ProjectMember;
  agent: Agent | null;
  dataDir: string | null;
  browser: { available: boolean; reason: string | null } | null;
  refused: NetworkRefusal[];
  pending: { count: number; level: NetworkLevel } | null;
  onMember(patch: { network?: NetworkLevel | null; allowedHosts?: string[] | null }): Promise<void>;
  onProject(patch: { allowedHosts?: string[] }): Promise<void>;
  onClear(): Promise<void>;
}) {
  const { project: p, member: m } = props;
  const a = m.agentId;
  const e = effective(p, m);
  const own = m.network !== null || e.ownHosts;
  // Open by itself while it has something to act on (pending, refused hosts, both read after the first render),
  // until Master opens or closes it.
  const [toggled, setOpen] = useState<boolean | null>(null);
  const open = toggled ?? (!!props.pending || props.refused.length > 0);
  const [cleared, setCleared] = useState<'idle' | 'busy' | 'done' | string>('idle');
  const allow = (host: string) => {
    const x = allowPatch(p, m, host);
    return x.target === 'agent' ? props.onMember({ allowedHosts: x.hosts }) : props.onProject({ allowedHosts: x.hosts });
  };
  const clear = () => {
    if (!confirm(`Clear @${a}'s browser data in ${p.name}? Its cookies and logins are deleted: sites will ask it to sign in again.`)) return;
    setCleared('busy');
    props.onClear().then(
      () => setCleared('done'),
      (err: unknown) => setCleared(err instanceof Error ? err.message : String(err)),
    );
  };
  return (
    <details className="ws-agent" open={open} onToggle={(ev) => ev.currentTarget.open !== open && setOpen(ev.currentTarget.open)}>
      <summary>
        <AgentFace id={a} />
        <div className="ws-agent-main">
          <span className="ws-agent-name">
            @{a}
            {own && <span className="badge override">own setting</span>}
            {props.pending && <span className="badge">change pending</span>}
          </span>
          <span className="ws-agent-sub">
            <span className="ws-agent-path" title="Read-only">
              {workspacePath(m, props.agent?.workdir ?? null, props.dataDir)}
            </span>
            <span className={'ws-net ' + e.level}>
              <i />
              {LEVEL_STATE[e.level]}
            </span>
          </span>
        </div>
        <select
          aria-label={`Internet for @${a} in ${p.name}`}
          value={m.network ?? ''}
          onChange={(ev) => void props.onMember({ network: (ev.target.value || null) as NetworkLevel | null })}
        >
          <option value="">Project default ({LEVEL_LABEL[p.network]})</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {LEVEL_LABEL[l]}
            </option>
          ))}
        </select>
      </summary>
      <div className="ws-body">
        {props.pending && (
          <div className="ws-msg info" role="status">
            <b>Change pending</b>
            <span>
              From @{a}'s next command on: {LEVEL_LABEL[e.level]}. {commands(props.pending.count)} already running keep the old setting ({LEVEL_LABEL[props.pending.level]}) until they end.
            </span>
          </div>
        )}
        {m.network === 'hosts' && (
          <SetRow label="Own allowed hosts" help={`Replace the project's list for @${a}. Empty: ${p.name}'s list.`} stack>
            <HostList hosts={m.allowedHosts ?? []} label={`@${a}'s hosts`} empty={`None: @${a} uses ${p.name}'s list.`} onChange={(h) => props.onMember({ allowedHosts: h.length ? h : null })} />
          </SetRow>
        )}
        {props.refused.length > 0 && (
          <SetRow
            label="Recently refused"
            help={`Hosts @${a}'s commands tried to reach and were refused. Allow adds the host to ${e.ownHosts ? `@${a}'s own list` : `${p.name}'s list`}.`}
            stack
          >
            <div className="ws-ref">
              {props.refused.map((r) => (
                <div key={r.host} className="ws-ref-row">
                  <span className="mono">{r.host}</span>
                  <span className="muted num">× {r.count}</span>
                  <button type="button" className="btn small" onClick={() => void allow(r.host)}>
                    {e.ownHosts ? `Allow for @${a}` : 'Allow for the project'}
                  </button>
                </div>
              ))}
            </div>
          </SetRow>
        )}
        <SetRow
          label="Browser data"
          help={
            props.browser && !props.browser.available ? (
              (props.browser.reason ?? 'The browser runs in the Atlas desktop app only.')
            ) : cleared === 'done' ? (
              `Cleared: @${a}'s browser in ${p.name} starts signed out.`
            ) : cleared !== 'idle' && cleared !== 'busy' ? (
              <span className="set-help-err">Could not clear it: {cleared}</span>
            ) : (
              `Cookies and logins of @${a}'s browser in ${p.name}.`
            )
          }
          auto
        >
          <button type="button" className="btn ghost small" disabled={!props.browser?.available || cleared === 'busy'} onClick={clear}>
            Clear browser data
          </button>
        </SetRow>
      </div>
    </details>
  );
}

/** A list of `host` / `*.suffix` rules: chips with ×, and a box to add one (checked with the engine's own rule). */
function HostList(props: { hosts: string[]; label: string; empty: string; onChange(hosts: string[]): Promise<void> }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const r = HostRule.safeParse(draft);
    if (!r.success) return setError(r.error.issues[0]?.message ?? 'not a host');
    setError(null);
    if (props.hosts.includes(r.data)) return setDraft('');
    void props.onChange([...props.hosts, r.data]).then(() => setDraft(''));
  };
  return (
    <div className="ws-col">
      {props.hosts.length > 0 ? (
        <div className="ws-hl" role="list" aria-label={props.label}>
          {props.hosts.map((h) => (
            <span key={h} className="chip ws-host" role="listitem">
              <span>{h}</span>
              <button type="button" className="x" aria-label={`Remove ${h}`} onClick={() => void props.onChange(props.hosts.filter((x) => x !== h))}>
                <Icon.x />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <span className="ws-none">{props.empty}</span>
      )}
      <form
        className="ws-add"
        onSubmit={(ev) => {
          ev.preventDefault();
          add();
        }}
      >
        <input
          className="mono"
          value={draft}
          placeholder="host or *.suffix"
          aria-label={`Add to ${props.label}`}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(ev) => {
            setDraft(ev.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="btn small" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      {error && (
        <span className="ws-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
