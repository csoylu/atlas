import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { rowTime, type RowTone } from './chatRow.ts';
import type { Meta, RowIcon } from './toolRows.ts';

/**
 * One compact line in a chat (#58, #59): icon · verb · object · rest · meta · time · ›, that expands its details inline
 * on click. Card reports, tool calls and « N steps » groups. The verb is muted, the object bright, meta faint. Slots
 * may hold their own buttons (e.g. a #N link): they must stop propagation so their click doesn't also toggle the row.
 */
export function ChatRow(props: {
  icon: ReactNode;
  verb: ReactNode;
  object?: ReactNode;
  /** Object in the mono font (commands, patterns). */
  mono?: boolean;
  rest?: ReactNode;
  meta?: ReactNode;
  /** ISO time shown at the right. */
  at?: string;
  tone?: RowTone;
  /** Spinner icon, shimmering verb (the caller gives the present tense and a live timer in meta). */
  running?: boolean;
  /** A step inside a group's timeline: borderless. */
  nested?: boolean;
  /** Shown under the line when expanded; without it the row doesn't expand. */
  children?: ReactNode;
  defaultOpen?: boolean;
  /** Opens the row when it turns true (a run that just ended on this step). */
  forceOpen?: boolean;
  /** Open while true, closed again when it turns false (a running command's live tail). */
  autoOpen?: boolean;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(!!props.autoOpen || (props.defaultOpen ?? props.forceOpen ?? false));
  const wasAuto = useRef(props.autoOpen);
  // Before forceOpen: a step that ends and fails in the same update closes, then opens on the failure.
  useEffect(() => {
    if (props.autoOpen) setOpen(true);
    else if (wasAuto.current) setOpen(false);
    wasAuto.current = props.autoOpen;
  }, [props.autoOpen]);
  useEffect(() => {
    if (props.forceOpen) setOpen(true);
  }, [props.forceOpen]);
  const id = useId();
  const expandable = props.children !== undefined && props.children !== null && props.children !== false;
  const toggle = () => expandable && setOpen((o) => !o);
  const cls = ['chat-row', 'tone-' + (props.tone ?? 'plain'), open && expandable && 'open', props.running && 'running', props.nested && 'nested', props.className];
  return (
    <div className={cls.filter(Boolean).join(' ')}>
      <div
        className={'chat-row-line' + (expandable ? ' expandable' : '')}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? id : undefined}
        title={props.title ?? (expandable ? (open ? 'Collapse' : 'Show the details') : undefined)}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className="chat-row-icon">{props.running ? <span className="chat-row-spin" aria-label="running" /> : props.icon}</span>
        <span className="chat-row-verb">{props.verb}</span>
        {props.object !== undefined && props.object !== '' && <span className={'chat-row-obj' + (props.mono ? ' mono' : '')}>{props.object}</span>}
        <span className="chat-row-rest">{props.rest}</span>
        {props.meta && <span className="chat-row-meta">{props.meta}</span>}
        {props.at && <span className="chat-row-time">{rowTime(props.at)}</span>}
        <span className="chat-row-chev" aria-hidden>
          {expandable ? '›' : ''}
        </span>
      </div>
      {expandable && open && (
        <div className="chat-row-body" id={id}>
          {props.children}
        </div>
      )}
    </div>
  );
}

/** The meta slot: plain text, pills, +/− counts, then a duration. */
export function RowMeta({ meta, time }: { meta: Meta[]; time?: string | null }) {
  const parts = meta.filter((m) => !('add' in m) || m.add > 0 || m.del > 0);
  if (!parts.length && !time) return null;
  return (
    <>
      {parts.map((m, i) =>
        'pill' in m ? (
          <span key={i} className={'badge ' + m.pill}>
            {m.text}
          </span>
        ) : 'add' in m ? (
          <span key={i} className="chat-delta">
            {m.add > 0 && <span className="add">+{m.add}</span>}
            {m.del > 0 && <span className="del">−{m.del}</span>}
          </span>
        ) : (
          <span key={i}>{m.text}</span>
        ),
      )}
      {time && <span>{time}</span>}
    </>
  );
}

/** "packages/ui/src/" faint, then "ChatRow.tsx". */
export function PathObject({ dir, name }: { dir?: string; name: string }) {
  return (
    <span title={(dir ?? '') + name}>
      {dir && <span className="chat-row-dir">{dir}</span>}
      {name}
    </span>
  );
}

const PATHS: Record<RowIcon, string> = {
  read: 'M4 2.5h5.5L12 5v8.5H4z M9.5 2.5V5H12 M6 8h4M6 10.5h3',
  write: 'M4 2.5h5.5L12 5v8.5H4z M9.5 2.5V5H12 M8 7.5v4M6 9.5h4',
  edit: 'M10.5 2.8l2.7 2.7-7.4 7.4H3.1v-2.7z M9 4.3l2.7 2.7',
  search: 'M3 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M10 10l3.5 3.5',
  folder: 'M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z',
  term: 'M4 3h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M5 6.5l2 1.5-2 1.5M8.5 10h2.5',
  bg: 'M4 3h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M5 6.5l2 1.5-2 1.5 M9.8 9.5a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0',
  stop: 'M5.5 4h5A1.5 1.5 0 0 1 12 5.5v5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 10.5v-5A1.5 1.5 0 0 1 5.5 4z',
  globe: 'M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0 M2.5 8h11M8 2.5c1.8 2 1.8 9 0 11M8 2.5c-1.8 2-1.8 9 0 11',
  link: 'M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.7.7 M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.7-.7',
  card: 'M4.5 3h7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M5 6.5h6M5 9h4',
  cardp: 'M4.5 3h7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M8 5.8v4.4M5.8 8h4.4',
  msg: 'M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z',
  board: 'M3.5 3h1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M7.5 3h1a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M11.5 3h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
  canvas: 'M4.5 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M4.7 6.5a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0 M4 12l3-3 2 2 2-2.5 2.5 3',
  panel: 'M4.5 3h7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M9.5 3v10',
  mem: 'M4 3.5h8v10l-4-2.5-4 2.5z',
  todo: 'M3.2 3h1.6a.7.7 0 0 1 .7.7v1.6a.7.7 0 0 1-.7.7H3.2a.7.7 0 0 1-.7-.7V3.7a.7.7 0 0 1 .7-.7z M7.5 4.5h6 M3.2 9.5h1.6a.7.7 0 0 1 .7.7v1.6a.7.7 0 0 1-.7.7H3.2a.7.7 0 0 1-.7-.7v-1.6a.7.7 0 0 1 .7-.7z M7.5 11h6',
  clock: 'M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0 M8 5v3l2 1.5',
  think: 'M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3z',
  check: 'M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0 M5.6 8.2l1.6 1.6 3.2-3.4',
  x: 'M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0 M6 6l4 4M10 6l-4 4',
  alert: 'M8 2.5l6 10.5H2z M8 6.5v3M8 11.2v.1',
  hand: 'M5.5 8V4a1 1 0 0 1 2 0v3.5M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7V4a1 1 0 0 1 2 0v5a4 4 0 0 1-4 4h-.5a4 4 0 0 1-3.3-1.8L2.5 8.5a1 1 0 0 1 1.6-1.2l1.4 1.5',
  inbox: 'M2.5 9.5l1.6-5.5h7.8l1.6 5.5v3h-11z M2.5 9.5h3.2l.8 1.5h3l.8-1.5h3.2',
  history: 'M3.5 8a4.5 4.5 0 1 0 1.3-3.2 M3.5 3v2.5H6 M8 5.5V8l2 1',
  play: 'M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0 M6.8 5.6v4.8l3.8-2.4z',
  rewind: 'M3 3.5v3h3 M3.4 6.5A5 5 0 1 1 3.8 10',
  compress: 'M8 2.5v4M6 4.5l2 2 2-2 M8 13.5v-4M6 11.5l2-2 2 2 M3 8h10',
  trash: 'M2.8 4.4h10.4M6.4 2.4h3.2l.8 2H5.6zM4.4 4.4l.6 8.8h6l.6-8.8M6.8 6.8v4M9.2 6.8v4',
  wrench: 'M10.2 2.6a3 3 0 0 0-3.4 4L2.9 10.5a1.3 1.3 0 0 0 1.8 1.8l3.9-3.9a3 3 0 0 0 4-3.4l-1.8 1.8-1.6-.4-.4-1.6z',
};

/** The 16 px line icon of a row (docs/chat-activity.md, mockup pages/chat-activity.js). */
export function RowIconSvg({ name }: { name: RowIcon }) {
  return (
    <svg className={'row-ic rowic-' + name} viewBox="0 0 16 16" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
