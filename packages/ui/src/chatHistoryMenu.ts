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
