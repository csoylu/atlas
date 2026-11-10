import type { ServerEvent } from '@atlas/shared';

type Listener = (e: ServerEvent) => void;

/** In-process event bus. Events are emitted only after the transaction that caused them commits. */
export class Bus {
  private listeners = new Set<Listener>();
  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: ServerEvent): void {
    for (const l of this.listeners) l(e);
  }
}
