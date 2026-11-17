import type { CanvasNodeKind } from '@atlas/shared';
import type { Renderer } from './types.ts';
import { markdown } from './markdown.tsx';
import { html } from './html.tsx';
import { url } from './url.tsx';

/** The registry: every node kind and its renderer. */
export const RENDERERS: { [K in CanvasNodeKind]: Renderer<K> } = { html, url, markdown };
export const KINDS = Object.keys(RENDERERS) as CanvasNodeKind[];
/** A node this UI can draw: a kind that was removed (v3: Excalidraw drawings) or is newer than the UI is skipped, never a crash. */
export const isKnown = (n: { kind: string }): boolean => Object.hasOwn(RENDERERS, n.kind);
