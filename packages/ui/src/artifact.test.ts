import { describe, expect, it } from 'vitest';
import { artifactOf } from './cardModal.ts';

describe('artifactOf', () => {
  it('reads the card from artifact_create / artifact_update / panel_open results', () => {
    expect(artifactOf('panel_open', { path: 'docs/design.md', section: 'shell' }, 'opened Design (doc_ab12, docs/design.md, v3); shown in the side panel of chat c_1, scrolled to #shell')).toEqual({
      docId: 'doc_ab12', version: 3, title: 'Design', where: 'docs/design.md', kind: 'markdown', section: 'shell', updated: false,
    });
    expect(artifactOf('artifact_create', {}, 'created Mockup (v2) (doc_x, pages/a.html, v1) in Unfiled; shown in the side panel of chat c_1')).toMatchObject({ title: 'Mockup (v2)', kind: 'html', updated: false });
    expect(artifactOf('artifact_update', {}, 'updated Flow (doc_y, diagrams/f.svg, v4); shown…')).toMatchObject({ kind: 'diagram', version: 4, updated: true });
    expect(artifactOf('artifact_update', {}, 'unchanged Flow (doc_y, diagrams/f.svg, v4) (same content); shown…')).toMatchObject({ updated: false });
    expect(artifactOf('artifact_create', {}, 'created Dev (doc_z, links/dev.url, v1) in Feeds; not attached…')).toMatchObject({ kind: 'url' });
  });
  it('ignores other tools, errors and unknown lines', () => {
    expect(artifactOf('read_file', {}, 'opened X (doc_a, a.md, v1)')).toBeNull();
    expect(artifactOf('artifact_read', {}, 'X (doc_a, markdown, v1 of 1, Unfiled, @a:docs/x.md)')).toBeNull();
    expect(artifactOf('panel_open', {}, undefined)).toBeNull();
    expect(artifactOf('panel_open', {}, 'no document at docs/x.md')).toBeNull();
  });
});
