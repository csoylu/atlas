import { useMemo } from 'react';
import type { Doc, Folder, Memory, MemoryProposal, PanelTab, ClaudePlanStatus, LocalPull, LocalStatus, Message, Run, ToolCallTiming, VoiceStatus } from '@atlas/shared';

/** Fan-out of live chat events to whichever card panel is listening. */
export type LiveEvent =
  | { type: 'message'; message: Message }
  | { type: 'delta'; runId: string; text: string }
  /** Thinking text as it streams (#80). */
  | { type: 'thinking'; runId: string; text: string }
  | { type: 'run'; run: Run }
  | { type: 'toolcall'; call: ToolCallTiming }
  /** A rewind hid messages, or its undo brought them back: reload the conversation. */
  | { type: 'rewound' }
  /** Library folders changed (key 'folders'). */
  | { type: 'folders'; folders: Folder[] }
  | { type: 'local'; status: LocalStatus }
  | { type: 'pull'; pull: LocalPull }
  | { type: 'usage' }
  | { type: 'claude'; status: ClaudePlanStatus }
  | { type: 'doc'; doc: Doc }
  | { type: 'panel'; tabs: PanelTab[] }
  | { type: 'voice'; status: VoiceStatus }
  /** A memory was added or changed (key 'memories'). */
  | { type: 'memory'; memory: Memory }
  /** A cleanup proposal was filed or decided (key 'memories'). */
  | { type: 'proposal'; proposal: MemoryProposal };

export interface MessageStream {
  push(conversationOrCard: string, e: LiveEvent): void;
  listen(key: string, fn: (e: LiveEvent) => void): () => void;
}

export function useMessageStream(): MessageStream {
  return useMemo(() => {
    const listeners = new Map<string, Set<(e: LiveEvent) => void>>();
    return {
      push(key, e) {
        listeners.get(key)?.forEach((fn) => fn(e));
      },
      listen(key, fn) {
        const set = listeners.get(key) ?? new Set();
        set.add(fn);
        listeners.set(key, set);
        return () => set.delete(fn);
      },
    };
  }, []);
}
