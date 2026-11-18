import type { ReactNode } from 'react';
import { tint } from './agentTint.ts';

/**
 * An agent's avatar (#104): its #94 face drawn on a rounded tile in the agent's hue (agentTint.ts). The tile and figure
 * colours come from styles.css (.face .tile / .fig / .ink / .line, per theme); the size from where it sits. An agent
 * without a drawn face gets its initial on the same tile.
 */
const FACES: Record<string, ReactNode> = {
  // compass
  atlas: (
    <>
      <path className="fig" d="m12 4 7 8-7 8-7-8Z" />
      <path className="ink" d="M9 11v2m6-2v2" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  // robot
  munih: (
    <>
      <path className="line" d="M12 4v4m-7 6H3m18 0h-2" strokeWidth="1.6" strokeLinecap="round" />
      <rect className="fig" x="5" y="8" width="14" height="11" rx="3" />
      <path className="ink" d="M9 13h.1m5.9 0h.1" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  // spark
  paris: (
    <>
      <path className="fig" d="M12 3.5c1.5 5.1 3.2 6.5 8.5 8.5-5.3 1.8-7 3.4-8.5 8.5C10.3 15.4 8.7 13.8 3.5 12c5.2-2 6.8-3.4 8.5-8.5Z" />
      <path className="ink" d="M10.3 11.6h.1m3.2 0h.1" strokeWidth="1.65" strokeLinecap="round" />
    </>
  ),
  // owl
  zurich: (
    <>
      <path className="fig" d="M5 6l4 2a9 9 0 0 1 6 0l4-2v7a7 7 0 0 1-14 0Z" />
      <path className="ink" d="M9 12v1m6-1v1m-4 2 1 1 1-1" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

export function hasFace(id: string): boolean {
  return id in FACES;
}

export function AgentFace({ id, title }: { id: string | null | undefined; title?: string }) {
  const name = id || '?';
  return (
    <span className="dot-avatar face" style={tint(id ?? '')} title={title} aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <rect className="tile" width="24" height="24" rx="7" />
        {FACES[name] ?? (
          <text className="initial" x="12" y="12" textAnchor="middle" dominantBaseline="central">
            {name.slice(0, 1).toUpperCase()}
          </text>
        )}
      </svg>
    </span>
  );
}
