import { createRequire } from 'node:module';

/**
 * Push-to-talk « hold ⌥ » (card #75): hold Option alone (left or right) to talk, release to send. What counts as a
 * hold is decided here, from the raw events of the native event tap (optionkey.mm), so it is tested without a keyboard.
 */
export type HoldEvent = 'start' | 'end' | 'cancel';

/** One raw event: modifiers changed (⌥ down or not, any other modifier down or not), a key pressed, a mouse click. */
export type RawKeyEvent = { kind: 'flags'; alt: boolean; others: boolean } | { kind: 'key' } | { kind: 'mouse' };

/** ⌥ held for less than this is a tap (or the start of ⌥-something): nothing happens. */
export const HOLD_MIN_MS = 150;

/**
 * ⌥ alone, held HOLD_MIN_MS → 'start'; released → 'end'. Another key, a click or another modifier while ⌥ is down: no
 * start, or 'cancel' if it had started; nothing more until ⌥ is released. ⌥ pressed while another modifier is
 * already down: nothing.
 */
export class OptionHold {
  private st: 'up' | 'pressed' | 'active' | 'spoiled' = 'up';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly on: (e: HoldEvent) => void,
    private readonly minMs = HOLD_MIN_MS,
  ) {}

  get state(): 'up' | 'pressed' | 'active' | 'spoiled' {
    return this.st;
  }

  input(e: RawKeyEvent): void {
    if (e.kind === 'flags' && !e.alt) {
      // ⌥ released (with or without other modifiers still down)
      const was = this.st;
      this.to('up');
      if (was === 'active') this.on('end');
      return;
    }
    if (e.kind === 'flags' && this.st === 'up') {
      if (e.others) return this.to('spoiled'); // ⌥ added to ⌘ / ⌃ / ⇧: a combo
      this.to('pressed');
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.st !== 'pressed') return;
        this.st = 'active';
        this.on('start');
      }, this.minMs);
      return;
    }
    // ⌥ is down: a key, a click or another modifier makes it a combo
    if (e.kind === 'flags' && !e.others) return; // ⌥ still down, another modifier let go
    if (this.st === 'pressed') return this.to('spoiled');
    if (this.st === 'active') {
      this.to('spoiled');
      this.on('cancel');
    }
  }

  /** Forget the key state (the tap stopped): a hold under way is cancelled. */
  reset(): void {
    const was = this.st;
    this.to('up');
    if (was === 'active') this.on('cancel');
  }

  private to(st: OptionHold['st']) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.st = st;
  }
}

/** What the voice loop uses to watch ⌥ (the native tap in the app, a fake in tests). */
export interface HoldKeyPort {
  /**
   * Starts watching ⌥. `onStatus(null)`: it works; `onStatus(problem)`: macOS does not allow it (Input Monitoring),
   * tried again every few seconds until it does.
   */
  watch(on: (e: HoldEvent) => void, onStatus: (problem: string | null) => void): void;
  unwatch(): void;
}

interface Native {
  access(): boolean;
  request(): boolean;
  start(cb: (kind: number, flags: number) => void): true | string;
  stop(): void;
}

// CGEventFlags (CGEventTypes.h)
const SHIFT = 0x20000;
const CONTROL = 0x40000;
const ALTERNATE = 0x80000;
const COMMAND = 0x100000;
const FN = 0x800000;
const RETRY_MS = 2000;

export const INPUT_MONITORING_PROBLEM =
  'Hold ⌥ needs the Input Monitoring permission: allow Atlas in System Settings → Privacy & Security → Input Monitoring. It starts working within a few seconds; if not, quit and reopen Atlas.';

/** The CGEventFlags of a tap event → a RawKeyEvent. */
export function rawEvent(kind: number, flags: number): RawKeyEvent {
  if (kind === 1) return { kind: 'key' };
  if (kind === 2) return { kind: 'mouse' };
  return { kind: 'flags', alt: (flags & ALTERNATE) !== 0, others: (flags & (SHIFT | CONTROL | COMMAND | FN)) !== 0 };
}

/**
 * The native tap (dist/native/optionkey.node, built by build.mjs next to dist/main.mjs). Without the permission it
 * asks macOS once (Atlas then shows in the Input Monitoring list), reports the problem and retries every 2 s.
 */
export function nativeHoldKey(log: (line: string) => void): HoldKeyPort {
  let native: Native | undefined;
  let hold: OptionHold | null = null;
  let retry: ReturnType<typeof setInterval> | null = null;
  let asked = false;
  const stop = () => {
    if (retry) clearInterval(retry);
    retry = null;
    native?.stop();
    hold?.reset();
    hold = null;
  };
  return {
    watch(on, onStatus) {
      stop();
      if (process.platform !== 'darwin') return onStatus('Hold ⌥ works on a Mac only: pick a shortcut such as ⌥ Space.');
      try {
        native ??= createRequire(import.meta.url)('./native/optionkey.node') as Native;
      } catch (e) {
        return onStatus(`Hold ⌥ could not load its native part: ${e instanceof Error ? e.message : String(e)}`);
      }
      const n = native;
      const h = (hold = new OptionHold(on));
      let last: string | null | undefined;
      const attempt = () => {
        if (hold !== h) return;
        if (!n.access() && !asked) {
          asked = true;
          n.request(); // macOS's prompt, once; lists Atlas under Input Monitoring
        }
        const r = n.start((kind, flags) => h.input(rawEvent(kind, flags)));
        const problem = r === true ? null : INPUT_MONITORING_PROBLEM;
        if (problem !== last) {
          last = problem;
          log(r === true ? 'hold ⌥: watching the keyboard' : `hold ⌥: ${r}`);
          onStatus(problem);
        }
        if (r === true && retry) {
          clearInterval(retry);
          retry = null;
        }
      };
      attempt();
      if (last !== null) retry = setInterval(attempt, RETRY_MS);
    },
    unwatch: stop,
  };
}
