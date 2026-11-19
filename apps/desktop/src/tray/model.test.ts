import { describe, expect, it } from 'vitest';
import type { Card, InboxNeed, VoiceStatus } from '@atlas/shared';
import { animation, BREATH, FRAMES, hex, renderIcon, type IconKind } from './icons.ts';
import { breathLayer } from './breathe.ts';
import { badgeCount, cardLabel, iconKind, isAwake, tomorrowMorning, tooltip, trayMenu, trayVoice, voiceLine, MAX_ROWS, type TrayInput, type TrayItem } from './model.ts';

const card = (n: number, over: Partial<Card> = {}): Card => ({
  id: `c_${n}`,
  number: n,
  title: `Card ${n}`,
  body: '',
  status: 'running',
  assignee: 'atlas',
  priority: 0,
  board: 'main',
  parents: [],
  block: null,
  retry: null,
  waiting: null,
  conversationId: `v_${n}`,
  createdBy: 'user',
  createdAt: '2026-11-14T10:00:00Z',
  updatedAt: '2026-11-14T10:00:00Z',
  modelId: null,
  effort: null,
  naming: false,
  working: false,
  originCard: null,
  images: [],
  reviewer: null,
  prs: [],
  projectId: 'atlas',
  statusSince: null,
  stall: null, reviewOff: null,
  ...over,
});
const need = (c: Card, failed = false): InboxNeed => ({ card: c, since: c.updatedAt, failed, notificationId: null, unread: true, summary: null });
const voice = (over: Partial<VoiceStatus> = {}): VoiceStatus => ({
  enabled: true,
  voice: 'voice-9',
  sensitivity: 0.5,
  models: [{ id: 'vad', label: 'VAD', bytes: 1, installed: true }],
  download: null,
  mic: 'granted',
  error: null,
  paused: null,
  ready: true,
  wakeWord: true,
  ptt: { enabled: false, shortcut: 'Alt+Space', error: null, permission: false },
  ...over,
});
const NOW = new Date(2026, 10, 14, 17, 0);
const input = (over: Partial<TrayInput> = {}): TrayInput => ({ platform: 'darwin', voice: voice(), loopRunning: true, orb: 'idle', needs: [], running: [], now: NOW, ...over });
const labels = (items: TrayItem[]) => items.map((i) => (i.type === 'separator' ? '—' : i.label));
const find = (items: TrayItem[], label: string) => items.find((i) => i.label === label)!;

describe('tray: voice state', () => {
  it('#57: wake word off = standby (plain dot, microphone closed); the status line names the shortcut', () => {
    const ptt = { enabled: true, shortcut: 'Alt+Space', error: null, permission: false };
    expect(trayVoice(input({ voice: voice({ wakeWord: false, ptt }) }))).toBe('standby');
    expect(iconKind('standby')).toBe('solid');
    expect(trayVoice(input({ voice: voice({ wakeWord: false, ptt }), orb: 'listening' }))).toBe('listening');
    expect(voiceLine(input({ voice: voice({ wakeWord: false, ptt }) }))).toBe('Ready: press ⌥ Space to talk');
    expect(voiceLine(input({ voice: voice({ ptt }) }))).toBe('Ready: say « Hi Atlas » or press ⌥ Space');
    const hold = { ...ptt, shortcut: 'Option' };
    expect(voiceLine(input({ voice: voice({ wakeWord: false, ptt: hold }) }))).toBe('Ready: hold ⌥ Option to talk');
    expect(voiceLine(input({ voice: voice({ ptt: hold }) }))).toBe('Ready: say « Hi Atlas » or hold ⌥ Option');
    expect(voiceLine(input({ voice: voice({ wakeWord: false }) }))).toBe('Ready: no wake word or shortcut (Settings → Voice)');
    expect(find(trayMenu(input({ voice: voice({ wakeWord: false }) })), 'Start talking')).toMatchObject({ enabled: true, action: { type: 'talk' } });
  });

  it('maps voice mode and the loop to the orb icon', () => {
    expect(trayVoice(input({ voice: null }))).toBe('none');
    expect(trayVoice(input({ voice: voice({ enabled: false, ready: false }) }))).toBe('off');
    expect(trayVoice(input({ voice: voice({ paused: { until: null }, ready: false }) }))).toBe('paused');
    expect(trayVoice(input({ voice: voice({ ready: false, mic: 'denied' }) }))).toBe('starting');
    expect(trayVoice(input({ loopRunning: false }))).toBe('starting'); // models still loading
    for (const s of ['idle', 'wake', 'listening', 'thinking', 'speaking'] as const) expect(trayVoice(input({ orb: s }))).toBe(s);
    expect(['none', 'off', 'starting', 'paused', 'idle', 'wake', 'listening', 'thinking', 'speaking'].map((v) => iconKind(v as never))).toEqual([
      'solid', 'ring', 'ring', 'pause', 'breathe', 'listen', 'listen', 'think', 'speak',
    ]);
    expect(isAwake('idle')).toBe(false);
    expect(isAwake('speaking')).toBe(true);
  });

  it('says where voice mode is in words', () => {
    expect(voiceLine(input())).toBe('Ready: say « Hi Atlas »');
    expect(voiceLine(input({ voice: null }))).toBeNull();
    expect(voiceLine(input({ voice: voice({ enabled: false, ready: false }) }))).toBe('Voice mode off');
    expect(voiceLine(input({ voice: voice({ ready: false, download: { received: 42, total: 100, model: 'x' } }) }))).toBe('Downloading voice models… 42%');
    expect(voiceLine(input({ voice: voice({ ready: false, mic: 'denied' }) }))).toBe('Voice mode needs the microphone');
    expect(voiceLine(input({ voice: voice({ paused: { until: null }, ready: false }) }))).toBe('Listening paused');
    const at = new Date(2026, 10, 15, 8, 0).toISOString();
    expect(voiceLine(input({ voice: voice({ paused: { until: at }, ready: false }) }))).toMatch(/^Listening paused until tomorrow 0?8[:.]00/);
    expect(voiceLine(input({ orb: 'thinking' }))).toBe('Thinking…');
    expect(tooltip(input({ needs: [need(card(1, { status: 'review' }))] }))).toBe('Atlas · Ready: say « Hi Atlas » · 1 needs you');
  });
});

describe('tray: menu', () => {
  it('base menu: status, Start talking, Voice mode, Pause listening, Open, Quit', () => {
    const m = trayMenu(input());
    expect(labels(m)).toEqual(['Atlas · Ready: say « Hi Atlas »', 'Start talking', 'Voice mode', 'Pause listening', '—', 'Open Atlas', 'Quit Atlas']);
    expect(m[0]!.enabled).toBe(false);
    expect(find(m, 'Start talking')).toMatchObject({ enabled: true, action: { type: 'talk' } });
    expect(find(m, 'Voice mode')).toMatchObject({ type: 'checkbox', checked: true, action: { type: 'voice', on: false } });
    const pause = find(m, 'Pause listening').submenu!;
    expect(labels(pause)).toEqual(['For 1 hour', 'Until tomorrow (8:00)', 'Until I resume']);
    expect(pause[0]!.action).toEqual({ type: 'pause', until: new Date(NOW.getTime() + 3_600_000).toISOString() });
    expect(pause[1]!.action).toEqual({ type: 'pause', until: new Date(2026, 10, 15, 8, 0).toISOString() });
    expect(pause[2]!.action).toEqual({ type: 'pause', until: null });
  });

  it('voice off or paused: no Start talking; paused offers Resume; no voice at all (Windows): no voice items', () => {
    const off = trayMenu(input({ voice: voice({ enabled: false, ready: false }) }));
    expect(find(off, 'Start talking').enabled).toBe(false);
    expect(find(off, 'Voice mode')).toMatchObject({ checked: false, action: { type: 'voice', on: true } });
    expect(find(off, 'Pause listening').enabled).toBe(false);
    const paused = trayMenu(input({ voice: voice({ paused: { until: null }, ready: false }) }));
    expect(find(paused, 'Start talking').enabled).toBe(false);
    expect(find(paused, 'Resume listening').action).toEqual({ type: 'resume' });
    expect(labels(paused)).not.toContain('Pause listening');
    expect(labels(trayMenu(input({ platform: 'win32', voice: null })))).toEqual(['Atlas', '—', 'Open Atlas', 'Quit Atlas']);
  });

  it('cards that need Master: a row each opening its Inbox item, the count on the icon, at most 5 rows', () => {
    const needs = [
      need(card(54, { status: 'blocked', block: { kind: 'needs_input', question: 'ok?', options: [] } as never })),
      need(card(51, { status: 'review' })),
      need(card(50, { status: 'blocked', block: { kind: 'capability', question: 'no tool', options: [] } as never }), true),
    ];
    const m = trayMenu(input({ needs }));
    expect(labels(m).slice(4, 9)).toEqual(['—', 'Needs you · 3', '#54 Card 54 — your answer', '#51 Card 51 — review', '#50 Card 50 — failed']);
    expect(find(m, '#54 Card 54 — your answer')).toMatchObject({ dot: 'blocked', action: { type: 'go', hash: '#/inbox/c_54' } });
    expect(find(m, '#51 Card 51 — review').dot).toBe('review');
    expect(badgeCount({ needs })).toBe(3);
    const many = Array.from({ length: 8 }, (_, i) => need(card(i + 1, { status: 'review' })));
    const big = trayMenu(input({ needs: many }));
    expect(big.filter((i) => i.action?.type === 'go' && i.action.hash.startsWith('#/inbox/'))).toHaveLength(MAX_ROWS);
    expect(find(big, 'All 8 in the Inbox…').action).toEqual({ type: 'go', hash: '#/inbox' });
  });

  it('running cards: Open (its ticket) and Stop', () => {
    const m = trayMenu(input({ running: [card(49, { title: 'Price feed refactor' })] }));
    expect(labels(m)).toContain('Running · 1');
    const row = find(m, '#49 Price feed refactor');
    expect(row.dot).toBe('running');
    expect(row.submenu!.map((s) => s.action)).toEqual([
      { type: 'go', hash: '#/board?card=c_49' },
      { type: 'stop', cardId: 'c_49' },
    ]);
  });

  it('labels: long titles cut, « & » doubled on Windows', () => {
    const long = card(7, { title: 'A very long card title that goes on and on beyond the menu width' });
    expect(cardLabel(long, 'review', 'darwin')).toMatch(/^#7 A very long card title that goes on and on…? — review$/);
    expect(cardLabel(long, null, 'darwin').length).toBeLessThanOrEqual(48);
    expect(cardLabel(card(8, { title: 'R&D' }), null, 'win32')).toBe('#8 R&&D');
    expect(cardLabel(card(8, { title: 'R&D' }), null, 'darwin')).toBe('#8 R&D');
  });

  it('« until tomorrow » is 08:00 local the next day', () => {
    expect(new Date(tomorrowMorning(new Date(2026, 11, 31, 23, 30))).getTime()).toBe(new Date(2027, 0, 1, 8, 0).getTime());
  });
});

describe('tray: icons', () => {
  const alpha = (b: Buffer) => Array.from({ length: b.length / 4 }, (_, i) => b[i * 4 + 3]!);
  const at = (b: Buffer, px: number, x: number, y: number) => b[(y * px + x) * 4 + 3]!;

  it('draws each shape as a BGRA bitmap at 1× and 2×', () => {
    for (const kind of ['ring', 'pause', 'solid', 'breathe', 'listen', 'think', 'speak', 'dot', 'half'] as IconKind[])
      for (const px of [16, 32]) {
        const b = renderIcon({ kind, px, color: [0, 0, 0] });
        expect(b.length).toBe(px * px * 4);
        expect(alpha(b).some((a) => a > 200)).toBe(true);
        expect(at(b, px, 0, 0)).toBe(0); // corners are clear
      }
    // ring: hollow centre; solid: filled centre
    expect(at(renderIcon({ kind: 'ring', px: 16, color: [0, 0, 0] }), 16, 8, 8)).toBe(0);
    expect(at(renderIcon({ kind: 'solid', px: 16, color: [0, 0, 0] }), 16, 8, 8)).toBe(255);
  });

  it('colours in BGRA order, and the animated kinds change from frame to frame', () => {
    const teal = hex('#6cc0d2');
    const b = renderIcon({ kind: 'solid', px: 16, color: teal });
    const p = (8 * 16 + 8) * 4;
    expect([b[p], b[p + 1], b[p + 2], b[p + 3]]).toEqual([0xd2, 0xc0, 0x6c, 255]);
    for (const kind of ['listen', 'think', 'speak'] as IconKind[]) {
      const frames = Array.from({ length: FRAMES }, (_, f) => renderIcon({ kind, frame: f, px: 32, color: teal }).toString('hex'));
      expect(new Set(frames).size).toBe(FRAMES);
    }
  });

  it('at rest (ready): a still sea-teal disc; the breath is a native layer, not swapped frames', () => {
    // no image timer at rest: only the awake kinds swap frames
    for (const k of ['ring', 'pause', 'solid', 'breathe', 'dot', 'half'] as IconKind[]) expect(animation(k)).toBeNull();
    for (const k of ['listen', 'think', 'speak'] as IconKind[]) expect(animation(k)).toEqual({ frames: FRAMES, fps: FRAMES });
    // the still disc is exactly the layer's resting size (the layer covers it), well inside the 16 pt box
    const teal = hex('#2f97ad');
    const disc = renderIcon({ kind: 'breathe', px: 32, color: teal });
    const p = (16 * 32 + 16) * 4;
    expect([disc[p + 2], disc[p + 1], disc[p], disc[p + 3]]).toEqual([0x2f, 0x97, 0xad, 255]);
    const row = Array.from({ length: 32 }, (_, x) => at(disc, 32, x, 16));
    const ink = row.reduce((s, a) => s + a, 0) / 255 / 2; // points of ink across the middle
    expect(ink).toBeCloseTo(2 * BREATH.base, 0);
    // a gentle breath: 4 s, swelling < 20%, the glow fitting in the box (half-size 8 pt)
    expect(BREATH.period).toBe(4);
    expect(BREATH.swell).toBeGreaterThan(BREATH.base);
    expect(BREATH.swell / BREATH.base).toBeLessThan(1.2);
    expect(BREATH.swell + BREATH.glow).toBeLessThanOrEqual(8);
    expect(breathLayer(teal)).toEqual({ r: 0x2f, g: 0x97, b: 0xad, base: BREATH.base, swell: BREATH.swell, glow: BREATH.glow, period: 4 });
  });

  it('Windows badge: an orange dot top right, with a gap', () => {
    const orange = hex('#f2994a');
    const b = renderIcon({ kind: 'solid', px: 32, color: [255, 255, 255], badge: orange });
    const p = (7 * 32 + 25) * 4; // the badge centre (12.5, 3.5 pt)
    expect([b[p + 2], b[p + 1], b[p]]).toEqual([0xf2, 0x99, 0x4a]);
    expect(() => hex('teal')).toThrow();
  });
});
