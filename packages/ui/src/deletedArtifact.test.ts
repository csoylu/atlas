import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactChip } from './ChatActivity.tsx';
import { noteDeleted } from './artifacts.ts';
import { toolRow } from './toolRows.ts';
import type { MessageStream } from './useMessages.ts';
import type { Artifact } from './cardModal.ts';

const stream: MessageStream = { push() {}, listen: () => () => {} };
const art: Artifact = { docId: 'doc_gone1', version: 3, title: 'Old mockup', where: 'pages/old.html', kind: 'html', section: null, updated: false };
const render = (a: Artifact) => renderToStaticMarkup(createElement(ArtifactChip, { art: a, stream, onOpen() {} }));

describe('a chat card of a deleted artifact (#242)', () => {
  it('says « Deleted artifact » and opens nothing', () => {
    expect(render({ ...art, docId: 'doc_live1' })).toContain('<button');
    noteDeleted('doc_gone1');
    const html = render(art);
    expect(html).toContain('class="artifact deleted"');
    expect(html).toContain('Old mockup');
    expect(html).toContain('Deleted artifact · Page · v3');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Open');
  });

  it('the artifact_delete row', () => {
    expect(toolRow('artifact_delete', { artifact: 'doc_gone1' }, { content: 'deleted Old mockup (doc_gone1, pages/old.html): 3 versions and the file removed', isError: false })).toMatchObject({
      icon: 'trash', verb: 'Deleted', object: 'Old mockup', meta: [{ text: '3 versions' }], short: { verb: 'deleted', obj: 'Old mockup' },
    });
    expect(toolRow('artifact_delete', { path: 'pages/x.html' }, { content: "X (doc_a) is @paris's artifact: you can delete only your own", isError: true }).object).toBe('pages/x.html');
  });
});
