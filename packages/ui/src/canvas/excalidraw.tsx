import { useEffect, useRef, useState } from 'react';
import { Excalidraw, convertToExcalidrawElements, exportToSvg } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { DrawingScene, SketchElement } from '@atlas/shared';
import { sketchToSkeletons } from './sketch.ts';
import { useExcalidrawTheme } from '../theme.ts';

type Elements = Parameters<typeof exportToSvg>[0]['elements'];
type Files = NonNullable<Parameters<typeof exportToSvg>[0]['files']>;


function fromSketch(sketch: SketchElement[]): Elements {
  const skeletons = sketchToSkeletons(sketch);
  return convertToExcalidrawElements(skeletons as Parameters<typeof convertToExcalidrawElements>[0], { regenerateIds: false }) as Elements;
}

export function sceneElements(scene: DrawingScene): Elements {
  if (scene.elements) return scene.elements as Elements;
  return fromSketch(scene.sketch ?? []);
}

/** Static SVG of a drawing, for the board. */
export function DrawingPreview({ scene }: { scene: DrawingScene }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = useExcalidrawTheme();
  useEffect(() => {
    let cancelled = false;
    const elements = sceneElements(scene);
    if (!elements.length) {
      if (box.current) box.current.innerHTML = '<div class="node-empty">Empty drawing — Edit to draw</div>';
      return;
    }
    exportToSvg({
      elements,
      files: (scene.files ?? {}) as Files,
      appState: { exportBackground: false, exportWithDarkMode: theme === 'dark', viewBackgroundColor: 'transparent' },
      exportPadding: 16,
    }).then(
      (svg: SVGSVGElement) => {
        if (cancelled || !box.current) return;
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        box.current.replaceChildren(svg);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [scene, theme]);
  return error ? <div className="node-error">Drawing failed to render: {error}</div> : <div className="node-svg" ref={box} />;
}

/** Full-screen Excalidraw editor. Saves the full elements (the sketch is replaced) on close. */
export function DrawingEditor(props: { title: string; scene: DrawingScene; onClose(scene: DrawingScene | null): void }) {
  const latest = useRef<{ elements: Elements; files: Files } | null>(null);
  const theme = useExcalidrawTheme();
  const [initial] = useState(() => ({
    elements: sceneElements(props.scene),
    files: (props.scene.files ?? {}) as Files,
    appState: { viewBackgroundColor: '#ffffff' }, // Excalidraw's dark theme inverts it to near-black
    scrollToContent: true,
  }));
  return (
    <div className="drawing-modal">
      <div className="drawing-bar">
        <span>{props.title || 'Drawing'}</span>
        <button className="ghost" onClick={() => props.onClose(null)}>
          Cancel
        </button>
        <button
          className="primary"
          onClick={() => {
            const l = latest.current;
            props.onClose(l ? { elements: l.elements.filter((e: { isDeleted?: boolean }) => !e.isDeleted) as unknown[], files: l.files as Record<string, unknown> } : null);
          }}
        >
          Save & close
        </button>
      </div>
      <div className="drawing-host">
        <Excalidraw
          theme={theme}
          initialData={initial as never}
          onChange={(elements, _state, files) => {
            latest.current = { elements: elements as Elements, files: files as Files };
          }}
        />
      </div>
    </div>
  );
}
