import type { Renderer } from './types.ts';
import { SANDBOX } from './html.tsx';

/**
 * A running app or a served file. Same-origin URLs (agent workspace files under /api/files) stay in an opaque-origin
 * sandbox; other origins (a Vite dev server on another port) get allow-same-origin so they work normally — they are
 * cross-origin to Atlas anyway.
 */
function sandboxFor(url: string): string {
  try {
    return new URL(url, location.href).origin === location.origin ? SANDBOX : SANDBOX + ' allow-same-origin';
  } catch {
    return SANDBOX;
  }
}

export const url: Renderer<'url'> = {
  kind: 'url',
  label: 'App / URL',
  icon: '⧉',
  size: [960, 640],
  create: () => ({ url: 'http://localhost:5174' }),
  View: ({ node, interactive }) => (
    <iframe
      className="node-frame"
      title={node.title || node.url}
      sandbox={sandboxFor(node.url)}
      src={node.url}
      style={{ pointerEvents: interactive ? 'auto' : 'none' }}
    />
  ),
  Editor: ({ node, onChange }) => (
    <div className="node-url-edit">
      <label>URL of a running app, a page, or /api/files/&lt;agent&gt;/&lt;path&gt;</label>
      <input autoFocus value={node.url} onChange={(e) => onChange({ url: e.target.value })} />
      <a href={node.url} target="_blank" rel="noreferrer">
        Open in a new tab ↗
      </a>
    </div>
  ),
};
