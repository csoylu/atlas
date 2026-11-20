import { USER, paneLine, samePane, type Message, type PaneSees } from '@atlas/shared';

/**
 * « What the agent sees » (#305). The line attached to Master's new message (paneLine), or null when there is nothing
 * to say: the pane closed or the eye off, or the same tab as Master's previous message and that line still in what the
 * model reads (after the conversation's summary, `summaryUpto`). A tab closed then reopened is said again.
 */
export function paneNote(history: Message[], pane: PaneSees | null, summaryUpto: number | null): string | null {
  if (!pane) return null;
  const line = paneLine(pane);
  const prev = history.findLast((m) => m.author === USER);
  if (!prev || !samePane(prev.pane, pane)) return line;
  const said = history.some((m) => m.author === USER && m.seq > (summaryUpto ?? 0) && m.content.some((b) => b.type === 'text' && b.text === line));
  return said ? null : line;
}

/**
 * What each chat's pane shows right now, as the UI on screen reports it (PUT /api/cards/:id/pane): a voice message has
 * no composer, it takes this. A mirror of the UI, not engine state: what counts is stored with each message (rule 2);
 * after a restart a chat says nothing until its UI reports again (it does when it reconnects).
 */
export class PanePresence {
  private open = new Map<string, PaneSees>();

  set(chatId: string, pane: PaneSees | null): void {
    if (pane) this.open.set(chatId, pane);
    else this.open.delete(chatId);
  }

  get(chatId: string): PaneSees | null {
    return this.open.get(chatId) ?? null;
  }
}
