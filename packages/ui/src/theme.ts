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

/** Excalidraw follows the theme (light or dark). Re-renders when the theme changes. */
export function useExcalidrawTheme(): 'light' | 'dark' {
  const read = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const [t, setT] = useState<'light' | 'dark'>(read);
  useEffect(() => {
    const o = new MutationObserver(() => setT(read()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => o.disconnect();
  }, []);
  return t;
}
