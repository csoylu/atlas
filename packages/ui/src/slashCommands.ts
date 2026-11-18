/**
 * Composer slash commands (card #99): the popup that opens when `/` is the first character of the composer, and how
 * its keys work. Pure, so the filter and every key are unit-tested; CardComposer renders it and runs the command.
 */

export type SlashName = 'clear' | 'compact';

export interface SlashSpec {
  name: SlashName;
  /** Shown after the name: what the command does. */
  desc: string;
  /** It takes free text after it (/compact <focus>). */
  arg?: string;
}

export const SLASH_COMMANDS: SlashSpec[] = [
  { name: 'clear', desc: "Start fresh: the agent forgets this chat's earlier messages" },
  { name: 'compact', desc: 'Summarize the chat so far to free context', arg: 'focus (optional)' },
];

/** A command as typed: its name and argument, or null if the text isn't exactly a known command (+ argument). */
export function parseSlash(text: string): { name: SlashName; arg: string } | null {
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const spec = SLASH_COMMANDS.find((c) => c.name === m[1]);
  if (!spec) return null;
  const arg = (m[2] ?? '').trim();
  if (arg && !spec.arg) return null; // "/clear something" is a message, not the command
  return { name: spec.name, arg };
}

/**
 * The commands the popup lists for the composer text: only while it starts with `/` and the name is being typed (no
 * space yet), filtered by prefix ("/co" → /compact). Empty = no popup.
 */
export function slashMatches(text: string): SlashSpec[] {
  if (!text.startsWith('/')) return [];
  const word = text.slice(1);
  if (/\s/.test(word)) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(word.toLowerCase()));
}

export type SlashKeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>;

/**
 * A key in the composer while the popup is open (`matches` non-empty, not dismissed). ↑/↓ move (wrapping), Enter or
 * Tab run the highlighted command, Esc closes. A focus for /compact is typed after a space (« /compact keep X »): the
 * popup is closed by then and Enter runs the parsed command (parseSlash). Null = not the popup's key.
 */
export function slashKey(
  e: SlashKeyEvent,
  s: { matches: SlashSpec[]; index: number },
): { kind: 'move'; index: number } | { kind: 'close' } | { kind: 'run'; name: SlashName } | null {
  if (e.isComposing || !s.matches.length || e.metaKey || e.ctrlKey || e.altKey) return null;
  const n = s.matches.length;
  const i = Math.min(Math.max(s.index, 0), n - 1);
  if (e.key === 'ArrowDown') return { kind: 'move', index: (i + 1) % n };
  if (e.key === 'ArrowUp') return { kind: 'move', index: (i - 1 + n) % n };
  if (e.key === 'Escape') return { kind: 'close' };
  if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) return { kind: 'run', name: s.matches[i]!.name };
  return null;
}
