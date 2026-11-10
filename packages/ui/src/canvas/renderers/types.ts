import type { ComponentType } from 'react';
import type { CanvasNode, CanvasNodeKind } from '@atlas/shared';

export type NodeOf<K extends CanvasNodeKind> = Extract<CanvasNode, { kind: K }>;

/** One renderer per node kind (design §16). Adding a kind = a file in this folder + an entry in index.ts. */
export interface Renderer<K extends CanvasNodeKind = CanvasNodeKind> {
  kind: K;
  label: string;
  icon: string;
  /** Content of a new node of this kind. */
  create(): Omit<NodeOf<K>, 'id' | 'x' | 'y' | 'w' | 'h' | 'title' | 'kind'>;
  size: [number, number];
  /** Live view inside the node frame. `interactive` is false while the board is being dragged. */
  View: ComponentType<{ node: NodeOf<K>; interactive: boolean }>;
  /** Editor shown when the node is in edit mode; omit if the kind edits in a modal (drawing). */
  Editor?: ComponentType<{ node: NodeOf<K>; onChange(patch: Partial<NodeOf<K>>): void }>;
  /** Opens a full-screen editor instead of inline editing. */
  modal?: boolean;
}
