import type { CanvasNodeKind } from '@atlas/shared';
import type { Renderer } from './types.ts';
import { markdown } from './markdown.tsx';
import { html } from './html.tsx';
import { url } from './url.tsx';
import { drawing } from './drawing.tsx';

/** The registry: every node kind and its renderer. */
export const RENDERERS: { [K in CanvasNodeKind]: Renderer<K> } = { drawing, html, url, markdown };
export const KINDS = Object.keys(RENDERERS) as CanvasNodeKind[];
