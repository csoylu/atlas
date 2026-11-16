/**
 * Card references. Board cards have a sequential number (#1, #2, …) that people and agents use; the internal id
 * (c_ + 8 hex) stays the primary key and is still accepted (old transcripts, direct chats, which have no number).
 */

/** How a card is named in text: "#12", or its id when it has no number (direct chats). */
export const cardRef = (c: { id: string; number?: number | null }): string => (c.number != null ? `#${c.number}` : c.id);

/** A reference typed by a person or an agent: "#12", "12" or "c_1a2b3c4d" (null = not a card reference). */
export function parseCardRef(ref: string): { number: number } | { id: string } | null {
  const s = ref.trim();
  const n = /^#?(\d+)$/.exec(s);
  if (n) return { number: Number(n[1]) };
  if (/^c_[0-9a-f]{8}$/.test(s)) return { id: s };
  return null;
}

/** Card references inside text: "#12" (not part of a word, a URL fragment or a heading) or an old "c_1a2b3c4d" id. */
export const CARD_REF_RE = /(?<![\w#&/])#(\d+)\b|\bc_[0-9a-f]{8}\b/g;
