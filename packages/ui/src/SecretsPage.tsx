import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { SECRET_NAME_RE, type Account, type Agent, type Card, type Model, type SecretGrant, type SecretInfo, type SecretList, type SecretStoreStatus } from '@atlas/shared';
import { AgentFace } from './AgentFace.tsx';
import { api } from './api.ts';
import { withCard } from './cardModal.ts';
import { agentSecrets, agoText, cleanName, deleteText, grantees, modelKeyRow, storeLine, whenText } from './secretsView.ts';
import type { MessageStream } from './useMessages.ts';
import { HeaderActions } from './ScreenHeader.tsx';
import { effectiveFilter, inFilter, ProjectFilterButton, ProjTag, projectForNew, useProjectFilter, useProjects } from './projects.tsx';

/**
 * Settings → Secrets (#209, mockup #205): agent secrets (API keys, tokens, RPC URLs agents use as $NAME in shell
 * commands) and the model keys Atlas uses itself. Names and metadata only: a value goes in through a password field,
 * cleared right after, and never comes back. On a server, the secrets file is locked until its password is typed.
 */
export function SecretsPage(props: { agents: Agent[]; cards: Card[]; models: Model[]; status: SecretStoreStatus | null; userName: string | null; stream: MessageStream; onError(e: unknown): void }) {
  const { stream, onError } = props;
  const [list, setList] = useState<SecretList | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  /** The one row with an inline form open: replace (also « Add the value »), delete (also « Dismiss »), edit. */
  const [open, setOpen] = useState<{ name: string; mode: 'replace' | 'delete' | 'edit' } | null>(null);
  const [adding, setAdding] = useState(false);
  const reload = useCallback(() => {
    api.secrets().then(setList, onError);
    api.accounts().then(setAccounts, onError);
  }, [onError]);
  useEffect(() => {
    reload();
    return stream.listen('secrets', reload);
  }, [reload, stream]);
  const status = props.status ?? list?.status ?? null;
  useEffect(reload, [reload, status?.locked]);

  const pinfo = useProjects();
  const [pfRaw, setPf] = useProjectFilter();
  const pf = effectiveFilter(pfRaw, pinfo, true);
  if (!list || !status) return <div className="model-row skeleton" />;
  const locked = status.kind === 'file' && status.locked;
  const writable = status.kind !== 'env' && !locked;
  const allMine = agentSecrets(list.secrets);
  const mine = allMine.filter((s) => inFilter(pf, s.project, pinfo, true));
  const keys = list.secrets.filter((s) => s.kind === 'model_key');
  const allAgents = props.agents.map((a) => a.id);
  const toggle = (name: string, mode: 'replace' | 'delete' | 'edit') => {
    setAdding(false);
    setOpen((o) => (o?.name === name && o.mode === mode ? null : { name, mode }));
  };
  const done = () => {
    setOpen(null);
    reload();
  };
  const by = (who: string, card: string | null) =>
    who === 'user' ? (
      <span>by {props.userName || 'you'}</span>
    ) : (
      <span>
        by <Who id={who} />
        {card && <CardLink id={card} cards={props.cards} prefix=" in " />}
      </span>
    );

  return (
    <>
      {pinfo.multi && (
        <HeaderActions>
          <ProjectFilterButton value={pf} onChange={setPf} globalOnly count={(f) => allMine.filter((s) => inFilter(f, s.project, pinfo, true)).length} />
        </HeaderActions>
      )}
      <section>
        <header className="section-head">
          <h2>Agent secrets</h2>
          <p>
            API keys, tokens and RPC URLs your agents use in shell commands as <code>$NAME</code>. An agent sees only the names it's granted, never a value. Values can be
            replaced or deleted, never shown again.
          </p>
        </header>
        <StoreLine store={list.store} status={status} onError={onError} />
        {locked && <LockedPanel status={status} keys={keys.filter((k) => k.hasValue).map((k) => modelKeyRow(k, accounts, props.models).title)} onError={onError} />}
        <div className="model-list">
          {!mine.length && !adding && (
            <div className="empty-note">
              No agent secret yet. {writable ? 'Add one here, or an' : 'An'} agent saves one with its <span className="mono">secret_set</span> tool and it shows up here.
            </div>
          )}
          {adding && <SecretForm project={projectForNew(pf, pinfo)?.id ?? null} agents={props.agents} store={list.store} onCancel={() => setAdding(false)} onSaved={() => (setAdding(false), reload())} onError={onError} />}
          {mine.map((s) =>
            open?.name === s.name && open.mode === 'edit' ? (
              <SecretForm key={s.name} secret={s} agents={props.agents} store={list.store} onCancel={() => setOpen(null)} onReplace={() => setOpen({ name: s.name, mode: 'replace' })} onSaved={done} onError={onError} />
            ) : (
              <div key={s.name} className={'model-row sec-row' + (s.hasValue ? '' : ' sec-missing') + (locked ? ' sec-locked' : '') + (open?.name === s.name ? ' wrap' : '')} data-secret={s.name}>
                <div className="model-main">
                  <div className="model-title">
                    <span className="sec-name">{s.name}</span>
                    {!s.hasValue && <span className="badge bad">No value</span>}
                    <ProjTag id={s.project} global />
                    <GrantChips secret={s} />
                  </div>
                  {!s.hasValue && s.createdBy !== 'user' ? (
                    <div className="sec-desc">
                      Asked by <Who id={s.createdBy} />
                      {s.description ? `: « ${s.description} »` : ''}
                    </div>
                  ) : (
                    s.description && <div className="sec-desc">{s.description}</div>
                  )}
                  <div className="model-detail">
                    {!s.hasValue && s.waitingCard ? (
                      <span>
                        <CardLink id={s.waitingCard} cards={props.cards} /> is blocked until you add it
                      </span>
                    ) : (
                      <>
                        {by(s.createdBy, s.createdCard)}
                        <span>updated {whenText(s.updatedAt)}</span>
                        {s.hasValue ? (
                          <span>{s.lastUsedAt ? <>used {agoText(s.lastUsedAt)}{s.lastUsedBy && <> by <Who id={s.lastUsedBy} /></>}</> : 'never used'}</span>
                        ) : (
                          <span>no value yet</span>
                        )}
                        {s.hasValue && s.waitingCard && (
                          <span>
                            <CardLink id={s.waitingCard} cards={props.cards} /> waits until you grant it
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {writable && open?.name !== s.name && (
                  <div className="model-actions">
                    {s.hasValue ? (
                      <>
                        <button className="tool" onClick={() => toggle(s.name, 'replace')}>
                          Replace value
                        </button>
                        <button className="ghost" onClick={() => toggle(s.name, 'edit')}>
                          Edit
                        </button>
                        <button className="ghost danger" onClick={() => toggle(s.name, 'delete')}>
                          Delete
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="primary small" onClick={() => toggle(s.name, 'replace')}>
                          Add the value
                        </button>
                        <button className="ghost danger" onClick={() => toggle(s.name, 'delete')}>
                          Dismiss
                        </button>
                      </>
                    )}
                  </div>
                )}
                {writable && open?.name === s.name && open.mode === 'replace' && <ReplaceForm name={s.name} add={!s.hasValue} onDone={done} onCancel={() => setOpen(null)} onError={onError} />}
                {writable && open?.name === s.name && open.mode === 'delete' && (
                  <DeleteConfirm secret={s} cards={props.cards} allAgents={allAgents} onDone={done} onCancel={() => setOpen(null)} onError={onError} />
                )}
              </div>
            ),
          )}
          {writable && !adding && (
            <button className="model-row add" onClick={() => (setOpen(null), setAdding(true))}>
              + Add a secret
            </button>
          )}
        </div>
      </section>
      <section>
        <header className="section-head">
          <h2>Model keys</h2>
          <p>
            Keys Atlas uses to call models. They are never given to agents. Order, limits and on/off stay in <a href="#/settings/api-keys">API keys</a> and{' '}
            <a href="#/settings/model-list">Model list</a>.
          </p>
        </header>
        <div className="model-list">
          {!keys.length && (
            <div className="empty-note">
              {status.kind === 'env' ? "This engine reads model keys from its environment: they aren't listed here." : 'No model key stored yet. Add one in API keys or on a model in Model list.'}
            </div>
          )}
          {keys.map((k) => {
            const row = modelKeyRow(k, accounts, props.models);
            const account = accounts.find((a) => a.secret === k.name);
            return (
              <div key={k.name} className={'model-row sec-row' + (locked ? ' sec-locked' : '') + (open?.name === k.name ? ' wrap' : '')} data-secret={k.name}>
                <div className="model-main">
                  <div className="model-title">
                    <span className="sec-name">{row.title}</span>
                    <span className="sec-grant none">
                      <LockIcon />
                      Models only
                    </span>
                  </div>
                  <div className="sec-desc">{row.description}</div>
                  <div className="model-detail">
                    {by(k.createdBy, k.createdCard)}
                    <span>updated {whenText(k.updatedAt)}</span>
                    {(k.lastUsedAt ?? account?.lastUsedAt) ? <span>used {agoText((k.lastUsedAt ?? account?.lastUsedAt)!)}</span> : account && <span>never used</span>}
                  </div>
                </div>
                {writable && open?.name !== k.name && (
                  <div className="model-actions">
                    <button className="tool" onClick={() => toggle(k.name, 'replace')}>
                      Replace value
                    </button>
                    <button className="ghost" onClick={() => (location.hash = row.open.hash)}>
                      {row.open.label}
                    </button>
                  </div>
                )}
                {writable && open?.name === k.name && open.mode === 'replace' && <ReplaceForm name={k.name} onDone={done} onCancel={() => setOpen(null)} onError={onError} />}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

function LockIcon({ open }: { open?: boolean }) {
  return (
    <svg className="sec-lockic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d={open ? 'M5.5 7V5a2.5 2.5 0 0 1 4.9-.7' : 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'} />
    </svg>
  );
}

function Who({ id }: { id: string }) {
  return (
    <span className="sec-who">
      <AgentFace id={id} />
      {id}
    </span>
  );
}

/** #N of a task, opening its ticket; nothing when the task is gone (deleted). */
function CardLink({ id, cards, prefix }: { id: string; cards: Card[]; prefix?: string }) {
  const c = cards.find((x) => x.id === id);
  if (!c) return prefix ? null : <span>a task</span>;
  return (
    <>
      {prefix}
      <button type="button" className="linklike" title={c.title} onClick={() => (location.hash = withCard(location.hash, c.id))}>
        #{c.number}
      </button>
    </>
  );
}

function GrantChips({ secret: s }: { secret: SecretInfo }) {
  const pinfo = useProjects();
  const p = pinfo.multi ? pinfo.byId(s.project) : undefined;
  if (s.grant === 'all') return <span className="sec-grant all">{p ? `All of ${p.name}` : 'All agents'}</span>;
  if (s.grant === 'none' || !s.agents.length) return <span className="sec-grant none">No agent</span>;
  return (
    <>
      {s.agents.map((a) => (
        <span key={a} className="sec-grant">
          <AgentFace id={a} />
          {a}
        </span>
      ))}
    </>
  );
}

/** Where values are kept; on a server, how the file was unlocked, Lock now and Change the password. */
function StoreLine({ store, status, onError }: { store: string | null; status: SecretStoreStatus; onError(e: unknown): void }) {
  const [changing, setChanging] = useState(false);
  if (status.kind === 'file' && status.locked) return null;
  if (status.kind !== 'file')
    return (
      <div className="sec-store">
        <LockIcon />
        {status.kind === 'keychain' ? (
          <>
            <span>
              Encrypted with the <b>{store}</b>
            </span>
            <span>·</span>
            <span>new secrets: no agent until you grant one</span>
          </>
        ) : (
          <span>{storeLine(store, status)}</span>
        )}
      </div>
    );
  return (
    <>
      <div className="sec-store">
        <LockIcon open />
        <span>
          Server · <b>secrets.enc</b> {storeLine(store, status)}
        </span>
        <span>·</span>
        <button className="linklike" onClick={() => api.lockSecrets().catch(onError)}>
          Lock now
        </button>
        <button className="linklike" onClick={() => setChanging((c) => !c)}>
          Change the password
        </button>
      </div>
      {changing && <PasswordForm exists onDone={() => setChanging(false)} onCancel={() => setChanging(false)} onError={onError} />}
    </>
  );
}

/** Server, locked: the password to unlock, what waits meanwhile. No file yet: the first password creates it. */
function LockedPanel({ status, keys, onError }: { status: SecretStoreStatus; keys: string[]; onError(e: unknown): void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlock = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    api
      .unlockSecrets(password)
      .then(
        () => setPassword(''),
        (err: Error) => {
          setPassword('');
          setError(err.message);
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="sec-lock">
      <span className="sec-lock-ic">
        <LockIcon />
      </span>
      <div className="sec-lock-main">
        <h3>{status.exists ? 'Secrets are locked' : 'No secrets password yet'}</h3>
        {status.exists ? (
          <>
            <p>
              Atlas restarted on the server. Its secrets file (<code>secrets.enc</code>) stays encrypted until you type the secrets password.
            </p>
            <form className="key-form" onSubmit={unlock}>
              <input type="password" autoComplete="current-password" placeholder="Secrets password" aria-label="Secrets password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button className="primary small" disabled={!password || busy}>
                {busy ? 'Unlocking…' : 'Unlock'}
              </button>
            </form>
          </>
        ) : (
          <>
            <p>
              On a server, secrets are kept in an encrypted file (<code>secrets.enc</code>) in the data folder. Choose its password: Atlas never stores it, and nobody can
              recover the secrets without it.
            </p>
            <PasswordForm exists={false} onDone={() => undefined} onError={onError} />
          </>
        )}
        {(error ?? status.error) && <p className="error-text">{error ?? `ATLAS_SECRETS_PASSWORD did not unlock it: ${status.error}`}</p>}
        <div className="sec-paused">Paused until you unlock</div>
        <ul>
          <li>Shell commands that use a secret: they stop with « secrets are locked », the task waits and goes on after the unlock.</li>
          {keys.length > 0 && (
            <li>
              Models whose key is here (<span className="mono">{keys.join(', ')}</span>): their runs wait.
            </li>
          )}
          <li>New secrets from agents.</li>
        </ul>
        <p>
          Everything else keeps working: subscriptions, local models, commands without a secret. To unlock at every start, set <code>ATLAS_SECRETS_PASSWORD</code> in the
          server's environment.
        </p>
      </div>
    </div>
  );
}

/** The first secrets password (no file yet), or a new one (the current one first). Fields are cleared after. */
function PasswordForm({ exists, onDone, onCancel, onError }: { exists: boolean; onDone(): void; onCancel?(): void; onError(e: unknown): void }) {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const mismatch = !!f.again && f.next !== f.again;
  const ok = (!exists || !!f.current) && f.next.length >= 8 && f.next === f.again;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    api
      .secretsPassword(exists ? { current: f.current, next: f.next } : { next: f.next })
      .then(() => {
        setF({ current: '', next: '', again: '' });
        onDone();
      }, onError)
      .finally(() => setBusy(false));
  };
  return (
    <form className="sec-password" onSubmit={submit}>
      <div className="field-row">
        {exists && (
          <label className="field">
            Current password
            <input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
          </label>
        )}
        <label className="field">
          {exists ? 'New password' : 'Password'} <span className="sec-opt">· 8 characters or more</span>
          <input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
        </label>
        <label className="field">
          Again
          <input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} aria-invalid={mismatch} />
        </label>
      </div>
      {mismatch && <p className="error-text">The two passwords differ.</p>}
      <div className="actions">
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="primary small" disabled={!ok || busy}>
          {exists ? 'Change the password' : 'Set the password'}
        </button>
      </div>
    </form>
  );
}

/** A new value (rotation), or the first value of a secret an agent asked for. The field is cleared after. */
function ReplaceForm({ name, add, onDone, onCancel, onError }: { name: string; add?: boolean; onDone(): void; onCancel(): void; onError(e: unknown): void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    api
      .setSecret(name, value)
      .then(
        () => {
          setValue('');
          onDone();
        },
        (err: unknown) => {
          setValue('');
          onError(err);
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="sec-inline">
      <form className="key-form" onSubmit={submit}>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          placeholder={`Paste the ${add ? '' : 'new '}value of ${name}`}
          aria-label={`${add ? 'Value' : 'New value'} of ${name}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary small" disabled={!value.trim() || busy}>
          {add ? 'Add' : 'Replace'}
        </button>
      </form>
      <p className="muted form-note">
        {add
          ? 'Never shown again. The task waiting for it goes back to work by itself.'
          : 'The old value is gone once you replace it. A command already running keeps it; the next command gets the new one.'}
      </p>
    </div>
  );
}

function DeleteConfirm(props: { secret: SecretInfo; cards: Card[]; allAgents: string[]; onDone(): void; onCancel(): void; onError(e: unknown): void }) {
  const s = props.secret;
  const dismiss = !s.hasValue;
  const del = () => api.deleteSecret(s.name).then(props.onDone, props.onError);
  return (
    <div className="sec-inline">
      <div className="actions">
        <span className="confirm-text">
          {dismiss ? (
            <>
              Dismiss <b className="mono">{s.name}</b>?{' '}
              {s.waitingCard ? (
                <>
                  <CardLink id={s.waitingCard} cards={props.cards} /> stays blocked: answer it in its thread.
                </>
              ) : (
                'The row goes away.'
              )}
            </>
          ) : (
            <>
              Delete <b className="mono">{s.name}</b> for good? {deleteText({ name: s.name, grant: s.grant, agents: grantees(s, props.allAgents) })}
            </>
          )}
        </span>
        <button type="button" className="ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="primary small danger" onClick={() => void del()}>
          {dismiss ? 'Dismiss' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

/** Add (no `secret`) or Edit: name (fixed once made), description, value (add only), who gets it. */
function SecretForm(props: { secret?: SecretInfo; project?: string | null; agents: Agent[]; store: string | null; onCancel(): void; onReplace?(): void; onSaved(): void; onError(e: unknown): void }) {
  const s = props.secret;
  const [name, setName] = useState(s?.name ?? '');
  const [description, setDescription] = useState(s?.description ?? '');
  const [value, setValue] = useState('');
  const [grant, setGrant] = useState<SecretGrant>(s?.grant ?? 'none');
  const [picked, setPicked] = useState<string[]>(s?.agents ?? []);
  const [busy, setBusy] = useState(false);
  const pinfo = useProjects();
  // Its project: null = global. With one project the form has no Project field and a new secret stays global, as before.
  const [projectId, setProjectId] = useState<string | null>(s ? s.project : (props.project ?? null));
  const project = pinfo.multi ? pinfo.byId(projectId) : undefined;
  // A project's secret can be granted to its members only.
  const agents = project ? props.agents.filter((a) => project.members.some((m) => m.agentId === a.id)) : props.agents;
  const nameOk = SECRET_NAME_RE.test(name);
  const ok = nameOk && (s || value.trim()) && (grant !== 'agents' || picked.length > 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ids = grant === 'agents' ? picked.filter((id) => agents.some((a) => a.id === id)) : [];
    const where = pinfo.multi ? projectId : (s?.project ?? null);
    (s
      ? api.updateSecret(s.name, { description, grant, agents: ids, ...(pinfo.multi && where !== s.project ? { project: where } : {}) })
      : api.createSecret({ name, description, value, grant, agents: ids, project: where }))
      .then(
        () => {
          setValue('');
          props.onSaved();
        },
        (err: unknown) => {
          setValue('');
          props.onError(err);
        },
      )
      .finally(() => setBusy(false));
  };
  const shown = name || 'NAME';
  const describe = (
    <label className="field">
      <span>
        Description <span className="sec-opt">· optional, agents read it</span>
      </span>
      <input value={description} maxLength={500} autoFocus={!!s} onChange={(e) => setDescription(e.target.value)} placeholder="What it opens, and for what" />
    </label>
  );
  return (
    <form className="model-row new sec-form" onSubmit={submit} data-secret-form={s ? 'edit' : 'add'}>
      <div className="field-row">
        <label className="field">
          Name
          <input className="mono" value={name} disabled={!!s} autoFocus={!s} autoComplete="off" spellCheck={false} placeholder="DUNE_API_KEY" onChange={(e) => setName(cleanName(e.target.value))} aria-invalid={!!name && !nameOk} />
        </label>
        {pinfo.multi ? (
          <label className="field">
            Project
            <select value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)}>
              {pinfo.active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="">Global · every project</option>
            </select>
          </label>
        ) : (
          describe
        )}
      </div>
      {pinfo.multi && describe}
      {s ? (
        <div className="field">
          Value
          <div className="sec-value-set">
            <span className="sec-dots" aria-label="hidden">
              ••••••••
            </span>
            <span className="muted">set {whenText(s.updatedAt)}, never shown again</span>
            <button type="button" className="tool" onClick={props.onReplace}>
              Replace value
            </button>
          </div>
        </div>
      ) : (
        <label className="field">
          Value
          <input type="password" className="mono" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
      )}
      <div className="field">
        Agents
        <div className="segmented" role="radiogroup" aria-label="Agents">
          {(
            [
              ['none', 'No agent'],
              ['agents', 'Selected agents'],
              ['all', project ? `All of ${project.name}` : 'All agents'],
            ] as const
          ).map(([g, label]) => (
            <button key={g} type="button" role="radio" aria-checked={grant === g} className={grant === g ? 'on' : ''} onClick={() => setGrant(g)}>
              {label}
            </button>
          ))}
        </div>
        {grant === 'agents' && (
          <div className="sec-pick">
            {agents.map((a) => {
              const on = picked.includes(a.id);
              return (
                <label key={a.id} className={on ? 'on' : ''}>
                  <input type="checkbox" checked={on} onChange={() => setPicked(on ? picked.filter((x) => x !== a.id) : [...picked, a.id])} />
                  <AgentFace id={a.id} />
                  {a.id}
                </label>
              );
            })}
          </div>
        )}
      </div>
      <p className="muted form-note">
        {pinfo.multi && (
          <>
            {project ? `A ${project.name} secret reaches only ${project.name}'s members, and only in their ${project.name} runs.` : 'A global secret reaches the agents you pick in every project.'}{' '}
          </>
        )}
        {s ? (
          <>
            The name stays <code>${s.name}</code>: to rename it, add a new secret and delete this one.
          </>
        ) : (
          <>
            Letters, digits and _ only. {props.store ? `Encrypted with the ${props.store} and never shown again.` : 'Never shown again.'} Agents use it as <code>${shown}</code>; if
            a value of 8 characters or more shows up in a command's output, the chat shows <code>[secret {shown}]</code> instead.
          </>
        )}
      </p>
      <div className="actions">
        <button type="button" className="ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="primary small" disabled={!ok || busy}>
          {s ? 'Save' : 'Add'}
        </button>
      </div>
    </form>
  );
}



/** Sidebar, server only: « Secrets locked · Unlock » while secrets.enc is locked (#208), styled as the update badge. */
export function SecretsBadge({ status, onOpen }: { status: SecretStoreStatus | null; onOpen(): void }) {
  if (status?.kind !== 'file' || !status.locked) return null;
  return (
    <button type="button" className="update-badge failed sec-badge" onClick={onOpen} title="Commands that use a secret wait until you unlock them">
      <span className="update-dot" aria-hidden="true" />
      <span className="update-badge-label">{status.exists ? 'Secrets locked' : 'Secrets: set a password'}</span>
      <span className="update-badge-v">Unlock</span>
    </button>
  );
}
