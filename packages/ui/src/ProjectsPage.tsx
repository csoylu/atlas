import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Agent, Card, Project, ProjectMember, RepoCheck, Workflow } from '@atlas/shared';
import { api, ApiError } from './api.ts';
import { AgentFace } from './AgentFace.tsx';
import { HeaderActions, Icon } from './ScreenHeader.tsx';
import { SetRow, SetRows, SetSec } from './SettingsKit.tsx';
import { ProjDot, useProjectFilter, useProjects } from './projects.tsx';

/**
 * Settings → Projects (#217, mockup #212): the list, New project with the live repo check, cloning per member, a
 * failed clone with « Fix the repo name » / « Try again », a project's page (#/settings/projects/<id>: edit, members,
 * remove a member, archive). Every text says what happens and what to do next: Master sets Datinel up from here alone.
 */
export function ProjectsPage(props: { rest: string; agents: Agent[]; cards: Card[]; workflows: Workflow[]; onError(e: unknown): void }) {
  const { all } = useProjects();
  const [creating, setCreating] = useState(props.rest === 'new');
  const [id, sub] = props.rest.split('/');
  const open = id && id !== 'new' ? all.find((p) => p.id === id) : undefined;
  if (id && id !== 'new') {
    if (!open) return all.length ? <p className="muted">No project « {id} ». <a href="#/settings/projects">All projects</a></p> : null;
    return <ProjectDetail key={open.id} project={open} focusRepo={sub === 'repo'} {...props} />;
  }
  const active = all.filter((p) => p.status === 'active');
  const archived = all.filter((p) => p.status === 'archived');
  return (
    <section>
      {/* The header names the page (#307): « New project » sits in its row. */}
      <HeaderActions>
        <span className="head-sp" />
        {!creating && (
          <button type="button" className="btn primary small" onClick={() => setCreating(true)}>
            <Icon.plus />
            <span className="btn-text">New project</span>
          </button>
        )}
      </HeaderActions>
      <p className="set-lead">
        A project is a repo your agents work on, with its own tasks, chats, artifacts, memory, secrets and workflows. Each member works in its own clone of the
        repo; the lead gets the project's new tasks.
      </p>
      {all.length === 1 && (
        <div className="pj-note">
          Atlas made this project at the update from what you already had: your {props.agents.length} agents, their chats and workspaces, the board, the
          Library, memory and workflows. <b>Nothing else changed.</b> Project names show up in the sidebar, Tasks and the Library only once you have two
          projects.
        </div>
      )}
      <div className="model-list">
        {active.map((p) => (
          <ProjectRow key={p.id} project={p} {...props} />
        ))}
        {creating ? (
          <NewProject agents={props.agents} onDone={() => setCreating(false)} onError={props.onError} />
        ) : (
          <button type="button" className="model-row add" onClick={() => setCreating(true)}>
            + New project
          </button>
        )}
      </div>
      {archived.length > 0 && (
        <>
          <SetSec title="Archived">
            <div className="model-list">
              {archived.map((p) => (
                <ProjectRow key={p.id} project={p} {...props} />
              ))}
            </div>
          </SetSec>
        </>
      )}
    </section>
  );
}

const isOpen = (c: Card) => !['done', 'closed', 'archived'].includes(c.status);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** A member with a workspace in the project: its own workdir (first project) or a ready clone. */
const hasWorkspace = (m: ProjectMember) => m.home || m.cloneState === 'ready';
/** « workspaces/munih/datinel » rather than the whole absolute path. */
const shortPath = (path: string | null) => (path ? path.replace(/^.*\/(workspaces\/.+)$/, '$1') : '');

function Faces({ p }: { p: Project }) {
  return (
    <span className="pj-faces" title={'Members: ' + p.members.map((m) => m.agentId).join(', ')}>
      {p.members.map((m) => (
        <AgentFace key={m.agentId} id={m.agentId} />
      ))}
      <span>{plural(p.members.length, 'member')}</span>
    </span>
  );
}

function ProjectRow({ project: p, cards, workflows, onError }: { project: Project; cards: Card[]; workflows: Workflow[]; onError(e: unknown): void }) {
  const failed = p.members.filter((m) => m.cloneState === 'failed');
  const cloning = p.members.some((m) => m.cloneState === 'cloning' || m.cloneState === 'pending');
  const ready = p.members.filter(hasWorkspace).length;
  const open = cards.filter((c) => c.projectId === p.id && isOpen(c)).length;
  const wfs = workflows.filter((w) => w.projectId === p.id).length;
  const archived = p.status === 'archived';
  const [busy, setBusy] = useState(false);
  const retry = () => {
    setBusy(true);
    Promise.all(failed.map((m) => api.retryClone(p.id, m.agentId)))
      .catch(onError)
      .finally(() => setBusy(false));
  };
  const restore = () => api.restoreProject(p.id).catch(onError);
  const showClones = !archived && (cloning || (failed.length > 0 && failed.length < p.members.length));
  return (
    <div className={'model-row pj-row' + (failed.length ? ' bad' : ' ok') + (showClones || failed.length ? ' pj-wrap' : '')}>
      <div className="model-main">
        <div className="model-title">
          <ProjDot hue={p.colour} />
          <b>{p.name}</b>
          {p.repo && <span className="pj-repo">{p.repo}</span>}
          {archived ? (
            <span className="badge">Archived</span>
          ) : failed.length ? (
            <span className="badge bad">Clone failed</span>
          ) : cloning ? (
            <span className="st-chip working">Cloning · {ready} of {p.members.length} ready</span>
          ) : null}
        </div>
        <div className="model-detail">
          {p.lead && (
            <span className="pj-who">
              lead <AgentFace id={p.lead} />
              {p.lead}
            </span>
          )}
          <Faces p={p} />
          {archived ? (
            <span>archived {p.archivedAt ? new Date(p.archivedAt).toLocaleDateString() : ''}</span>
          ) : failed.length === p.members.length ? (
            <span>no workspace yet</span>
          ) : (
            <>
              <span>{plural(open, 'open task')}</span>
              <span>{wfs ? plural(wfs, 'workflow') : 'no workflow yet'}</span>
            </>
          )}
        </div>
      </div>
      <div className="model-actions">
        {archived && (
          <button type="button" className="btn ghost" onClick={restore}>
            Restore
          </button>
        )}
        <button type="button" className="btn ghost" onClick={() => (location.hash = '#/settings/projects/' + encodeURIComponent(p.id))}>
          {archived ? 'Open' : 'Edit'}
        </button>
      </div>
      {showClones && <CloneList p={p} />}
      {!archived && failed.length > 0 && (
        <div className="state-err pj-err" role="alert">
          <CloneError p={p} failed={failed} />
          <div className="actions">
            {!p.members.some((m) => m.home || m.cloneState === 'ready' || m.cloneState === 'cloning') && (
              <button type="button" className="btn primary small" onClick={() => (location.hash = `#/settings/projects/${encodeURIComponent(p.id)}/repo`)}>
                Fix the repo name
              </button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={retry}>
              {busy ? 'Trying…' : 'Try again'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Why the clone failed, in words, and what to do: the repo name or access (the common case), else git's own message. */
function CloneError({ p, failed }: { p: Project; failed: ProjectMember[] }) {
  const err = failed.map((m) => m.cloneError ?? '').join('\n');
  const who = failed.length === p.members.length ? 'No member' : failed.map((m) => '@' + m.agentId).join(', ') + (failed.length === 1 ? ' has' : ' have');
  const unreachable = /can't reach|no repo|not found|could not read|repository|access|permission|authentic|denied|404/i.test(err);
  return unreachable ? (
    <>
      <span>
        <b>Can't reach {p.repo}.</b> GitHub has no repo by that name, or your GitHub login (<code>gh</code>) can't read it.{' '}
        {failed.length === p.members.length ? `No member has a ${p.name} workspace, so its chats wait.` : `${who} no ${p.name} workspace yet, so their chats wait.`}
      </span>
      <span>Check the name, or give your login access on GitHub, then try again.</span>
    </>
  ) : (
    <>
      <span>
        <b>The clone of {p.repo} failed</b> for {failed.map((m) => '@' + m.agentId).join(', ')}. git said: <code>{err.trim().split('\n').at(-1) || 'no message'}</code>
      </span>
      <span>Fix what it says (disk space, network, a folder in the way), then try again.</span>
    </>
  );
}

function CloneList({ p }: { p: Project }) {
  return (
    <div className="pj-clone" aria-label={`Workspaces of ${p.name}`}>
      {p.members.map((m) => (
        <CloneLine key={m.agentId} m={m} />
      ))}
      <div className="pj-cl">
        <span>Each member's chat « · {p.name} » opens when its clone is ready. You can leave this page.</span>
      </div>
    </div>
  );
}

function CloneLine({ m }: { m: ProjectMember }) {
  const icon =
    m.cloneState === 'ready' || m.home ? <Icon.check /> : m.cloneState === 'failed' ? <Icon.x /> : // a spinner sits straight in the row (a wrapping span squeezes it)
       <span className="spin" aria-label={m.cloneState === 'cloning' ? 'working' : 'waiting'} />;
  return (
    <div className="pj-cl">
      {m.cloneState === 'cloning' || m.cloneState === 'pending' ? icon : <span className={m.cloneState === 'failed' ? 'pj-bad-ic' : 'pj-ok'}>{icon}</span>}
      <AgentFace id={m.agentId} />
      <b>{m.agentId}</b>
      <span>
        {m.home || m.cloneState === 'ready' ? (
          <>
            ready{m.workspace && <> · <span className="pj-repo">{shortPath(m.workspace)}</span></>}
            {m.branch && <> · {m.branch}</>}
          </>
        ) : m.cloneState === 'cloning' ? (
          `cloning…${m.cloneProgress != null ? ' ' + m.cloneProgress + '%' : ''}`
        ) : m.cloneState === 'pending' ? (
          'next'
        ) : (
          'failed'
        )}
      </span>
    </div>
  );
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
type Check = { state: 'idle' } | { state: 'checking'; repo: string } | { state: 'done'; check: RepoCheck } | { state: 'error'; repo: string; error: string };

/** The repo field's live check (GET /api/projects/repo-check), half a second after typing stops. */
function useRepoCheck(repo: string, enabled: boolean): Check {
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  useEffect(() => {
    const r = repo.trim();
    if (!enabled || !REPO.test(r)) return setCheck({ state: 'idle' });
    setCheck({ state: 'checking', repo: r });
    let live = true;
    const t = setTimeout(
      () =>
        api.repoCheck(r).then(
          (c) => live && setCheck({ state: 'done', check: c }),
          (e: unknown) => live && setCheck({ state: 'error', repo: r, error: e instanceof Error ? e.message : String(e) }),
        ),
      500,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [repo, enabled]);
  return check;
}

function RepoCheckLine({ repo, check, taken }: { repo: string; check: Check; taken?: Project }) {
  const r = repo.trim();
  if (taken)
    return (
      <div className="pj-check bad">
        <span className="pj-bad-ic"><Icon.x /></span>
        <span>
          <b>{taken.name} already works on {r}.</b> One repo, one project: open {taken.name} in the list above to add members to it, or pick another repo.
        </span>
      </div>
    );
  if (!r) return <div className="pj-check">No repo: nothing is cloned, each member works in its own workspace. You can add the repo later, once.</div>;
  if (!REPO.test(r))
    return (
      <div className="pj-check bad">
        <span className="pj-bad-ic"><Icon.x /></span>
        <span>
          Write it as <b>owner/name</b>, as in github.com/<b>owner/name</b>.
        </span>
      </div>
    );
  if (check.state === 'checking' || check.state === 'idle')
    return (
      <div className="pj-check">
        <span className="spin" aria-label="checking" />
        <span>Checking {r} with your GitHub login…</span>
      </div>
    );
  if (check.state === 'error')
    return (
      <div className="pj-check bad">
        <span className="pj-bad-ic"><Icon.x /></span>
        <span>
          <b>Atlas could not check {check.repo}:</b> {check.error}. Check that the engine is running, then edit the name to check again.
        </span>
      </div>
    );
  const c = check.check;
  if (!c.found)
    return (
      <div className="pj-check bad">
        <span className="pj-bad-ic"><Icon.x /></span>
        <span>
          <b>Not found:</b> GitHub has no repo {c.repo}, or your GitHub login (<code>gh</code>) can't read it{c.error ? ` (${c.error})` : ''}. Check the
          spelling, or run <code>gh auth login</code> with an account that can read it.
        </span>
      </div>
    );
  return (
    <div className="pj-check">
      <span className="pj-ok"><Icon.check /></span>
      <span>
        <b>Found</b> with your GitHub login{c.private != null && ` · ${c.private ? 'private' : 'public'}`}
        {c.defaultBranch && (
          <>
            {' '}
            · default branch <b>{c.defaultBranch}</b>
          </>
        )}{' '}
        ·{' '}
        {c.instructions.length ? (
          <>
            instructions in{' '}
            {c.instructions.map((f, i) => (
              <span key={f}>
                {i ? ' and ' : ''}
                <b>{f}</b>
              </span>
            ))}
          </>
        ) : (
          'no CLAUDE.md or AGENTS.md at its root: agents get no project instructions'
        )}
      </span>
    </div>
  );
}

/** « @atlas · team lead »: the first line of its role when it is short. */
function agentLabel(a: Agent): string {
  const role = a.rolePrompt.split('\n')[0]?.trim() ?? '';
  return '@' + a.id + (role && role.length <= 40 ? ' · ' + role : '');
}

function NewProject({ agents, onDone, onError }: { agents: Agent[]; onDone(): void; onError(e: unknown): void }) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [leadPick, setLead] = useState('');
  // The agents may arrive after the form opens: the lead is then the first one, as the select shows.
  const lead = leadPick || agents[0]?.id || '';
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useRepoCheck(repo, true);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const r = repo.trim();
  const pinfo = useProjects();
  const taken = r ? pinfo.all.find((p) => p.repo?.toLowerCase() === r.toLowerCase()) : undefined;
  const repoOk = !r || (!taken && REPO.test(r) && check.state === 'done' && check.check.found);
  const picked = new Set([...members, lead].filter(Boolean));
  const shown = name.trim() || 'Project';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !repoOk || busy) return;
    setBusy(true);
    setError(null);
    api
      .createProject({ name: name.trim(), repo: r || null, lead: lead || null, members: [...picked] })
      .then(() => onDone())
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 409 || err.status === 400)) setError(err.message);
        else onError(err);
      })
      .finally(() => setBusy(false));
  };
  return (
    <form className="model-row new pj-form" onSubmit={submit} aria-label="New project">
      <div className="field-row">
        <label className="field">
          Name
          <input ref={first} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder="Datinel" maxLength={60} />
        </label>
        <label className="field">
          GitHub repo
          <input className="mono" value={repo} onChange={(e) => setRepo(e.target.value)} autoComplete="off" spellCheck={false} placeholder="owner/name" />
        </label>
      </div>
      <p className="muted form-note">Atlas picks the project's colour (the square next to its name).</p>
      <RepoCheckLine repo={repo} check={check} taken={taken} />
      <label className="field">
        Lead
        <select value={lead} onChange={(e) => setLead(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {agentLabel(a)}
            </option>
          ))}
        </select>
        <span className="pj-check">Gets the project's new tasks and sorts them, like triage today. Always a member.</span>
      </label>
      <div className="field">
        Members
        <div className="sec-pick">
          {agents.map((a) => {
            const isLead = a.id === lead;
            const on = isLead || members.includes(a.id);
            return (
              <label key={a.id} className={on ? 'on' : ''}>
                <input type="checkbox" checked={on} disabled={isLead} onChange={() => setMembers(on ? members.filter((x) => x !== a.id) : [...members, a.id])} />
                <AgentFace id={a.id} />
                {a.id}
                {isLead && <span className="sec-role">lead</span>}
              </label>
            );
          })}
        </div>
      </div>
      <p className="muted form-note">
        {r ? (
          <>
            Atlas clones <code>{r}</code> into each member's workspace and opens one chat per member, named « {lead || 'agent'} · {shown} ».
          </>
        ) : (
          <>Atlas opens one chat per member, named « {lead || 'agent'} · {shown} ».</>
        )}{' '}
        Their other chats stay as they are. {name.trim() ? `${shown}'s` : "The project's"} memory, secrets and workflows start empty.
      </p>
      {error && (
        <p className="state-err pj-err" role="alert">
          <span>
            <b>Not created:</b> {error}. Change it above, then create the project again.
          </span>
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary small" disabled={!name.trim() || !repoOk || busy} title={!name.trim() ? 'Give it a name first' : !repoOk ? 'Wait for the repo check, or fix the repo' : undefined}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </form>
  );
}

/** #/settings/projects/<id>: name, repo (until a clone exists), lead, members, what its agents read, archive. */
function ProjectDetail({ project: p, agents, cards, workflows, focusRepo, onError }: { project: Project; agents: Agent[]; cards: Card[]; workflows: Workflow[]; focusRepo: boolean; onError(e: unknown): void }) {
  const archived = p.status === 'archived';
  const repoFixed = !!p.repo && p.members.some((m) => m.home || m.cloneState === 'ready' || m.cloneState === 'cloning');
  const [name, setName] = useState(p.name);
  const [repo, setRepo] = useState(p.repo ?? '');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [deletingKept, setDeletingKept] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ memory: number; secrets: number } | null>(null);
  const [, setFilter] = useProjectFilter();
  const repoInput = useRef<HTMLInputElement>(null);
  const check = useRepoCheck(repo, !repoFixed && repo.trim() !== (p.repo ?? ''));
  const [instr, setInstr] = useState<RepoCheck | null>(null);
  useEffect(() => {
    if (focusRepo) repoInput.current?.focus();
  }, [focusRepo]);
  useEffect(() => {
    Promise.all([api.memories({ project: p.id }), api.secrets()]).then(
      ([m, s]) => setCounts({ memory: m.length, secrets: s.secrets.filter((x) => x.project === p.id).length }),
      onError,
    );
    if (p.repo) api.repoCheck(p.repo).then(setInstr, () => setInstr(null));
  }, [p.id, p.repo, onError]);
  const projCards = cards.filter((c) => c.projectId === p.id);
  const open = projCards.filter(isOpen);
  const running = projCards.filter((c) => c.status === 'running');
  const wfs = workflows.filter((w) => w.projectId === p.id);
  const save = (patch: Parameters<typeof api.updateProject>[1]) => {
    setSaving(true);
    setFormError(null);
    return api
      .updateProject(p.id, patch)
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 409 || err.status === 400)) setFormError(err.message);
        else onError(err);
      })
      .finally(() => setSaving(false));
  };
  const dirty = name.trim() !== p.name || (!repoFixed && repo.trim() !== (p.repo ?? ''));
  const repoChanged = !repoFixed && repo.trim() !== (p.repo ?? '');
  const repoOk = !repoChanged || !repo.trim() || (check.state === 'done' && check.check.found);
  const go = (filterTo: string, hash: string) => {
    setFilter(filterTo);
    location.hash = hash;
  };
  const nonMembers = agents.filter((a) => !p.members.some((m) => m.agentId === a.id));
  return (
    <section>
      <p className="set-lead">
        {archived ? `Archived${p.archivedAt ? ' on ' + new Date(p.archivedAt).toLocaleDateString() : ''} · ` : `Created ${new Date(p.createdAt).toLocaleDateString()} · `}
        {plural(open.length, 'open task')}
        {running.length > 0 && ` · ${running.length} running`}
      </p>
      {archived && (
        <div className="pj-note">
          <b>{p.name} is archived.</b> Its tasks, chats and artifacts are read-only; « Archived » in the project filter shows them.{' '}
          <button type="button" className="linklike" onClick={() => api.restoreProject(p.id).catch(onError)}>
            Restore {p.name}
          </button>
        </div>
      )}
      <SetSec first>
      <form
        className="pj-form pj-edit"
        aria-label={`${p.name} settings`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!dirty || !repoOk || !name.trim()) return;
          void save({ ...(name.trim() !== p.name ? { name: name.trim() } : {}), ...(repoChanged ? { repo: repo.trim() || null } : {}) });
        }}
      >
        <SetRows>
          <SetRow label="Name">
            <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={60} disabled={archived} />
          </SetRow>
          <SetRow
            label="GitHub repo"
            help={
              repoChanged ? undefined : repoFixed
                ? "Can't change once cloned: another repo is another project."
                : p.repo
                  ? 'No member has a clone yet: you can still fix the repo name. The failed clones try the new name.'
                  : 'No repo yet: you can set one, once. Members then get a clone of it.'
            }
          >
            <input aria-label="GitHub repo" ref={repoInput} className="mono" value={repo} onChange={(e) => setRepo(e.target.value)} autoComplete="off" spellCheck={false} placeholder="owner/name" disabled={repoFixed || archived} />
          </SetRow>
          {repoChanged && (
            <div className="set-row">
              <RepoCheckLine repo={repo} check={check} />
            </div>
          )}
          <SetRow label="Lead" help="Gets the project's new tasks.">
            <select aria-label="Lead" value={p.lead ?? ''} disabled={archived || saving} onChange={(e) => void save({ lead: e.target.value || null })}>
              {!p.lead && <option value="">Nobody (new tasks wait)</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {agentLabel(a)}
                </option>
              ))}
            </select>
          </SetRow>
          {p.repo && (
            <SetRow label="Review agent" help="Checks and merges the pull requests of tasks In review.">
              <select aria-label="Review agent" value={p.reviewAgent ?? ''} disabled={archived || saving} onChange={(e) => void save({ reviewAgent: e.target.value || null })}>
                {!p.reviewAgent && <option value="">Nobody (nothing is reviewed)</option>}
                {p.members.map((m) => (
                  <option key={m.agentId} value={m.agentId}>
                    {(() => {
                      const a = agents.find((x) => x.id === m.agentId);
                      return a ? agentLabel(a) : '@' + m.agentId;
                    })()}
                  </option>
                ))}
              </select>
            </SetRow>
          )}
        </SetRows>
        {formError && (
          <p className="state-err pj-err" role="alert">
            <span>
              <b>Not saved:</b> {formError}.
            </span>
          </p>
        )}
        {dirty && (
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => (setName(p.name), setRepo(p.repo ?? ''), setFormError(null))}>
              Cancel
            </button>
            <button className="btn primary small" disabled={saving || !repoOk || !name.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </form>
      </SetSec>

      <SetSec title="Members">
      <div className="model-list">
        {p.members.map((m) => {
          const isLead = m.agentId === p.lead;
          const run = running.find((c) => c.assignee === m.agentId);
          const theirs = open.filter((c) => c.assignee === m.agentId);
          return (
            <div key={m.agentId} className={'model-row pj-row pj-mem' + (removing === m.agentId ? ' pj-wrap' : '')}>
              <AgentFace id={m.agentId} />
              <div className="model-main">
                <div className="model-title">
                  <b>{m.agentId}</b>
                  {isLead && <span className="badge">lead</span>}
                  {m.agentId === p.reviewAgent && <span className="badge">reviewer</span>}
                  {m.cloneState === 'failed' && <span className="badge bad">Clone failed</span>}
                </div>
                <div className="model-detail">
                  {hasWorkspace(m) ? (
                    <>
                      <span className="pj-repo">{m.workspace ? shortPath(m.workspace) : 'its own workspace'}</span>
                      {m.branch && <span>on {m.branch}</span>}
                    </>
                  ) : m.cloneState === 'cloning' ? (
                    <span className="pj-who">
                      <span className="spin" aria-label="working" />
                      cloning…{m.cloneProgress != null && ` ${m.cloneProgress}%`}
                    </span>
                  ) : m.cloneState === 'pending' ? (
                    <span>clone waiting</span>
                  ) : (
                    <span>{m.cloneError?.trim().split('\n').at(-1) ?? 'clone failed'}</span>
                  )}
                  {run && (
                    <span className="pj-who">
                      <span className="spin" aria-label="working" />
                      running #{run.number}
                    </span>
                  )}
                </div>
              </div>
              {removing !== m.agentId && !archived && (
                <div className="model-actions">
                  {m.cloneState === 'failed' && (
                    <button type="button" className="btn" onClick={() => api.retryClone(p.id, m.agentId).catch(onError)}>
                      Try again
                    </button>
                  )}
                  <button type="button" className={'btn ghost' + (isLead ? '' : ' danger')} disabled={isLead} title={isLead ? 'Choose another lead first' : undefined} onClick={() => setRemoving(m.agentId)}>
                    Remove
                  </button>
                </div>
              )}
              {removing === m.agentId && (
                <div className="pj-inline">
                  <b>
                    Remove {m.agentId} from {p.name}?
                  </b>
                  <ul>
                    {run ? (
                      <li>
                        Its run on #{run.number} stops; {theirs.length > 1 ? `its ${theirs.length} open tasks go` : `#${run.number} goes`} back to Triage for {p.lead} (lead).
                      </li>
                    ) : theirs.length ? (
                      <li>
                        Its {plural(theirs.length, 'open task')} ({theirs.map((c) => '#' + c.number).join(', ')}) {theirs.length === 1 ? 'goes' : 'go'} back to Triage for {p.lead} (lead).
                      </li>
                    ) : (
                      <li>It has no open task in {p.name}: nothing to hand back.</li>
                    )}
                    <li>
                      Its chat « {m.agentId} · {p.name} » is archived: read-only, still found by search and by its tasks.
                    </li>
                    <li>Its chats in other projects don't change.</li>
                    {hasWorkspace(m) && (
                      <li>
                        {m.home ? 'Its own workspace stays as it is.' : <>Its clone stays on disk (<code>{shortPath(m.workspace)}</code>) until you delete it.</>}
                      </li>
                    )}
                  </ul>
                  <div className="actions">
                    <button type="button" className="btn ghost" onClick={() => setRemoving(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn primary small danger"
                      disabled={saving}
                      onClick={() => void save({ members: p.members.map((x) => x.agentId).filter((x) => x !== m.agentId) }).then(() => setRemoving(null))}
                    >
                      Remove {m.agentId}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!archived &&
          nonMembers.length > 0 &&
          (adding ? (
            <AddMember
              agents={nonMembers}
              repo={p.repo}
              project={p.name}
              onCancel={() => setAdding(false)}
              onAdd={(id) => void save({ members: [...p.members.map((x) => x.agentId), id] }).then(() => setAdding(false))}
            />
          ) : (
            <button type="button" className="model-row add" onClick={() => setAdding(true)}>
              + Add a member
            </button>
          ))}
      </div>
      </SetSec>

      {p.kept.length > 0 && (
        <>
          <SetSec title="Workspaces of removed members">
          <div className="model-list">
            {p.kept.map((k) => (
              <div key={k.agentId} className={'model-row pj-row pj-mem' + (deletingKept === k.agentId ? ' pj-wrap' : '')}>
                <AgentFace id={k.agentId} />
                <div className="model-main">
                  <div className="model-title">
                    <b>{k.agentId}</b>
                  </div>
                  <div className="model-detail">
                    <span className="pj-repo">{shortPath(k.path)}</span>
                    <span>kept since {new Date(k.keptAt).toLocaleDateString()}</span>
                  </div>
                </div>
                {!k.home && deletingKept !== k.agentId && (
                  <div className="model-actions">
                    <button type="button" className="btn ghost danger" onClick={() => setDeletingKept(k.agentId)}>
                      Delete…
                    </button>
                  </div>
                )}
                {deletingKept === k.agentId && (
                  <div className="pj-inline">
                    <b>Delete {shortPath(k.path)} from disk?</b>
                    <ul>
                      <li>Its files go for good, uncommitted or unpushed work in it too. Its tasks and chats stay.</li>
                    </ul>
                    <div className="actions">
                      <button type="button" className="btn ghost" onClick={() => setDeletingKept(null)}>
                        Cancel
                      </button>
                      <button type="button" className="btn primary small danger" onClick={() => api.deleteKept(p.id, k.agentId).then(() => setDeletingKept(null), onError)}>
                        Delete the folder
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          </SetSec>
        </>
      )}

      <SetSec title={`What ${p.name}'s agents read`}>
      <div className="pj-links">
        {p.repo ? (
          <a className="pj-link" href={`https://github.com/${p.repo}/blob/${instr?.defaultBranch ?? 'HEAD'}/${instr?.instructions[0] ?? 'CLAUDE.md'}`} target="_blank" rel="noreferrer">
            Instructions
            <span>
              {instr && !instr.instructions.length ? 'No CLAUDE.md or AGENTS.md at the repo root yet. Add one through a PR.' : `The repo's ${instr?.instructions.join(' and ') || 'CLAUDE.md'}, read at every run. Change it through a PR.`}
            </span>
          </a>
        ) : (
          <div className="pj-link">
            Instructions
            <span>No repo: each member reads the CLAUDE.md of its own workspace.</span>
          </div>
        )}
        <button className="pj-link" type="button" onClick={() => go(p.id, '#/settings/memory')}>
          Memory{counts && ` · ${counts.memory}`}
          <span>{p.name}'s own, plus the global ones. Opens Memory on {p.name}.</span>
        </button>
        <button className="pj-link" type="button" onClick={() => go(p.id, '#/settings/secrets')}>
          Secrets{counts && ` · ${counts.secrets}`}
          <span>Only {p.name}'s members can be granted them. Opens Secrets on {p.name}.</span>
        </button>
        <button className="pj-link" type="button" onClick={() => go(p.id, '#/workflows')}>
          Workflows · {wfs.length}
          <span>{p.name}'s scheduled and triggered work. Opens Workflows on {p.name}.</span>
        </button>
      </div>
      </SetSec>

      {!archived && (
        <>
          <SetSec title="Archive">
          <div className="model-list">
            <div className={'model-row pj-row' + (confirmArchive ? ' pj-wrap' : '')}>
              <div className="model-main">
                <div className="model-title">Archive {p.name}</div>
                <div className="model-detail">
                  <span>Stops its work and hides it. Nothing is deleted; restore it from this page.</span>
                </div>
              </div>
              {!confirmArchive && (
                <div className="model-actions">
                  <button type="button" className="btn ghost danger" onClick={() => setConfirmArchive(true)}>
                    Archive…
                  </button>
                </div>
              )}
              {confirmArchive && (
                <ArchiveConfirm p={p} running={running} open={open.length} workflows={wfs.filter((w) => w.enabled).length} onCancel={() => setConfirmArchive(false)} onError={onError} />
              )}
            </div>
          </div>
          </SetSec>
        </>
      )}
    </section>
  );
}

function AddMember(props: { agents: Agent[]; repo: string | null; project: string; onAdd(id: string): void; onCancel(): void }) {
  const [id, setId] = useState(props.agents[0]?.id ?? '');
  return (
    <div className="model-row pj-row pj-wrap">
      <div className="pj-inline">
        <label className="field">
          Add a member
          <select value={id} onChange={(e) => setId(e.target.value)}>
            {props.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {agentLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {props.repo ? (
            <>
              Atlas clones <code>{props.repo}</code> into its workspace, then opens its chat « {id} · {props.project} ».
            </>
          ) : (
            <>Atlas opens its chat « {id} · {props.project} ».</>
          )}
        </span>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary small" disabled={!id} onClick={() => props.onAdd(id)}>
            Add {id}
          </button>
        </div>
      </div>
    </div>
  );
}

function ArchiveConfirm(props: { p: Project; running: Card[]; open: number; workflows: number; onCancel(): void; onError(e: unknown): void }) {
  const { p, running } = props;
  const [busy, setBusy] = useState(false);
  const chats = p.members.filter((m) => m.mainChat).length;
  const runs: ReactNode = running.length ? (
    <>
      {running.length === 1 ? 'Its running task stops' : `Its ${running.length} running tasks stop`} ({running.map((c) => `#${c.number}${c.assignee ? ', ' + c.assignee : ''}`).join('; ')}); its other open tasks keep their state but don't start.
    </>
  ) : props.open ? (
    <>Nothing is running. Its {plural(props.open, 'open task')} keep their state but don't start.</>
  ) : (
    <>Nothing is running and it has no open task.</>
  );
  return (
    <div className="pj-inline">
      <b>Archive {p.name}?</b>
      <ul>
        <li>{runs}</li>
        <li>
          {props.workflows ? `Its ${plural(props.workflows, 'workflow')} turn off. ` : ''}
          {chats ? `Its ${plural(chats, 'chat')} « · ${p.name} » become read-only and leave the sidebar.` : `Its chats become read-only.`}
        </li>
        <li>Its tasks and artifacts stay readable: « Archived » in the project filter shows them.</li>
        <li>Workspaces, memory and secrets stay as they are.</li>
      </ul>
      <div className="actions">
        <button type="button" className="btn ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary small danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api.archiveProject(p.id).then(
              () => (location.hash = '#/settings/projects'),
              (e: unknown) => (setBusy(false), props.onError(e)),
            );
          }}
        >
          Archive {p.name}
        </button>
      </div>
    </div>
  );
}
