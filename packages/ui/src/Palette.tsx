import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cardRef, type Agent, type Card, type Doc } from '@atlas/shared';
import { api } from './api.ts';
import { Icon } from './ScreenHeader.tsx';
import { KindIcon } from './Viewer.tsx';
import { StatusIcon, STATUS_LABEL } from './StatusIcon.tsx';
import { Avatar } from './Board.tsx';
import { moveSel, rank, sectionOrder, type PaletteItem } from './palette.ts';
import { SETTINGS_PAGES } from './settingsPages.ts';
import { SHORTCUTS } from './keys.ts';

/** A palette row: what it shows and what ↵ does. */
interface Row extends PaletteItem {
  icon: ReactNode;
  /** Right side: a shortcut (kbd) or a faint note. */
  kbd?: string;
  note?: string;
  run(): void;
}

export interface PaletteContext {
  /** The screen (route view) the palette was opened on. */
  view: string;
  /** Its label, shown as a chip in the input. */
  label: string;
  /** The open chat, if any: its documents rank first, and artifacts open in its panel. */
  chatId: string | null;
}

/**
 * The ⌘K palette (design §16, mockup linear.html?screen=palette): artifacts, chats, cards (#number or title),
 * navigation and actions in sections, scoped to the current screen. ↑/↓ move, ↵ opens, Esc closes.
 */
export function Palette(props: {
  ctx: PaletteContext;
  cards: Card[];
  chats: Card[];
  agents: Agent[];
  theme: 'dark' | 'light';
  go(hash: string): void;
  onOpenCard(id: string): void;
  onNewCard(): void;
  onTogglePanel(): void;
  onTheme(t: 'dark' | 'light'): void;
  onHelp(): void;
  onClose(): void;
  onError(e: unknown): void;
}) {
  const { ctx, onClose, onError } = props;
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [docs, setDocs] = useState<Doc[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
    api.documents().then((ds) => setDocs([...ds].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))), onError);
  }, [onError]);

  const rows = useMemo<Row[]>(() => {
    const act = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const openDoc = (d: Doc) =>
      act(() => {
        if (ctx.chatId) api.panelOpen(ctx.chatId, d.id).catch(onError);
        else props.go('#/library/' + encodeURIComponent(d.id));
      });
    const out: Row[] = [];
    for (const d of docs)
      out.push({
        id: 'doc:' + d.id,
        section: 'Artifacts',
        title: d.title,
        keywords: [d.path, '@' + d.agentId].join(' '),
        boost: ctx.chatId && d.chatId === ctx.chatId ? 40 : d.pinned ? 10 : 0,
        icon: <KindIcon kind={d.kind} />,
        note: d.path,
        run: openDoc(d),
      });
    for (const c of props.chats)
      out.push({
        id: 'chat:' + c.id,
        section: 'Chats',
        title: c.title,
        keywords: '@' + (c.assignee ?? ''),
        icon: <Avatar id={c.assignee ?? '?'} />,
        note: c.id === ctx.chatId ? 'open' : undefined,
        run: act(() => props.go('#/chat/' + c.id)),
      });
    const byRecent = [...props.cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const c of byRecent)
      out.push({
        id: 'card:' + c.id,
        section: 'Tasks',
        title: c.title,
        number: c.number,
        keywords: [cardRef(c), '@' + (c.assignee ?? ''), STATUS_LABEL[c.status]].join(' '),
        boost: ctx.chatId && c.originCard === ctx.chatId ? 40 : c.status === 'blocked' || c.status === 'review' ? 10 : 0,
        icon: <StatusIcon status={c.status} />,
        note: cardRef(c),
        run: act(() => props.onOpenCard(c.id)),
      });
    const nav = (id: string, title: string, hash: string, icon: ReactNode, kbd?: string, keywords?: string) =>
      out.push({ id, section: 'Navigation', title, icon, kbd, keywords, run: act(() => props.go(hash)) });
    nav('go:inbox', 'Go to Inbox', '#/inbox', <Icon.inbox />, 'G I');
    nav('go:board', 'Go to Tasks', '#/board', <Icon.board />, 'G T', 'board cards');
    nav('go:library', 'Go to Library', '#/library', <Icon.library />, 'G L', 'documents artifacts');
    nav('go:workflows', 'Go to Workflows', '#/workflows', <Icon.workflows />, 'G W');
    for (const p of SETTINGS_PAGES) nav('go:settings:' + p.id, 'Settings: ' + p.label, '#/settings/' + p.id, <Icon.gear />, undefined, 'preferences');
    const action = (id: string, title: string, icon: ReactNode, run: () => void, kbd?: string, keywords?: string) =>
      out.push({ id, section: 'Actions', title, icon, kbd, keywords, run: act(run) });
    action('new-card', 'New task', <Icon.plus />, props.onNewCard, 'C', 'create ticket issue');
    action('new-chat', 'Main chat', <Icon.edit />, () => props.go('#/chat/new'), '⌘N');
    for (const a of props.agents) action('new-chat:' + a.id, `Chat with @${a.id}`, <Avatar id={a.id} />, () => props.go('#/chat/' + (a.mainChat ?? a.id)));
    if (ctx.view === 'chat' && ctx.chatId) action('panel', 'Show / hide documents panel', <Icon.doc />, props.onTogglePanel, '⌘\\', 'side panel toggle');
    const other = props.theme === 'dark' ? 'light' : 'dark';
    action('theme', `Switch to ${other} theme`, other === 'light' ? <Icon.sun /> : <Icon.moon />, () => props.onTheme(other), undefined, 'appearance mode');
    action('help', 'Keyboard shortcuts', <Icon.list />, props.onHelp, '?', 'help keys cheat sheet');
    return out;
  }, [docs, props.chats, props.cards, props.agents, props.theme, ctx.chatId, ctx.view]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => rank(rows, query, sectionOrder(ctx.view)), [rows, query, ctx.view]);
  const flat = groups.flatMap((g) => g.items.map((r) => r.item));
  const current = Math.min(sel, Math.max(flat.length - 1, 0));
  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.pal-op.on')?.scrollIntoView({ block: 'nearest' });
  }, [current, query]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) setSel(moveSel(flat.length, current, 1));
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) setSel(moveSel(flat.length, current, -1));
    else if (e.key === 'Enter') flat[current]?.run();
    else if (e.key === 'Escape') onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  let n = -1;
  return (
    <div className="pal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pal" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <div className="pal-in">
          <Icon.search />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search artifacts, chats, tasks (#12), actions…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-list"
            aria-activedescendant={flat[current] ? 'pal-' + current : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="pal-ctx" title="Where the palette was opened">{ctx.label}</span>
        </div>
        <div className="pal-list" id="pal-list" role="listbox" ref={list}>
          {!flat.length && <p className="pal-empty">Nothing matches « {query} ».</p>}
          {groups.map((g) => (
            <div key={g.section} role="group" aria-label={g.section}>
              <div className="pal-sec">{g.section}</div>
              {g.items.map(({ item, match }) => {
                n += 1;
                const i = n;
                return (
                  <div
                    key={item.id}
                    id={'pal-' + i}
                    role="option"
                    aria-selected={i === current}
                    className={'pal-op' + (i === current ? ' on' : '')}
                    onMouseMove={() => i !== current && setSel(i)}
                    onClick={item.run}
                  >
                    <span className="pal-ic">{item.icon}</span>
                    <span className="pal-t">{highlight(item.title, match.hits)}</span>
                    {item.kbd ? <Kbd keys={item.kbd} /> : item.note ? <span className="pal-note">{item.note}</span> : null}
                    {i === current && <span className="kbd pal-enter">↵</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="pal-foot">
          <span><span className="kbd">↑</span><span className="kbd">↓</span> move</span>
          <span><span className="kbd">↵</span> open</span>
          <span><span className="kbd">esc</span> close</span>
        </div>
      </div>
    </div>
  );
}

/** The matched letters in bold. */
function highlight(text: string, hits: number[]): ReactNode {
  if (!hits.length) return text;
  const set = new Set(hits);
  const out: ReactNode[] = [];
  let run = '';
  let on = false;
  const flush = (k: number) => {
    if (run) out.push(on ? <b key={k}>{run}</b> : run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i);
    if (h !== on) {
      flush(i);
      on = h;
    }
    run += text[i];
  }
  flush(text.length);
  return out;
}

/** « G B » → two keys. */
export function Kbd({ keys }: { keys: string }) {
  return (
    <span className="kbds">
      {keys.split(' ').map((k, i) => (
        <span key={i} className="kbd">
          {k}
        </span>
      ))}
    </span>
  );
}

/** The « ? » cheat sheet. */
export function ShortcutsSheet({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <div className="pal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pal keys-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="keys-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon.x />
          </button>
        </div>
        <div className="keys-body">
          {groups.map((g) => (
            <section key={g}>
              <div className="pal-sec">{g}</div>
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <div key={s.label} className="keys-row">
                  <span>{s.label}</span>
                  <Kbd keys={s.keys.join(' ')} />
                </div>
              ))}
            </section>
          ))}
        </div>
        <p className="keys-note">Letter keys are ignored while you type in a field. In a browser, ⌘N may open a new window instead: use ⌘K → Main chat.</p>
      </div>
    </div>
  );
}
