import { paneLabel, type PaneSees } from '@atlas/shared';

/** The eye (mockup « the right pane as a workbench », #300). */
export function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path
        d={
          off
            ? 'M2.5 2.5l11 11 M6.3 4c.5-.2 1.1-.3 1.7-.3 3.9 0 6.2 4.3 6.2 4.3s-.6 1.1-1.7 2.2 M4 5.5C2.6 6.6 1.8 8 1.8 8s2.3 4.3 6.2 4.3c.9 0 1.7-.2 2.4-.5'
            : 'M1.8 8s2.3-4.3 6.2-4.3S14.2 8 14.2 8s-2.3 4.3-6.2 4.3S1.8 8 1.8 8z M8 6.3a1.7 1.7 0 1 0 0.01 0'
        }
      />
    </svg>
  );
}

/**
 * « What the agent sees » (#305): next to the context ring, the tab open in the pane, sent with the message (where it
 * is, not its content). A click leaves it out of this message only; the next one sends it again.
 */
export function PaneEye({ sees, off, onToggle }: { sees: PaneSees; off: boolean; onToggle(): void }) {
  const name = paneLabel(sees);
  return (
    <button
      type="button"
      className={'pane-eye' + (off ? ' off' : '')}
      aria-pressed={!off}
      aria-label={off ? `${name}: left out of this message` : `${name}: sent with your message`}
      title={off ? 'Left out of this message. Click to send it.' : `Sent with your message: the open tab, ${name}. Click to leave it out of this message.`}
      onClick={onToggle}
    >
      <EyeIcon off={off} />
      <span>{name}</span>
    </button>
  );
}
