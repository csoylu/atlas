import { Menu, Tray, nativeImage, nativeTheme, screen, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { breather, breathLayer } from './breathe.ts';
import { animation, hex, ICON_PT, renderIcon, type IconKind, type Rgb } from './icons.ts';
import { badgeCount, iconKind, isAwake, tooltip, trayMenu, trayVoice, type TrayAction, type TrayInput, type TrayItem } from './model.ts';

/**
 * The menu bar (macOS) / system tray (Windows) orb, card #54. The icon shows voice mode (off, paused, ready, listening,
 * thinking, speaking) and, on a Mac, the number of cards that need Master next to it (Windows: an orange dot on the
 * icon). A click opens a native menu built fresh from the live state (model.ts → trayMenu).
 *
 * Off, starting and paused: a macOS template image (black + alpha: the system draws it for a dark or light menu bar).
 * Ready (« Hi Atlas »): a still sea-teal disc that breathes (4 s) through a native Core Animation layer on macOS
 * (breathe.mm, card #56): no timer, no work in Atlas at rest. Awake: the accent, frames precomputed when the state
 * changes and swapped at 8 fps.
 */
export interface TrayHost {
  /** The current state; called on every refresh and at each click. */
  input(): TrayInput;
  act(action: TrayAction): void;
  /** Problems worth a line in a log (the breathing layer failing to load or attach). */
  log(line: string): void;
}

const ACCENT_DARK = hex('#6cc0d2');
const ACCENT_LIGHT = hex('#1b6c80');
/** Ready: one mid sea-teal for every menu bar. macOS tints the bar from the wallpaper, so its brightness doesn't follow
 * the app's dark/light mode; this one reads on both (contrast ≈ 3.4:1 on white, ≈ 4.9:1 on #1e1e1e). */
const BREATHE = hex('#2f97ad');
const BADGE = hex('#f2994a');
const DOTS: Record<NonNullable<TrayItem['dot']>, { kind: IconKind; color: Rgb }> = {
  blocked: { kind: 'dot', color: hex('#f2994a') },
  failed: { kind: 'dot', color: hex('#eb5757') },
  review: { kind: 'half', color: hex('#4cb782') },
  running: { kind: 'dot', color: hex('#f2c94c') },
};

function image(kind: IconKind, frame: number, color: Rgb, opts: { template?: boolean; badge?: Rgb; pt?: number } = {}): NativeImage {
  const pt = opts.pt ?? ICON_PT;
  const img = nativeImage.createEmpty();
  for (const scale of [1, 2]) {
    const px = Math.round(pt * scale);
    // icons.ts draws in a 16 pt box: smaller sizes (menu dots) are the same drawing scaled down
    img.addRepresentation({ scaleFactor: scale, width: px, height: px, buffer: renderIcon({ kind, frame, px, color, badge: opts.badge }) });
  }
  if (opts.template) img.setTemplateImage(true);
  return img;
}

export class AtlasTray {
  private readonly tray: Tray;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private shown = '';
  private pending: ReturnType<typeof setTimeout> | null = null;
  private readonly dots = new Map<string, NativeImage>();
  /** The breathing layer is on (macOS, ready). */
  private breathing = false;
  private title = '';
  private placing: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: TrayHost) {
    this.tray = new Tray(this.icon('solid', 0, false), '6f2b8a54-6d3e-4c1a-9f0e-a71a5c0b5454');
    // A fresh menu at each click (the state changes all the time); left and right click alike, Mac and Windows.
    const open = () => this.tray.popUpContextMenu(this.menu());
    this.tray.on('click', open);
    this.tray.on('right-click', open);
    nativeTheme.on('updated', () => this.refresh(true));
    // the menu bar moved or changed size: put the layer back over the icon
    screen.on('display-metrics-changed', () => this.placeBreath());
    screen.on('display-added', () => this.placeBreath());
    screen.on('display-removed', () => this.placeBreath());
    this.refresh();
  }

  /** State changed (voice, cards, inbox): redraw soon (bursts of events → one redraw). */
  changed(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.refresh();
    }, 150);
  }

  /** The orb's state changed: redraw now (listening must show at once). */
  now(): void {
    this.refresh();
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    if (this.placing) clearTimeout(this.placing);
    this.stopBreath();
    this.tray.destroy();
  }

  private refresh(force = false): void {
    if (this.tray.isDestroyed()) return;
    const input = this.host.input();
    const v = trayVoice(input);
    const kind = iconKind(v);
    const n = badgeCount(input);
    const mac = process.platform === 'darwin';
    this.tray.setToolTip(tooltip(input));
    const title = n ? String(n) : '';
    if (mac) this.tray.setTitle(title, { fontType: 'monospacedDigit' });
    // the count moves the icon inside the status item: the layer follows
    if (title !== this.title && this.breathing) this.placeBreath();
    this.title = title;
    const key = `${kind}|${isAwake(v)}|${mac ? '' : n > 0}|${nativeTheme.shouldUseDarkColors}`;
    if (key === this.shown && !force) return;
    this.shown = key;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.frame = 0;
    const badge = !mac && n > 0;
    const anim = animation(kind);
    const frames = Array.from({ length: anim?.frames ?? 1 }, (_, f) => this.icon(kind, f, isAwake(v), badge));
    this.tray.setImage(frames[0]!);
    if (kind === 'breathe' && mac) {
      this.breathing = true;
      this.placeBreath();
    } else this.stopBreath();
    if (anim)
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % frames.length;
        if (!this.tray.isDestroyed()) this.tray.setImage(frames[this.frame]!);
      }, 1000 / anim.fps);
  }

  /** (Re)attach the breathing layer once AppKit has laid the status item out. A failure is logged, the still disc stays. */
  private placeBreath(): void {
    if (!this.breathing || this.placing) return;
    this.placing = setTimeout(() => {
      this.placing = null;
      if (!this.breathing || this.tray.isDestroyed()) return;
      try {
        const ok = breather().attach(breathLayer(BREATHE));
        if (ok !== true) this.host.log(`breathing layer not attached: ${ok}`);
      } catch (e) {
        this.breathing = false;
        this.host.log(`breathing layer unavailable: ${(e as Error).message}`);
      }
    }, 100);
  }

  private stopBreath(): void {
    if (!this.breathing) return;
    this.breathing = false;
    breather().detach();
  }

  private icon(kind: IconKind, frame: number, awake: boolean, badge = false): NativeImage {
    const dark = nativeTheme.shouldUseDarkColors;
    if (process.platform === 'darwin') {
      if (kind === 'breathe') return image(kind, frame, BREATHE);
      if (awake) return image(kind, frame, dark ? ACCENT_DARK : ACCENT_LIGHT);
      return image(kind, frame, [0, 0, 0], { template: true });
    }
    // Windows / Linux: no template images; white on a dark taskbar, black on a light one
    const ink: Rgb = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI || dark ? [255, 255, 255] : [0, 0, 0];
    return image(kind, frame, awake ? (dark ? ACCENT_DARK : ACCENT_LIGHT) : ink, { badge: badge ? BADGE : undefined });
  }

  private dot(d: NonNullable<TrayItem['dot']>): NativeImage {
    let img = this.dots.get(d);
    if (!img) {
      img = image(DOTS[d].kind, 0, DOTS[d].color, { pt: 12 });
      this.dots.set(d, img);
    }
    return img;
  }

  private menu(): Menu {
    const build = (items: TrayItem[]): MenuItemConstructorOptions[] =>
      items.map((it) => {
        if (it.type === 'separator') return { type: 'separator' };
        const o: MenuItemConstructorOptions = { label: it.label, enabled: it.enabled ?? true };
        if (it.type === 'checkbox') Object.assign(o, { type: 'checkbox', checked: !!it.checked });
        if (it.dot) o.icon = this.dot(it.dot);
        if (it.accelerator) Object.assign(o, { accelerator: it.accelerator, registerAccelerator: false });
        if (it.submenu) o.submenu = build(it.submenu);
        const action = it.action;
        if (action) o.click = () => this.host.act(action);
        return o;
      });
    return Menu.buildFromTemplate(build(trayMenu(this.host.input())));
  }
}
