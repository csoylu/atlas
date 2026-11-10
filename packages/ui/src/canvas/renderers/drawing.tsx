import { lazy, Suspense } from 'react';
import type { Renderer } from './types.ts';

// Excalidraw is large: load it only when a drawing is on screen.
const Preview = lazy(() => import('../excalidraw.tsx').then((m) => ({ default: m.DrawingPreview })));

export const drawing: Renderer<'drawing'> = {
  kind: 'drawing',
  label: 'Drawing',
  icon: '✎',
  size: [720, 480],
  create: () => ({ scene: { sketch: [] } }),
  modal: true,
  View: ({ node }) => (
    <Suspense fallback={<div className="node-loading">Loading drawing…</div>}>
      <Preview scene={node.scene} />
    </Suspense>
  ),
};
