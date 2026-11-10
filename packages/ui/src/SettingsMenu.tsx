import { useEffect, useRef, useState } from 'react';

export const SETTINGS_SECTIONS = ['canvas', 'models', 'agents', 'board'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export const settingsLabel = (s: SettingsSection) => s.charAt(0).toUpperCase() + s.slice(1);

/** A disclosure with ordinary links: native Tab/Enter plus arrow-key navigation. */
export function SettingsMenu({ active, onNavigate }: { active: SettingsSection | null; onNavigate(): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const links = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    const navigate = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('hashchange', navigate);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('hashchange', navigate);
    };
  }, [open]);
  const focusLink = (last = false) => requestAnimationFrame(() => {
    const items = links.current?.querySelectorAll('a');
    items?.[last ? items.length - 1 : 0]?.focus();
  });
  return (
    <div className="settings-disclosure" ref={root} onBlur={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
    }}>
      <button ref={trigger} className={'nav-item' + (active ? ' active' : '')}
        aria-expanded={open} aria-controls="settings-destinations"
        onClick={() => setOpen(!open)} onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault(); setOpen(true); focusLink(e.key === 'ArrowUp');
          }
        }}>
        <svg className="icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="2" />
          <path d="M8 1v2m0 10v2M1 8h2m10 0h2M3 3l1.5 1.5m7 7L13 13M3 13l1.5-1.5m7-7L13 3" />
        </svg>
        <span>Settings</span><span className="settings-chevron" aria-hidden="true">{open ? '⌄' : '⌃'}</span>
      </button>
      {open && <div id="settings-destinations" className="settings-dropdown" ref={links} onKeyDown={(e) => {
        const items = Array.from(links.current?.querySelectorAll('a') ?? []);
        const i = items.indexOf(document.activeElement as HTMLAnchorElement);
        let next: number;
        if (e.key === 'ArrowDown') next = (i + 1) % items.length;
        else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        else return;
        e.preventDefault(); items[next]?.focus();
      }}>
        {SETTINGS_SECTIONS.map((s) => <a key={s} href={'#/settings/' + s}
          aria-current={active === s ? 'page' : undefined} onClick={(e) => {
            e.preventDefault();
            location.hash = '#/settings/' + s;
            setOpen(false); onNavigate(); trigger.current?.focus();
          }}>{settingsLabel(s)}</a>)}
      </div>}
    </div>
  );
}
