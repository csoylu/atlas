import type { Renderer } from './types.ts';

/** HTML runs in an opaque-origin sandbox: scripts yes, access to Atlas no. */
export const SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals';

const STARTER = `<!doctype html>
<html>
  <head>
    <style>
      body { font-family: system-ui, sans-serif; display: grid; place-items: center; height: 100vh; margin: 0;
             background: #f4f6f8; color: #131416; }
      button { font: inherit; padding: 10px 18px; border: 0; border-radius: 6px; cursor: pointer;
               background: #16181a; color: #fff; font-weight: 500; }
    </style>
  </head>
  <body><button onclick="this.textContent='Clicked'">A component</button></body>
</html>`;

export const html: Renderer<'html'> = {
  kind: 'html',
  label: 'HTML',
  icon: '</>',
  size: [640, 480],
  create: () => ({ html: STARTER }),
  View: ({ node, interactive }) => (
    <iframe
      className="node-frame"
      title={node.title || node.id}
      sandbox={SANDBOX}
      srcDoc={node.html}
      style={{ pointerEvents: interactive ? 'auto' : 'none' }}
    />
  ),
  Editor: ({ node, onChange }) => (
    <textarea className="node-code mono" autoFocus spellCheck={false} value={node.html} onChange={(e) => onChange({ html: e.target.value })} />
  ),
};
