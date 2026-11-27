import { useEffect, useState } from 'react';

/**
 * Two looks (design §16, Linear direction): dark and light. "system" follows the OS between them. The choice lives in
 * localStorage; index.html applies it before the first paint so a reload never flashes the wrong theme.
 * The old « gray » theme is gone: a stored « gray » reads as dark.
 */
export const THEMES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEMES)[number];
export type Theme = Exclude<ThemeChoice, 'system'>;

const KEY = 'atlas.theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

/** A stored or ?theme= value → a choice: « gray » (dropped 13 Nov 2026) is dark, anything unknown is Auto. */
export function parseTheme(v: string | null): ThemeChoice {
  if (v === 'gray') return 'dark';
  return (THEMES as readonly string[]).includes(v ?? '') ? (v as ThemeChoice) : 'system';
}

export function storedTheme(): ThemeChoice {
  // ?theme=light previews a theme without saving it (also how the screenshots of each theme are taken).
  return parseTheme(new URLSearchParams(location.search).get('theme') ?? localStorage.getItem(KEY));
}

export function resolveTheme(choice: ThemeChoice): Theme {
  return choice === 'system' ? (media().matches ? 'dark' : 'light') : choice;
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/** The current choice, the theme it resolves to, and a setter. Follows OS changes while on "system". */
export function useTheme(): [ThemeChoice, Theme, (t: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(choice));
  useEffect(() => {
    const update = () => {
      const t = resolveTheme(choice);
      setTheme(t);
      apply(t);
    };
    update();
    if (choice !== 'system') return;
    const m = media();
    m.addEventListener('change', update);
    return () => m.removeEventListener('change', update);
  }, [choice]);
  // Other windows/tabs pick the change up too.
  useEffect(() => {
    const on = (e: StorageEvent) => e.key === KEY && setChoice(storedTheme());
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, []);
  return [
    choice,
    theme,
    (t) => {
      localStorage.setItem(KEY, t);
      setChoice(t);
    },
  ];
}

/**
 * The accent (#369, the #362 redesign): one colour for what is live and what you act on, chosen per device next to the
 * theme. Lime is the default. index.html applies it before the first paint; styles.css maps each one to the --accent*
 * tokens of both themes (in light, the accent is only a fill, never text on paper). ?accent= previews one unsaved.
 */
export const ACCENTS = [
  { id: 'lime', label: 'Lime', hex: '#c6ff1a' },
  { id: 'signal', label: 'Signal', hex: '#ff6b1a' },
  { id: 'ice', label: 'Ice', hex: '#2ee6ff' },
  { id: 'ultra', label: 'Ultra', hex: '#9f7aff' },
] as const;
export type Accent = (typeof ACCENTS)[number]['id'];

const ACCENT_KEY = 'atlas.accent';

/** A stored or ?accent= value → an accent; anything unknown is Lime. */
export function parseAccent(v: string | null): Accent {
  return ACCENTS.some((a) => a.id === v) ? (v as Accent) : 'lime';
}

export function storedAccent(): Accent {
  return parseAccent(new URLSearchParams(location.search).get('accent') ?? localStorage.getItem(ACCENT_KEY));
}

/** The current accent and a setter; follows a change made in another window. */
export function useAccent(): [Accent, (a: Accent) => void] {
  const [accent, setAccent] = useState<Accent>(storedAccent);
  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);
  useEffect(() => {
    const on = (e: StorageEvent) => e.key === ACCENT_KEY && setAccent(storedAccent());
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, []);
  return [
    accent,
    (a) => {
      localStorage.setItem(ACCENT_KEY, a);
      setAccent(a);
    },
  ];
}
