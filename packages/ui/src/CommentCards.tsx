// Comments (#304) in the chat: the numbered chips waiting in the composer, and a sent message's cards (a thumbnail or
// the quoted lines, then the words). What the agent got (path, version, anchor) stays in the text block; the cards show
// the human part, and a click opens the place in the pane.
import type { ReactNode } from 'react';
import { parseComment, type ImageBlock, type Message, type ParsedComment } from '@atlas/shared';
import { ImageThumbs, imageUrl } from './Images.tsx';
import { KindIcon } from './Viewer.tsx';
import type { CommentDraft } from './comments.ts';
import type { MessageRef } from './CardPanel.tsx';

export function CommentChips({ list, label, onRemove }: { list: CommentDraft[]; label(c: CommentDraft): string; onRemove(id: string): void }) {
  return (
    <div className="cm-chips" aria-label="Comments to send">
      {list.map((c) => (
        <div key={c.id} className="cm-chip" title={c.text}>
          <span className="cm-num">{c.n}</span>
          <ChipThumb c={c} />
          <span className="cm-chip-t">
            {c.text}
            <i> · {label(c)}</i>
          </span>
          <button type="button" aria-label={`Remove comment ${c.n}`} onClick={() => onRemove(c.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function ChipThumb({ c }: { c: CommentDraft }) {
  if (c.thumb) return <img className="cm-thumb" src={c.thumb} alt="" />;
  const lines = c.anchor.type === 'lines' ? [c.anchor.from, c.anchor.to] : c.anchor.type === 'text' ? c.anchor.lines : null;
  if (lines) return <span className="cm-lines">L{lines[0] === lines[1] ? lines[0] : `${lines[0]}–${lines[1]}`}</span>;
  return (
    <span className="cm-kind" aria-hidden="true">
      {c.kind === 'file' ? '‹›' : <KindIcon kind={c.kind} />}
    </span>
  );
}

/** A message's blocks, split: its comments (each with the picture sent right after it) and everything else. */
export function splitComments(content: Message['content']): { comments: { c: ParsedComment; picture: ImageBlock | null; key: string }[]; rest: { block: Message['content'][number]; key: string }[] } {
  const comments: { c: ParsedComment; picture: ImageBlock | null; key: string }[] = [];
  const rest: { block: Message['content'][number]; key: string }[] = [];
  content.forEach((b, i) => {
    if (b.type === 'text') {
      const c = parseComment(b.text);
      if (c) return void comments.push({ c, picture: null, key: String(i) });
    }
    const prev = comments.at(-1);
    if (b.type === 'image' && prev && prev.key === String(i - 1) && !prev.picture) {
      prev.picture = b;
      return;
    }
    rest.push({ block: b, key: String(i) });
  });
  return { comments, rest };
}

/** A user message: its images, its text, then a card per comment (mockup « sent message »). */
export function UserContent({ message, cardId, text, onOpenRef }: { message: Message; cardId: string; text(t: string, key: string): ReactNode; onOpenRef?(r: MessageRef): void }) {
  const { comments, rest } = splitComments(message.content);
  const images = rest.flatMap((r) => (r.block.type === 'image' ? [r.block] : []));
  return (
    <>
      <ImageThumbs cardId={cardId} images={images} />
      {rest.map((r) => (r.block.type === 'text' ? text(r.block.text, r.key) : null))}
      {comments.length > 0 && <CommentCards cardId={cardId} comments={comments} onOpenRef={onOpenRef} />}
    </>
  );
}

export function CommentCards({ cardId, comments, onOpenRef }: { cardId: string; comments: { c: ParsedComment; picture: ImageBlock | null; key: string }[]; onOpenRef?(r: MessageRef): void }) {
  return (
    <div className="cm-sent">
      {comments.map(({ c, picture, key }) => {
        const open = onOpenRef && c.docId && c.version !== null ? () => onOpenRef({ docId: c.docId!, version: c.version!, section: c.section, label: c.label }) : undefined;
        const body = (
          <>
            <span className="cm-num">{c.n}</span>
            {picture && <img className="cm-thumb" src={imageUrl(cardId, picture.path)} alt="" loading="lazy" />}
            <span className="cm-sref-main">
              <span className="cm-sref-w">{c.selected && !c.quoted.length ? c.label.replace(/ · « [^]*$/, '') : c.label}</span>
              {!picture && c.quoted.length > 0 && <pre className="cm-sref-pre">{c.quoted.slice(0, 3).join('\n') + (c.quoted.length > 3 ? '\n…' : '')}</pre>}
              {!picture && !c.quoted.length && c.selected && <span className="cm-sref-q">{c.selected}</span>}
              <span className="cm-sref-c">{c.comment}</span>
            </span>
          </>
        );
        return open ? (
          <button key={key} type="button" className="cm-sref" title="Show it in the panel" onClick={open}>
            {body}
          </button>
        ) : (
          <div key={key} className="cm-sref">
            {body}
          </div>
        );
      })}
    </div>
  );
}
