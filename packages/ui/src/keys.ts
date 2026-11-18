/**
 * App-wide keyboard shortcuts (design §16 « Keyboard »): pure rules, tested in keys.test.ts; App.tsx acts on them.
 * Screen-specific keys stay with their screen (Inbox: J/K, E, R, 1–4 in inboxView.ts).
 */

type Key = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'defaultPrevented' | 'repeat'>;

/** Somewhere text goes: letters there aren't shortcuts. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el !== 'object') return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export type GoTo = 'board' | 'library' | 'inbox' | 'workflows';
export const GO_KEYS: Record<string, GoTo> = { t: 'board', b: 'board', l: 'library', i: 'inbox', w: 'workflows' };
export const GO_HASH: Record<GoTo, string> = { board: '#/board', library: '#/library', inbox: '#/inbox', workflows: '#/workflows' };

export type GlobalAction =
  | { kind: 'palette' }
  | { kind: 'newChat' }
  | { kind: 'togglePanel' }
  | { kind: 'help' }
  | { kind: 'newCard' }
  /** G pressed: the next key picks where to go. */
  | { kind: 'goPrefix' }
  | { kind: 'go'; to: GoTo }
  | { kind: 'listNext' }
  | { kind: 'listPrev' };

/** How long after G the second key counts (ms). */
export const G_WINDOW = 1500;

/**
 * The shortcut a keydown means, or null. `gAt`: when G was pressed (null if not pending). `blocked`: a modal or the
 * palette has the keyboard, so only ⌘K (toggle the palette) goes through.
 * ⌘K, ⌘N and ⌘\ work while typing (they have a modifier); single letters don't.
 */
export function globalKey(e: Key, target: EventTarget | null, opts: { gAt: number | null; now: number; blocked?: boolean }): GlobalAction | null {
  if (e.defaultPrevented) return null;
  const k = e.key.toLowerCase();
  const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
  if (mod && !e.shiftKey && k === 'k') return { kind: 'palette' };
  if (opts.blocked) return null;
  if (mod && !e.shiftKey && k === 'n') return { kind: 'newChat' };
  if (mod && !e.shiftKey && e.key === '\\') return { kind: 'togglePanel' };
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(target)) return null;
  if (e.key === '?') return { kind: 'help' };
  if (e.shiftKey) return null;
  if (opts.gAt !== null && opts.now - opts.gAt <= G_WINDOW && GO_KEYS[k]) return { kind: 'go', to: GO_KEYS[k]! };
  if (k === 'j') return { kind: 'listNext' };
  if (k === 'k') return { kind: 'listPrev' };
  if (e.repeat) return null;
  if (k === 'g') return { kind: 'goPrefix' };
  if (k === 'c') return { kind: 'newCard' };
  return null;
}

/** J / K over the rows of a list: the index to focus next (from nothing focused: the first row; stays at the ends). */
export function nextRow(count: number, current: number, dir: 1 | -1): number | null {
  if (!count) return null;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return Math.min(Math.max(current + dir, 0), count - 1);
}

/** The « ? » cheat sheet, and the hints shown on buttons. */
export const SHORTCUTS: { group: string; keys: string[]; label: string }[] = [
  { group: 'General', keys: ['⌘', 'K'], label: 'Command palette' },
  { group: 'General', keys: ['?'], label: 'Keyboard shortcuts' },
  { group: 'General', keys: ['C'], label: 'New task' },
  { group: 'General', keys: ['⌘', 'N'], label: 'Main chat' },
  { group: 'General', keys: ['⌘', '\\'], label: 'Show / hide the documents panel' },
  { group: 'Go to', keys: ['G', 'I'], label: 'Inbox' },
  { group: 'Go to', keys: ['G', 'T'], label: 'Tasks' },
  { group: 'Go to', keys: ['G', 'L'], label: 'Library' },
  { group: 'Go to', keys: ['G', 'W'], label: 'Workflows' },
  { group: 'Lists', keys: ['J'], label: 'Next row' },
  { group: 'Lists', keys: ['K'], label: 'Previous row' },
  { group: 'Lists', keys: ['↵'], label: 'Open' },
  { group: 'Inbox', keys: ['E'], label: 'Archive' },
  { group: 'Inbox', keys: ['R'], label: 'Reply' },
  { group: 'Inbox', keys: ['1–4'], label: 'Pick an option' },
  { group: 'Chat', keys: ['/clear', '↵'], label: 'Clear the context: the agent starts fresh (Undo until you write)' },
  { group: 'Chat', keys: ['/compact', '↵'], label: 'Summarize the chat now to free context (/compact <focus>)' },
];
