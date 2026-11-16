import { pttAction, type Card, type InboxNeed, type VoiceStatus } from '@atlas/shared';
import type { IconKind } from './icons.ts';

/**
 * What the menu bar / tray orb shows (card #54), as plain data: the icon, the badge, the tooltip and the menu. Pure,
 * so tested without Electron; tray.ts turns it into a Tray and a native Menu.
 */

/**
 * Voice as the orb shows it. 'none': no voice mode on this platform (Windows, Linux). 'standby': ready with the wake
 * word off, microphone closed until the push-to-talk shortcut (card #57); 'idle': ready, listening for « Hi Atlas ».
 */
export type TrayVoice = 'none' | 'off' | 'starting' | 'paused' | 'standby' | 'idle' | 'wake' | 'listening' | 'thinking' | 'speaking';
export type LoopState = 'idle' | 'wake' | 'listening' | 'thinking' | 'speaking';

export interface TrayInput {
  platform: NodeJS.Platform;
  /** null: no voice mode here. */
  voice: VoiceStatus | null;
  /** The voice loop is running (models loaded): « Start talking » works. */
  loopRunning: boolean;
  orb: LoopState;
  needs: InboxNeed[];
  running: Card[];
  now: Date;
}

export type TrayAction =
  | { type: 'open' }
  | { type: 'talk' }
  | { type: 'voice'; on: boolean }
  | { type: 'pause'; until: string | null }
  | { type: 'resume' }
  /** Opens Atlas on this hash (#/inbox/<card>, a card's ticket, the Inbox). */
  | { type: 'go'; hash: string }
  | { type: 'stop'; cardId: string }
  | { type: 'quit' };

export interface TrayItem {
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox';
  enabled?: boolean;
  checked?: boolean;
  /** A status dot drawn before the label. */
  dot?: 'blocked' | 'review' | 'failed' | 'running';
  accelerator?: string;
  action?: TrayAction;
  submenu?: TrayItem[];
}

/** Rows shown per section; the rest behind « All N in the Inbox… ». */
export const MAX_ROWS = 5;
const TITLE_MAX = 44;

export function trayVoice(i: Pick<TrayInput, 'voice' | 'loopRunning' | 'orb'>): TrayVoice {
  const v = i.voice;
  if (!v) return 'none';
  if (!v.enabled) return 'off';
  if (v.paused) return 'paused';
  if (!v.ready || !i.loopRunning) return 'starting';
  if (i.orb === 'idle' && !v.wakeWord) return 'standby';
  return i.orb;
}

export function iconKind(v: TrayVoice): IconKind {
  switch (v) {
    case 'none':
    case 'standby': // the plain monochrome dot: nothing listens (static: no CPU)
      return 'solid';
    case 'idle':
      return 'breathe';
    case 'off':
    case 'starting':
      return 'ring';
    case 'paused':
      return 'pause';
    case 'wake':
    case 'listening':
      return 'listen';
    case 'thinking':
      return 'think';
    case 'speaking':
      return 'speak';
  }
}

/** Awake states are drawn in the accent colour (like the microphone indicator). At rest: ready breathes in the accent
 * too (card #56); off, starting and paused are monochrome template images. */
export const isAwake = (v: TrayVoice) => v === 'wake' || v === 'listening' || v === 'thinking' || v === 'speaking';

/** The count on the icon: cards that need Master (blocked on them, or in review). */
export const badgeCount = (i: Pick<TrayInput, 'needs'>) => i.needs.length;

/** « 18:30 », « tomorrow 08:00 », « Mon 08:00 ». */
export function whenLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86_400_000);
  if (days === 0) return hm;
  if (days === 1) return `tomorrow ${hm}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
}

/** The first line of the menu: where voice mode is. */
export function voiceLine(i: TrayInput): string | null {
  const v = trayVoice(i);
  const s = i.voice;
  switch (v) {
    case 'none':
      return null;
    case 'off':
      return 'Voice mode off';
    case 'paused':
      return s!.paused!.until ? `Listening paused until ${whenLabel(s!.paused!.until, i.now)}` : 'Listening paused';
    case 'starting':
      if (s!.download) return `Downloading voice models… ${Math.round((100 * s!.download.received) / Math.max(1, s!.download.total))}%`;
      if (s!.error) return 'Voice mode needs attention (Settings → Voice)';
      if (s!.mic !== 'granted') return 'Voice mode needs the microphone';
      if (s!.models.some((m) => !m.installed)) return 'Voice models missing (Settings → Voice)';
      return 'Voice mode starting…';
    case 'idle':
      return s!.ptt.enabled ? `Ready: say « Hi Atlas » or ${pttAction(s!.ptt.shortcut)}` : 'Ready: say « Hi Atlas »';
    case 'standby':
      return s!.ptt.enabled ? `Ready: ${pttAction(s!.ptt.shortcut)} to talk` : 'Ready: no wake word or shortcut (Settings → Voice)';
    case 'wake':
    case 'listening':
      return 'Listening…';
    case 'thinking':
      return 'Thinking…';
    case 'speaking':
      return 'Speaking…';
  }
}

export function tooltip(i: TrayInput): string {
  const n = badgeCount(i);
  return ['Atlas', voiceLine(i), n ? `${n} need${n === 1 ? 's' : ''} you` : null].filter(Boolean).join(' · ');
}

/** A card as a menu row: « #54 Menu bar orb … — your answer ». Windows menus read « & » as a shortcut mark: doubled. */
export function cardLabel(card: Card, suffix: string | null, platform: NodeJS.Platform): string {
  const t = card.title.length > TITLE_MAX ? card.title.slice(0, TITLE_MAX - 1).trimEnd() + '…' : card.title;
  const label = `${card.number !== null ? `#${card.number} ` : ''}${t}${suffix ? ` — ${suffix}` : ''}`;
  return platform === 'win32' ? label.replace(/&/g, '&&') : label;
}

function needRow(n: InboxNeed, platform: NodeJS.Platform): TrayItem {
  const c = n.card;
  const [suffix, dot]: [string, TrayItem['dot']] =
    c.status === 'review'
      ? ['review', 'review']
      : n.failed
        ? ['failed', 'failed']
        : c.block?.kind === 'needs_input'
          ? ['your answer', 'blocked']
          : c.block?.kind === 'capability'
            ? ['needs access', 'blocked']
            : ['waiting', 'blocked'];
  return { label: cardLabel(c, suffix, platform), dot, action: { type: 'go', hash: `#/inbox/${encodeURIComponent(c.id)}` } };
}

/** « Until tomorrow »: tomorrow at 08:00, local time. */
export function tomorrowMorning(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0, 0);
  return d.toISOString();
}

export function trayMenu(i: TrayInput): TrayItem[] {
  const items: TrayItem[] = [];
  const sep = (): TrayItem => ({ type: 'separator' });
  const v = trayVoice(i);
  const line = voiceLine(i);
  items.push({ label: line ? `Atlas · ${line}` : 'Atlas', enabled: false });
  if (i.voice) {
    const s = i.voice;
    items.push({ label: 'Start talking', enabled: v !== 'off' && v !== 'paused' && v !== 'starting', action: { type: 'talk' } });
    items.push({ label: 'Voice mode', type: 'checkbox', checked: s.enabled, action: { type: 'voice', on: !s.enabled } });
    if (s.paused) items.push({ label: 'Resume listening', enabled: true, action: { type: 'resume' } });
    else
      items.push({
        label: 'Pause listening',
        enabled: s.enabled,
        submenu: [
          { label: 'For 1 hour', action: { type: 'pause', until: new Date(i.now.getTime() + 3_600_000).toISOString() } },
          { label: 'Until tomorrow (8:00)', action: { type: 'pause', until: tomorrowMorning(i.now) } },
          { label: 'Until I resume', action: { type: 'pause', until: null } },
        ],
      });
  }
  if (i.needs.length) {
    items.push(sep(), { label: `Needs you · ${i.needs.length}`, enabled: false });
    for (const n of i.needs.slice(0, MAX_ROWS)) items.push(needRow(n, i.platform));
    if (i.needs.length > MAX_ROWS) items.push({ label: `All ${i.needs.length} in the Inbox…`, action: { type: 'go', hash: '#/inbox' } });
  }
  if (i.running.length) {
    items.push(sep(), { label: `Running · ${i.running.length}`, enabled: false });
    for (const c of i.running.slice(0, MAX_ROWS))
      items.push({
        label: cardLabel(c, null, i.platform),
        dot: 'running',
        submenu: [
          { label: 'Open', action: { type: 'go', hash: `#/board?card=${encodeURIComponent(c.id)}` } },
          { label: 'Stop', action: { type: 'stop', cardId: c.id } },
        ],
      });
    if (i.running.length > MAX_ROWS) items.push({ label: `All ${i.running.length} on the board…`, action: { type: 'go', hash: '#/board' } });
  }
  items.push(sep(), { label: 'Open Atlas', action: { type: 'open' } }, { label: 'Quit Atlas', accelerator: 'CmdOrCtrl+Q', action: { type: 'quit' } });
  return items;
}
