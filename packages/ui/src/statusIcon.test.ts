import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CARD_STATUSES } from '@atlas/shared';
import { StatusIcon, STATUS_LABEL, type IconStatus } from './StatusIcon.tsx';

const html = (status: IconStatus, title?: string) => renderToStaticMarkup(createElement(StatusIcon, { status, title }));

describe('StatusIcon', () => {
  it('draws every card status, plus failed, each with its label', () => {
    for (const s of [...CARD_STATUSES, 'failed'] as IconStatus[]) {
      const out = html(s);
      expect(out).toContain(`class="status-icon ${s}"`);
      expect(out).toContain(`aria-label="${STATUS_LABEL[s]}"`);
      expect(out).toMatch(/<(circle|path)/);
    }
  });
  it('uses the status tokens, so both themes colour it', () => {
    expect(html('triage')).toContain('stroke-dasharray');
    expect(html('running')).toContain('var(--st-running)');
    expect(html('blocked')).toContain('var(--st-blocked)');
    expect(html('review')).toContain('var(--st-review)');
    expect(html('done')).toContain('var(--st-done)');
  });
  it('takes a tooltip', () => expect(html('done', 'Done 2h ago')).toContain('<title>Done 2h ago</title>'));
});
