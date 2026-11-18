import { useCallback, useEffect, useRef, useState } from 'react';
import { cardRef, MEMORY_BUDGET, MEMORY_BUDGET_GLOBAL, MEMORY_REVIEW_EVERY as REVIEW_EVERY, MEMORY_TEXT_MAX, type Agent, type Card, type Memory, type MemoryKind, type Model, type Settings } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { HeaderActions, Icon } from './ScreenHeader.tsx';
import { Menu, PopRow } from './HeadMenu.tsx';
import { Avatar } from './Board.tsx';
import { StatusIcon } from './StatusIcon.tsx';
import { shortAgo } from './inboxView.ts';
import {
  chipCounts,
  DEFAULT_VIEW,
  KIND_BADGE,
  KIND_CHIPS,
  memoryHref,
  parseMemoryRoute,
  parseMemView,
  scopeLabel,
  shownMemories,
  sourceLink,
  type MemStatus,
  type MemView,
} from './memoryView.ts';

/**
 * Settings → Memory (#82, mockup canvas cv_ae0bb676 « mock »; Memory v2, design §8; in the Library until #87): every
 * memory of every agent. Chips by kind and status with counts, a scope filter, keyword search (FTS in the engine),
 * inline edit, pin, archive / restore, and a link to where it was said. #/settings/memory/<scope> filters a scope,
 * …/m12 shows one.
 */
export function MemoryPage(props: {
  /** What follows #/settings/memory: a scope, a memory id (m12), or nothing. */
  rest: string;
  agents: Agent[];
  cards: Card[];
  chats: Card[];
  stream: MessageStream;
  /** For the background review's model (v3). */
  settings: Settings | null;
  models: Model[];
  onSettings(s: Settings): void;
  onError(e: unknown): void;
}) {
  const { stream, onError } = props;
  const route = parseMemoryRoute(props.rest);
  const fromUrl = route.scope !== null || route.focus !== null;
  const [saved, setSaved] = useState(() => parseMemView(localStorage.getItem('atlas.memory.view')));
  // A scope in the URL wins over the saved one (links from Settings and agent cards).
  const view: MemView = { ...saved, scope: route.scope ?? (fromUrl ? null : saved.scope) };
  const save = (next: MemView) => {
    setSaved(next);
    localStorage.setItem('atlas.memory.view', JSON.stringify(next));
    if (fromUrl) location.hash = memoryHref(next.scope); // leave the scope / memory link once you filter
  };
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<Memory[] | null>(null);
  const [menu, setMenu] = useState(false);
  const [budget, setBudget] = useState<{ used: number; limit: number } | null>(null);

  // Typing searches after a short pause.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const agentOfScope = view.scope?.startsWith('agent:') ? view.scope.slice('agent:'.length) : null;
  const reload = useCallback(() => {
    api.memories({ scope: view.scope ?? undefined, q: query || undefined }).then(setList, onError);
    if (agentOfScope) api.memoryBudget(agentOfScope).then(setBudget, onError);
    else setBudget(null);
  }, [view.scope, query, agentOfScope, onError]);
  useEffect(() => {
    reload();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = stream.listen('memories', () => {
      clearTimeout(t);
      t = setTimeout(reload, 150);
    });
    return () => {
      clearTimeout(t);
      off();
    };
  }, [reload, stream]);

  // A memory link (…/m12): show it whatever the filters, scrolled to and highlighted.
  const [focused, setFocused] = useState<Memory | null>(null);
  useEffect(() => {
    if (route.focus === null) return setFocused(null);
    api.memory(route.focus).then(setFocused, onError);
  }, [route.focus, onError]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    listRef.current?.querySelector(`[data-mem="${focused.id}"]`)?.scrollIntoView({ block: 'center' });
  }, [focused, list]);

  const status: MemStatus = focused ? (focused.status === 'archived' ? 'archived' : 'live') : view.status;
  const kind = focused ? 'all' : view.kind;
  const counts = chipCounts(list ?? [], status === 'archived' ? 'archived' : 'live');
  // A memory link shows that memory alone (its live copy once the list has it), whatever the filters.
  const shown = focused ? [list?.find((m) => m.id === focused.id) ?? focused] : shownMemories(list ?? [], { kind, status });
  const scopes = ['global', 'shared', ...props.agents.map((a) => 'agent:' + a.id)];
  const update = (m: Memory, patch: Parameters<typeof api.updateMemory>[1]) =>
    api.updateMemory(m.id, patch).then((x) => {
      setList((l) => l && l.map((y) => (y.id === x.id ? x : y)));
      setFocused((f) => (f?.id === x.id ? x : f));
    }, (e: unknown) => {
      onError(e);
      throw e;
    });

  const setKind = (k: MemView['kind']) => save({ ...view, kind: k, status: 'live' });
  const setStatus = (s: MemStatus) => save({ ...view, kind: 'all', status: view.status === s ? 'live' : s });
  const chip = (on: boolean, label: string, n: number, onClick: () => void, title?: string) => (
    <button type="button" className={'mem-chip' + (on ? ' on' : '')} aria-pressed={on} title={title} onClick={onClick}>
      {label} <span className="tab-n">{n}</span>
    </button>
  );

  return (
    <div className="memory-page">
      <HeaderActions>
        <span className="head-sp" />
        <Menu
          open={menu}
          onOpen={setMenu}
          title="Filter by scope: global, shared in a project, or one agent's own"
          label={
            <>
              <Icon.filter />
              <span className="btn-text">{view.scope ? scopeLabel(view.scope) : 'Scope'}</span>
              {view.scope && <span className="tab-n">1</span>}
            </>
          }
        >
          <div className="pop-k">Scope</div>
          <PopRow on={view.scope === null} onClick={() => (save({ ...view, scope: null }), setMenu(false))}>
            Every scope
          </PopRow>
          {scopes.map((s) => (
            <PopRow key={s} on={view.scope === s} onClick={() => (save({ ...view, scope: s }), setMenu(false))}>
              {s === 'shared' || s === 'global' ? <Icon.memory /> : <Avatar id={s.slice('agent:'.length)} />}
              {s === 'shared' ? 'Shared in a project' : s === 'global' ? 'Global (yours, every project)' : scopeLabel(s)}
            </PopRow>
          ))}
        </Menu>
      </HeaderActions>
      <header className="section-head mem-intro">
        <h2>Memory</h2>
        <p>
          What every agent keeps. Rules, preferences and pinned memories are always in its instructions (up to {MEMORY_BUDGET}{' '}
          characters per agent in a project: global + the project's + its own, global at most {MEMORY_BUDGET_GLOBAL}); facts
          and task notes are recalled when a conversation matches them.
        </p>
        {props.settings && (
          <label className="field settings-field mem-review">
            Background review
            <select
              value={props.settings.memoryReviewModel ?? ''}
              onChange={(e) => api.updateSettings({ memoryReviewModel: e.target.value || null }).then(props.onSettings, onError)}
            >
              <option value="">Automatic (a Sonnet model)</option>
              {props.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
              <option value="off">Off</option>
            </select>
            <span className="hint">
              After a task ends and every {REVIEW_EVERY} messages of a chat, this model reads what's new and saves what is worth keeping
              (never secrets, never changes your own memories). Every change can be undone here.
            </span>
          </label>
        )}
      </header>
      <div className="mem-bar">
        <div className="mem-chips" role="group" aria-label="Kind and status">
          {KIND_CHIPS.map((k) => chip(!focused && view.status === 'live' && view.kind === k.id, k.label, counts[k.id], () => setKind(k.id)))}
          {chip(!focused && view.status === 'stale', 'Stale', counts.stale, () => setStatus('stale'), 'Task notes of a task that is done or closed: out of recall')}
          {chip(status === 'archived', 'Archived', counts.archived, () => setStatus('archived'), 'Forgotten memories: never deleted, restore them here')}
        </div>
        <label className="mem-search">
          <Icon.search />
          <input type="search" value={q} placeholder="Search memory…" aria-label="Search memory" onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {(budget || focused) && (
        <div className="mem-note">
          {focused ? (
            <>
              Showing <b>m{focused.id}</b>.{' '}
              <a className="sd-link" href={memoryHref(view.scope)}>
                Show every memory
              </a>
            </>
          ) : (
            budget && (
              <span className={budget.used > budget.limit ? 'over' : ''} title="Rules, preferences and pinned memories (own + shared) are in every prompt of this agent">
                Always on for @{agentOfScope}: <b className="num">{budget.used}</b> / {budget.limit} characters
              </span>
            )
          )}
        </div>
      )}
      <div className="lib-list mem-list" ref={listRef}>
        {list && !shown.length && (
          <div className="lib-empty">
            {list.length || query ? (
              <p>
                Nothing matches.{' '}
                {(query || view.kind !== 'all' || view.status !== 'live' || view.scope) && (
                  <button
                    className="sd-link"
                    onClick={() => {
                      setQ('');
                      save(DEFAULT_VIEW);
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </p>
            ) : (
              <p>No memories yet. Agents save rules, preferences, facts and task notes with memory_add; they show up here.</p>
            )}
          </div>
        )}
        {shown.length > 0 && (
          <div className="mem-head" aria-hidden="true">
            <span>Kind</span>
            <span>Memory</span>
            <span>Scope</span>
            <span>Confirmed</span>
            <span>Source</span>
            <span />
          </div>
        )}
        {shown.map((m) => (
          <MemoryRow key={m.id} m={m} focused={focused?.id === m.id} cards={props.cards} chats={props.chats} onUpdate={(p) => update(m, p)} />
        ))}
      </div>
    </div>
  );
}

function MemoryRow(props: { m: Memory; focused: boolean; cards: Card[]; chats: Card[]; onUpdate(p: Parameters<typeof api.updateMemory>[1]): Promise<void> }) {
  const { m } = props;
  const [edit, setEdit] = useState<{ text: string; kind: MemoryKind } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (p: Parameters<typeof api.updateMemory>[1]) => {
    setBusy(true);
    try {
      await props.onUpdate(p);
      return true;
    } catch {
      return false; // shown by onUpdate
    } finally {
      setBusy(false);
    }
  };
  const saveEdit = async () => {
    if (!edit) return;
    const text = edit.text.trim();
    if (!text) return;
    if (text === m.text && edit.kind === m.kind) return setEdit(null);
    if (await run({ text, kind: edit.kind })) setEdit(null);
  };
  const src = sourceLink(m, props.chats, location.hash.split('?')[0] ?? '');
  const srcCard = src && !src.chat ? props.cards.find((c) => c.id === src.cardId) : undefined;
  const srcChat = src?.chat ? props.chats.find((c) => c.id === src.cardId) : undefined;
  const archived = m.status === 'archived';
  return (
    <div className={'mem-row' + (m.status !== 'active' ? ' dim' : '') + (props.focused ? ' focus' : '') + (edit ? ' editing' : '')} data-mem={m.id}>
      <span className={'mem-k ' + m.kind}>{KIND_BADGE[m.kind]}</span>
      {edit ? (
        <form
          className="mem-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void saveEdit();
          }}
        >
          <textarea
            autoFocus
            rows={Math.min(6, Math.max(2, Math.ceil(edit.text.length / 70)))}
            maxLength={MEMORY_TEXT_MAX}
            value={edit.text}
            aria-label={`Edit m${m.id}`}
            onChange={(e) => setEdit({ ...edit, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setEdit(null);
              } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void saveEdit();
              }
            }}
          />
          <div className="mem-edit-bar">
            <select value={edit.kind} aria-label="Kind" onChange={(e) => setEdit({ ...edit, kind: e.target.value as MemoryKind })}>
              {(['rule', 'preference', 'fact', 'project'] as const).map((k) => (
                <option key={k} value={k}>
                  {k === 'project' ? 'task note' : k}
                </option>
              ))}
            </select>
            <span className="mem-len num">
              {edit.text.trim().length}/{MEMORY_TEXT_MAX}
            </span>
            <button type="button" className="head-btn" onClick={() => setEdit(null)}>
              Cancel
            </button>
            <button type="submit" className="head-btn pri" disabled={busy || !edit.text.trim()}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="mem-t" title={archived ? 'Restore it to edit' : 'Edit'} disabled={archived} onClick={() => setEdit({ text: m.text, kind: m.kind })}>
          {m.pinned && <span className="mem-pin-dot" aria-label="pinned" />}
          <span>{m.text}</span>
          <span className="mem-id">m{m.id}</span>
        </button>
      )}
      <span className="mem-scope">
        {m.scope === 'shared' || m.scope === 'global' ? m.scope : (
          <>
            <Avatar id={m.scope.slice('agent:'.length)} />
            <span>{m.scope.slice('agent:'.length)}</span>
          </>
        )}
      </span>
      <span className="mem-when" title={`Confirmed ${new Date(m.confirmedAt).toLocaleString()} · changed ${new Date(m.updatedAt).toLocaleString()} by ${m.updatedBy === 'user' ? 'you' : '@' + m.updatedBy}`}>
        {m.status === 'stale' ? 'stale' : archived ? 'archived' : shortAgo(m.confirmedAt)}
      </span>
      <span className="mem-src">
        {src ? (
          <a href={src.href} className={srcCard ? 'card-ref' : 'mem-src-link'} title={src.chat ? `Open the message in « ${srcChat?.title ?? 'chat'} »` : srcCard ? `${srcCard.title} · open the task` : 'Open the card'}>
            {srcCard && <StatusIcon status={srcCard.status} size={12} />}
            {srcCard ? cardRef(srcCard) : src.chat ? 'chat' : 'card'}
          </a>
        ) : (
          <span title="No source: migrated from the old memory, or added by hand">import</span>
        )}
      </span>
      <span className="mem-acts">
        {!archived && (
          <button type="button" className={'lib-pin' + (m.pinned ? ' on' : '')} aria-pressed={m.pinned} disabled={busy} title={m.pinned ? 'Unpin: no longer always in the prompt' : 'Pin: always in the prompt'} aria-label={(m.pinned ? 'Unpin' : 'Pin') + ` m${m.id}`} onClick={() => void run({ pinned: !m.pinned })}>
            <Icon.pin />
          </button>
        )}
        {m.status !== 'active' && (
          <button type="button" className="lib-pin" disabled={busy} title={archived ? 'Restore' : 'Make it active again (back in recall)'} aria-label={`Restore m${m.id}`} onClick={() => void run({ status: 'active' })}>
            <Icon.undo />
          </button>
        )}
        {!archived && (
          <button type="button" className="lib-pin" disabled={busy} title="Archive (forget): never deleted, restore it from Archived" aria-label={`Archive m${m.id}`} onClick={() => void run({ status: 'archived' })}>
            <Icon.archive />
          </button>
        )}
      </span>
    </div>
  );
}
