import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Renderer } from './types.ts';

export const markdown: Renderer<'markdown'> = {
  kind: 'markdown',
  label: 'Note',
  icon: '¶',
  size: [420, 320],
  create: () => ({ text: '## New note\n\nDouble-click to edit.' }),
  View: ({ node }) => (
    <div className="md node-md">
      <Markdown remarkPlugins={[remarkGfm]}>{node.text}</Markdown>
    </div>
  ),
  Editor: ({ node, onChange }) => (
    <textarea className="node-code" autoFocus value={node.text} onChange={(e) => onChange({ text: e.target.value })} />
  ),
};
