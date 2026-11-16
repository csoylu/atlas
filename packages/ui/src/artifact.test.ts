import { describe, expect, it } from 'vitest';
import { artifactOf } from './cardModal.ts';

describe('artifactOf', () => {
  it('reads the document panel_open showed from its result line', () => {
    expect(artifactOf('panel_open', { path: 'docs/design.md', section: 'shell' }, 'opened Design (doc_ab12, docs/design.md, v3) in the side panel of chat c_1, scrolled to #shell')).toEqual({
      docId: 'doc_ab12', version: 3, title: 'Design', where: 'docs/design.md', kind: 'doc', section: 'shell',
    });
  });
  it('knows pages, diagrams and whiteboards, and titles with parentheses', () => {
    expect(artifactOf('panel_open', {}, 'opened Mockup (v2) (doc_x, pages/a.html, v1) in the side panel of chat c_1')).toMatchObject({ title: 'Mockup (v2)', kind: 'page', section: null });
    expect(artifactOf('panel_open', {}, 'opened Flow (doc_y, diagrams/f.svg, v4) in the side panel of chat c_1')?.kind).toBe('diagram');
    expect(artifactOf('panel_open', {}, 'Board (doc_z, canvas cv_1, v9) is indexed. This card has no chat…')).toMatchObject({ kind: 'whiteboard', where: 'canvas cv_1' });
  });
  it('ignores other tools, errors and missing results', () => {
    expect(artifactOf('read_file', {}, 'opened X (doc_a, a.md, v1)')).toBeNull();
    expect(artifactOf('panel_open', {}, undefined)).toBeNull();
    expect(artifactOf('panel_open', {}, 'no document at docs/x.md')).toBeNull();
  });
});
