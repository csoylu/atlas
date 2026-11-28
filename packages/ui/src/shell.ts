/**
 * The app shell's one breakpoint (#264): at this width and below there is no sidebar, a tab bar at the bottom
 * (Inbox · Tasks · Chats · Library · More) and a back button on pushed screens. Move it here only: the shell's CSS
 * keys off the `.narrow` class App sets from it, never off its own media query.
 */
export const NARROW_MAX = 900;
export const NARROW = `(max-width: ${NARROW_MAX}px)`;

export type Tab = 'inbox' | 'tasks' | 'chats' | 'library' | 'more';

/** The tab a screen belongs to on a narrow window (the tab lit while it is on screen). */
export function tabOf(view: string): Tab {
  switch (view) {
    case 'inbox':
      return 'inbox';
    case 'board':
      return 'tasks';
    case 'chat':
    case 'chats':
      return 'chats';
    case 'library':
      return 'library';
    default:
      return 'more'; // workflows, settings, more
  }
}

/**
 * Where a narrow window's back button goes from a screen, or null on a top-level screen (one of the tabs). `target`:
 * the route's id (a chat, a workflow). Chats come from the Chats list, Workflows and Settings from More. A Library
 * document has its own « ‹ Library » in the viewer.
 */
export function backOf(view: string, target: string | null, rest = ''): { hash: string; label: string } | null {
  switch (view) {
    case 'chat':
      return { hash: '#/chats', label: 'Back to chats' };
    case 'workflows':
      return target ? { hash: '#/workflows', label: 'Back to workflows' } : { hash: '#/more', label: 'Back to more' };
    case 'settings':
      // #/settings alone is the list of pages (#272): a page goes back to it, an agent or a project to its page.
      if (!target) return { hash: '#/more', label: 'Back to more' };
      if (rest && (target === 'agents' || target === 'projects')) return { hash: '#/settings/' + target, label: target === 'agents' ? 'Back to agents' : 'Back to projects' };
      return { hash: '#/settings', label: 'Back to settings' };
    default:
      return null;
  }
}

const COLLAPSED = 'atlas.side.collapsed.';
/** A project group folded in the sidebar (and the phone's Chats list), per project, kept across reloads. */
export const groupCollapsed = (projectId: string) => localStorage.getItem(COLLAPSED + projectId) === '1';
export const setGroupCollapsed = (projectId: string, on: boolean) =>
  on ? localStorage.setItem(COLLAPSED + projectId, '1') : localStorage.removeItem(COLLAPSED + projectId);

const SIDEBAR = 'atlas.sidebar';
/** The sidebar folded to its icons (#397), kept across reloads; a wide window only (the narrow one has no sidebar). */
export const sidebarFolded = () => localStorage.getItem(SIDEBAR) === 'folded';
export const setSidebarFolded = (on: boolean) => (on ? localStorage.setItem(SIDEBAR, 'folded') : localStorage.removeItem(SIDEBAR));
/** Where the sidebar shrinks to icons on its own while a side panel is open (a laptop width, #397 shares its rules). */
export const STRIP = `(min-width: ${NARROW_MAX + 1}px) and (max-width: 1280px)`;
