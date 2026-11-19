import type { CardStall } from '@atlas/shared';
import { api } from './api.ts';

/** The one action that unsticks a stuck task (#237), as a button: label and call. Null: Master opens it and decides. */
export function stallAction(s: Pick<CardStall, 'action'>): { label: string; run: (cardId: string) => Promise<unknown> } | null {
  switch (s.action) {
    case 'retry_review':
      return { label: 'Retry the review', run: (id) => api.retry(id) };
    case 'restart':
      return { label: 'Restart the run', run: (id) => api.retry(id) };
    case 'ready':
      return { label: 'Move to Ready', run: (id) => api.updateCard(id, { status: 'ready' }) };
    case 'open':
      return null;
  }
}
