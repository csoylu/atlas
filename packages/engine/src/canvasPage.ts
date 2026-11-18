/**
 * A canvas (removed in #120) as one html page: its nodes top to bottom, left to right, each under its title. Markdown
 * stays text (pre-wrap), html nodes keep rendering in their own sandboxed frames, url nodes become a frame and a link.
 */
export interface OldNode {
  id: string;
  kind: 'markdown' | 'html' | 'url' | string;
  title?: string;
  x?: number;
  y?: number;
  h?: number;
  text?: string;
  html?: string;
  url?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function canvasPage(name: string, nodes: OldNode[], updatedAt: string): string {
  const sorted = [...nodes].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
  const body = sorted
    .map((n) => {
      const h = Math.max(240, Math.min(1400, Math.round(n.h ?? 480)));
      const title = n.title ? `<h2>${esc(n.title)}</h2>` : '';
      if (n.kind === 'markdown') return `<section>${title}<div class="md">${esc(n.text ?? '')}</div></section>`;
      if (n.kind === 'html')
        return `<section>${title}<iframe sandbox="allow-scripts allow-forms" style="height:${h}px" srcdoc="${esc(n.html ?? '')}"></iframe></section>`;
      if (n.kind === 'url') {
        const u = n.url ?? '';
        return `<section>${title}<p><a href="${esc(u)}" target="_blank" rel="noreferrer">${esc(u)}</a></p><iframe sandbox="allow-scripts allow-forms allow-same-origin" style="height:${h}px" src="${esc(u)}"></iframe></section>`;
      }
      return '';
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 1100px; margin: 0 auto; }
  header p { opacity: .75; margin: 4px 0 0; }
  section { margin: 32px 0 0; }
  h1 { font-size: 24px; margin: 0; }
  h2 { font-size: 17px; margin: 0 0 8px; }
  .md { white-space: pre-wrap; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; padding: 16px; }
  iframe { width: 100%; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; background: #fff; }
</style>
</head>
<body>
<main>
<header><h1>${esc(name)}</h1><p>Canvas converted to a page when canvases were replaced by artifacts. Last changed ${esc(updatedAt.slice(0, 10))}.</p></header>
${body || '<p>This canvas was empty.</p>'}
</main>
</body>
</html>
`;
}
