import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Memory, MemoryChange, MemoryProposal } from '@atlas/shared';
import { api, ApiError } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { Icon } from './ScreenHeader.tsx';
import { shortAgo } from './inboxView.ts';
import { ACTION_LABEL, digestChanges, digestItem, KIND_BADGE, memoryHref, parseMarks, scopeLabel, undoable, type DigestMarks } from './memoryView.ts';

const MARKS = 'atlas.memory.digest';

/**
 * The daily memory digest (#82): the last 24 h of memory changes by agents, as one Inbox update. Read and archive
 * marks are this browser's (localStorage), the changes the engine's (GET /api/memories/changes).
 */
export function useMemoryDigest(stream: MessageStream, onError: (e: unknown) => void, enabled: boolean) {
  const [changes, setChanges] = useState<MemoryChange[]>([]);
  const [memories, setMemories] = useState<Map<number, Memory>>(new Map());
  const [marks, setMarksState] = useState<DigestMarks>(() => parseMarks(localStorage.getItem(MARKS)));
  const setMarks = (m: DigestMarks) => {
    setMarksState(m);
    localStorage.setItem(MARKS, JSON.stringify(m));
  };
  const reload = useCallback(() => {
    api.memoryChanges().then(async (cs) => {
      setChanges(cs);
      // The memories' current text (a change only carries the text before it).
      if (cs.length) setMemories(new Map((await api.memories()).map((m) => [m.id, m])));
    }).catch(onError);
  }, [onError]);
  useEffect(() => {
    if (!enabled) return; // not logged in yet (server mode)
    reload();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = stream.listen('memories', () => {
      clearTimeout(t);
      t = setTimeout(reload, 300);
    });
    // The window slides: drop changes older than a day every hour.
    const tick = setInterval(reload, 3600_000);
    return () => {
      clearTimeout(t);
      clearInterval(tick);
      off();
    };
  }, [reload, stream, enabled]);
  const item = useMemo(() => digestItem(changes, marks), [changes, marks]);
  return {
    item,
    changes,
    memories,
    marks,
    seen: () => item && setMarks({ ...marks, seen: item.at }),
    archive: () => item && setMarks({ seen: item.at, archived: item.at }),
    reload,
  };
}
export type MemoryDigestState = ReturnType<typeof useMemoryDigest>;

/** The digest's detail in the Inbox: one line per change, with Undo. */
export function DigestBody({ digest, onError }: { digest: MemoryDigestState; onError(e: unknown): void }) {
  const list = digestChanges(digest.changes, digest.marks);
  const open = undoable(digest.changes);
  const [busy, setBusy] = useState<number | null>(null);
  const [refused, setRefused] = useState<Map<number, string>>(new Map());
  const undo = (c: MemoryChange) => {
    setBusy(c.id);
    api.undoMemoryChange(c.id).then(
      () => {
        setBusy(null);
        digest.reload();
      },
      (e: unknown) => {
        setBusy(null);
        if (e instanceof ApiError && e.status === 409) setRefused((r) => new Map(r).set(c.id, e.message));
        else onError(e);
      },
    );
  };
  return (
    <>
      <ul className="mem-digest">
        {list.map((c) => {
          const m = digest.memories.get(c.memoryId);
          const undone = !!c.undoneBy;
          const canUndo = !undone && open.has(c.id);
          return (
            <li key={c.id} className={undone ? 'undone' : ''}>
              <div className="md-l1">
                <span className={'mem-k ' + (m?.kind ?? '')}>{m ? KIND_BADGE[m.kind] : 'memory'}</span>
                <span className="md-act">{ACTION_LABEL[c.action]}</span>
                <span className="md-by">{c.action === 'stale' ? 'task closed' : '@' + c.by}</span>
                {m && <span className="md-by">· {scopeLabel(m.scope)}</span>}
                <span className="md-when">{shortAgo(c.at)}</span>
              </div>
              <div className="md-text">
                {c.action === 'update' && c.before && c.before.text !== m?.text && <del>{c.before.text}</del>}
                <a href={memoryHref(c.memoryId)} title={`Open m${c.memoryId} in Settings → Memory`}>
                  {m?.text ?? `m${c.memoryId}`}
                </a>
              </div>
              <div className="md-foot">
                {undone ? (
                  <span className="md-note">Undone</span>
                ) : refused.get(c.id) ? (
                  <span className="md-note bad">{refused.get(c.id)}</span>
                ) : (
                  <button
                    type="button"
                    className="head-btn"
                    disabled={!canUndo || busy === c.id}
                    title={canUndo ? undoTitle(c) : 'A newer change of this memory came after: undo that one first'}
                    onClick={() => undo(c)}
                  >
                    <Icon.undo /> Undo
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="ibx-note">
        Memory your agents saved or changed in the last day. Undo puts back the text before the change, or archives a new memory. Everything is in{' '}
        <a href={memoryHref()}>Settings → Memory</a>. E archives this digest; the next change brings it back.
      </p>
    </>
  );
}

const undoTitle = (c: MemoryChange) => (c.action === 'add' ? 'Archive this new memory' : 'Put back the memory as it was before this change');

const PROPOSAL_LABEL: Record<MemoryProposal['action'], string> = { merge: 'Merge', update: 'Fix', archive: 'Archive' };

/** What a proposal changes, in a line: a merge's new text, a fix's new kind or scope. */
function proposalChange(p: MemoryProposal): string {
  const parts = [p.kind && `kind → ${p.kind}`, p.scope && `scope → ${scopeLabel(p.scope)}`].filter(Boolean);
  return parts.join(' · ');
}

/**
 * The weekly memory cleanup's Inbox item (#83): one line per proposal, approved or rejected one by one. Nothing changes
 * before Approve; the engine applies a proposal in one transaction and refuses it if one of its memories changed since.
 */
export function CleanupBody({ cardId, summary, stream, onError }: { cardId: string; summary: string; stream: MessageStream; onError(e: unknown): void }) {
  const [list, setList] = useState<MemoryProposal[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [refused, setRefused] = useState<Map<number, string>>(new Map());
  const reload = useCallback(() => {
    api.memoryProposals(cardId).then(setList, onError);
  }, [cardId, onError]);
  useEffect(() => {
    reload();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = stream.listen('memories', (e) => {
      if (e.type !== 'proposal' || e.proposal.cardId !== cardId) return;
      clearTimeout(t);
      t = setTimeout(reload, 150);
    });
    return () => {
      clearTimeout(t);
      off();
    };
  }, [reload, stream, cardId]);
  const decide = (p: MemoryProposal, approve: boolean) => {
    setBusy(p.id);
    (approve ? api.approveProposal(p.id) : api.rejectProposal(p.id)).then(
      (np) => {
        setBusy(null);
        setList((l) => l && l.map((x) => (x.id === np.id ? np : x)));
      },
      (e: unknown) => {
        setBusy(null);
        if (e instanceof ApiError && e.status === 409) setRefused((r) => new Map(r).set(p.id, e.message));
        else onError(e);
      },
    );
  };
  const pending = list?.filter((p) => p.status === 'pending').length ?? 0;
  return (
    <>
      {list === null ? null : list.length === 0 ? (
        <p className="ibx-note">{summary || 'Nothing to clean up this week.'}</p>
      ) : (
        <ul className="mem-digest">
          {list.map((p) => {
            const first = p.memories[0];
            const change = proposalChange(p);
            return (
              <li key={p.id} className={p.status === 'rejected' ? 'undone' : ''}>
                <div className="md-l1">
                  <span className={'mem-k ' + (p.action === 'archive' ? 'project' : 'rule')}>{PROPOSAL_LABEL[p.action]}</span>
                  <span className="md-act">{p.reason}</span>
                  {first && <span className="md-by">{scopeLabel(first.scope)}</span>}
                </div>
                <div className="md-text">
                  {p.action === 'archive' ? (
                    p.memories.map((m) => (
                      <a key={m.id} href={memoryHref(m.id)} title={`Open m${m.id} in Settings → Memory`}>
                        {p.status === 'approved' ? <del>{m.text}</del> : m.text}
                      </a>
                    ))
                  ) : (
                    <>
                      {/* Pending with a new text: the old ones struck, then the proposed text. Else the memory as it is now. */}
                      {p.status === 'pending' && p.text ? (
                        <>
                          {p.memories.map((m) => (
                            <del key={m.id}>{m.text}</del>
                          ))}
                          <span>{p.text}</span>
                        </>
                      ) : (
                        first && (
                          <a href={memoryHref(first.id)} title={`Open m${first.id} in Settings → Memory`}>
                            {first.text}
                          </a>
                        )
                      )}
                      {change && <span className="md-note">{change}</span>}
                    </>
                  )}
                </div>
                <div className="md-foot">
                  {p.status !== 'pending' ? (
                    <span className="md-note">{p.status === 'approved' ? 'Applied' : 'Rejected'}</span>
                  ) : refused.get(p.id) ? (
                    <span className="md-note bad">{refused.get(p.id)}</span>
                  ) : (
                    <span className="md-btns">
                      <button type="button" className="head-btn pri" disabled={busy === p.id} onClick={() => decide(p, true)}>
                        Approve
                      </button>
                      <button type="button" className="head-btn" disabled={busy === p.id} onClick={() => decide(p, false)}>
                        Reject
                      </button>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="ibx-note">
        The weekly memory cleanup{pending ? `: ${pending} proposal${pending === 1 ? '' : 's'} left` : ''}. Nothing changes until you approve a line; an
        applied one shows in the memory digest, where Undo puts it back. Everything is in <a href={memoryHref()}>Settings → Memory</a>.
      </p>
    </>
  );
}
