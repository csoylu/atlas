/** Clamp the actual menu bounds, not just its anchor, into the viewport. */
export function menuPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  return {
    left: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    top: Math.max(8, Math.min(y, viewportHeight - height - 8)),
  };
}

/** Check at completion time: the user may have selected another chat during the request. */
export function deletedChatRoute(hash: string, id: string): string | null {
  return hash === '#/chat/' + id ? '#/chat/new' : null;
}

/**
 * The confirm before a chat is deleted (#232): deleting is permanent (the card, its conversation and every message),
 * so the question says so. An agent's main chat is the whole history with that agent: name it, and point to /clear,
 * which hides old messages from the agent without deleting anything.
 */
export function deleteChatQuestion(chat: { title: string; assignee: string | null }, isMain: boolean): string {
  if (isMain)
    return `Delete your whole chat with @${chat.assignee ?? chat.title}?\n\nEvery message is deleted for good. This can't be undone.\n(To give @${chat.assignee ?? chat.title} a fresh start without losing anything, type /clear instead.)`;
  return `Delete the chat “${chat.title}”?\n\nEvery message is deleted for good. This can't be undone.`;
}
