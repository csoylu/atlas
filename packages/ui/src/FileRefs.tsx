import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { api } from './api.ts';
import { parsePathRef } from './files.ts';

/**
 * File paths in chat messages (#303, mockup « Links in chat »): a path the agent writes as inline code becomes a link
 * when the file is in its workspace (`:42` jumps to the line), opening it in the pane's Files. A path that isn't there
 * stays plain code, with a tooltip on hover. Given by a direct chat with an agent; elsewhere code stays code.
 */
export interface FileLinks {
  chatId: string;
  agentId: string;
  /** `path` is the workspace path the engine found (a clone's path included). */
  open(path: string, line: number | null): void;
}

export const FileLinkContext = createContext<FileLinks | null>(null);
/** Inside a code block (or a reply still streaming): no links. */
export const NoFileLinks = createContext(false);

/* What exists, per chat: asked in batches, kept 20 s (the agent may create the file a moment later). */
const TTL = 20_000;
type Entry = { at: number; rel: string | null | undefined };
const known = new Map<string, Map<string, Entry>>();
const waiting = new Map<string, Set<string>>();
const subs = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function ask(chatId: string, path: string) {
  const m = known.get(chatId) ?? new Map<string, Entry>();
  known.set(chatId, m);
  const e = m.get(path);
  if (e && (e.rel === undefined || Date.now() - e.at < TTL)) return;
  m.set(path, { at: Date.now(), rel: e?.rel ?? undefined });
  const w = waiting.get(chatId) ?? new Set<string>();
  waiting.set(chatId, w.add(path));
  timer ??= setTimeout(flush, 40);
}

function flush() {
  timer = null;
  for (const [chatId, paths] of waiting) {
    waiting.delete(chatId);
    const list = [...paths];
    api.fileLinks(chatId, list).then(
      (r) => {
        const m = known.get(chatId)!;
        for (const p of list) m.set(p, { at: Date.now(), rel: r[p] ?? null });
        version++;
        for (const s of subs) s();
      },
      (e: unknown) => {
        // No workspace (yet), or offline: the paths stay plain code, and the reason is in the console.
        console.error('File links: could not check', list, e);
        const m = known.get(chatId)!;
        for (const p of list) m.set(p, { at: Date.now(), rel: null });
        version++;
        for (const s of subs) s();
      },
    );
  }
}

function useKnown(chatId: string, path: string): string | null | undefined {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => version,
  );
  useEffect(() => ask(chatId, path), [chatId, path]);
  return known.get(chatId)?.get(path)?.rel;
}

/** react-markdown's `code`: inline code that names a file becomes a link; anything else is rendered as it was. */
export function MdCode(props: ComponentProps<'code'> & { node?: unknown }) {
  const links = useContext(FileLinkContext);
  const off = useContext(NoFileLinks);
  const { node: _node, children, ...rest } = props;
  const text = typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : null;
  const ref = !links || off || text === null ? null : parsePathRef(text);
  if (!links || !ref) return <code {...rest}>{children}</code>;
  return <FileRef links={links} path={ref.path} line={ref.line} text={text!} />;
}

function FileRef({ links, path, line, text }: { links: FileLinks; path: string; line: number | null; text: string }) {
  const rel = useKnown(links.chatId, path);
  const [tip, setTip] = useState(false);
  if (rel)
    return (
      <code
        className="wb-flink"
        role="link"
        tabIndex={0}
        title="Open in Files"
        onClick={() => links.open(rel, line)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          links.open(rel, line);
        }}
      >
        {text}
      </code>
    );
  return (
    <code className="wb-fmiss" onMouseEnter={() => rel === null && setTip(true)} onMouseLeave={() => setTip(false)}>
      {text}
      {tip && (
        <span className="wb-tip" role="tooltip">
          No such file in {links.agentId}’s workspace <span className="f">· not a link</span>
        </span>
      )}
    </code>
  );
}
