import { useEffect, useState } from 'react';

/**
 * Three looks: light (white sheet on a blue-grey frame), gray (soft neutral greys, easy on the eyes all day) and
 * dark (true black). "system" follows the OS between light and dark. The choice lives in localStorage; index.html
 * applies it before the first paint so a reload never flashes the wrong theme.
 */
export const THEMES = ['system', 'light', 'gray', 'dark'] as const;
export type ThemeChoice = (typeof THEMES)[number];
export type Theme = Exclude<ThemeChoice, 'system'>;

const KEY = 'atlas.theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function storedTheme(): ThemeChoice {
  // ?theme=gray previews a theme without saving it (also how the screenshots of each theme are taken).
  const v = new URLSearchParams(location.search).get('theme') ?? localStorage.getItem(KEY);
  return (THEMES as readonly string[]).includes(v ?? '') ? (v as ThemeChoice) : 'system';
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

/** Excalidraw has only light and dark: gray and dark both draw dark. Re-renders when the theme changes. */
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
