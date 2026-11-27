// Comments (#304) in the chat: the numbered chips waiting in the composer, and a sent message's cards (a thumbnail or
// the quoted lines, then the words). What the agent got (path, version, anchor) stays in the text block; the cards show
// the human part, and a click opens the place in the pane.
import { Icon } from './ScreenHeader.tsx';
import type { ReactNode } from 'react';
import { parseComment, parseFileLine, parseQuote, type ImageBlock, type Message, type ParsedComment, type ParsedQuote } from '@atlas/shared';
import { FileChips, ImageThumbs, imageUrl } from './Images.tsx';
import { KindIcon } from './Viewer.tsx';
import { boxOf, isQuote, type Box, type ChipDraft, type CommentDraft } from './comments.ts';
import { QuoteIcon } from './QuoteLayer.tsx';
import { codeLines, oneLine } from './quoteMarks.ts';
import type { MessageRef } from './CardPanel.tsx';

export function CommentChips({ list, label, onRemove, onPickQuote }: { list: ChipDraft[]; label(c: CommentDraft): string; onRemove(id: string): void; onPickQuote?(id: string, rect: Box): void }) {
  return (
    <div className="cm-chips" aria-label="Comments and quotes to send">
      {list.map((c) =>
        isQuote(c) ? (
          <div
            key={c.id}
            className="cm-chip qt-chip"
            title={c.quote.passage}
            role="button"
            tabIndex={0}
            aria-label={`Quote ${c.n}: edit its note`}
            onClick={(e) => onPickQuote?.(c.id, boxOf(e.currentTarget.getBoundingClientRect()))}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
              e.preventDefault();
              onPickQuote?.(c.id, boxOf(e.currentTarget.getBoundingClientRect()));
            }}
          >
            <span className="cm-num">{c.n}</span>
            <span className="cm-kind qt-kind" aria-hidden="true">
              <QuoteIcon />
            </span>
            <span className="cm-chip-t">
              {c.text}
              <i className={c.quote.code ? 'qt-code' : undefined}>
                {c.text ? ' · ' : ''}
                {c.quote.who} « {oneLine(c.quote.passage)} »
              </i>
            </span>
            <button
              type="button"
              aria-label={`Remove quote ${c.n}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(c.id);
              }}
            >
              ×
            </button>
          </div>
        ) : (
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
        ),
      )}
    </div>
  );
}

function ChipThumb({ c }: { c: CommentDraft }) {
  if (c.thumb) return <img className="cm-thumb" src={c.thumb} alt="" />;
  const lines = c.anchor.type === 'lines' ? [c.anchor.from, c.anchor.to] : c.anchor.type === 'text' ? c.anchor.lines : null;
  if (lines) return <span className="cm-lines">L{lines[0] === lines[1] ? lines[0] : `${lines[0]}–${lines[1]}`}</span>;
  return (
    <span className="cm-kind" aria-hidden="true">
      {c.kind === 'file' ? '‹›' : c.kind === 'browser' ? <Icon.globe /> : <KindIcon kind={c.kind} />}
    </span>
  );
}

type SentComment = { c: ParsedComment; picture: ImageBlock | null; key: string };
type SentQuote = { q: ParsedQuote; key: string };

/** A message's blocks, split: its comments (each with the picture sent right after it), its quotes (#367), the rest. */
export function splitComments(content: Message['content']): { comments: SentComment[]; quotes: SentQuote[]; rest: { block: Message['content'][number]; key: string }[] } {
  const comments: SentComment[] = [];
  const quotes: SentQuote[] = [];
  const rest: { block: Message['content'][number]; key: string }[] = [];
  content.forEach((b, i) => {
    if (b.type === 'text') {
      const c = parseComment(b.text);
      if (c) return void comments.push({ c, picture: null, key: String(i) });
      const q = parseQuote(b.text);
      if (q) return void quotes.push({ q, key: String(i) });
    }
    const prev = comments.at(-1);
    if (b.type === 'image' && prev && prev.key === String(i - 1) && !prev.picture) {
      prev.picture = b;
      return;
    }
    rest.push({ block: b, key: String(i) });
  });
  return { comments, quotes, rest };
}

/** Jumps from a sent quote card to its passage (#367); `has` says whether the message is still in the chat. */
export interface QuoteJump {
  has(seq: number): boolean;
  jump(q: ParsedQuote): void;
}

/** A user message: its pictures, its files (#348), a card per comment and quote in number order, then its text. */
export function UserContent({ message, cardId, text, onOpenRef, onOpenFile, opens, quoteJump }: { message: Message; cardId: string; text(t: string, key: string): ReactNode; onOpenRef?(r: MessageRef): void; onOpenFile?(path: string): void; opens?(name: string): string; quoteJump?: QuoteJump }) {
  const { comments, quotes, rest } = splitComments(message.content);
  const images = rest.flatMap((r) => (r.block.type === 'image' ? [r.block] : []));
  const files = rest.flatMap((r) => (r.block.type === 'text' ? [parseFileLine(r.block.text)].filter((f) => f !== null) : []));
  return (
    <>
      <ImageThumbs cardId={cardId} images={images} />
      {onOpenFile && <FileChips files={files} onOpen={onOpenFile} opens={opens ?? (() => 'open')} />}
      {comments.length + quotes.length > 0 && <CommentCards cardId={cardId} comments={comments} quotes={quotes} onOpenRef={onOpenRef} quoteJump={quoteJump} />}
      {rest.map((r) => (r.block.type === 'text' ? text(r.block.text, r.key) : null))}
    </>
  );
}

export function CommentCards({ cardId, comments, quotes = [], onOpenRef, quoteJump }: { cardId: string; comments: SentComment[]; quotes?: SentQuote[]; onOpenRef?(r: MessageRef): void; quoteJump?: QuoteJump }) {
  const cards: ({ n: number; key: string } & ({ comment: SentComment } | { quote: SentQuote }))[] = [
    ...comments.map((c) => ({ n: c.c.n, key: c.key, comment: c })),
    ...quotes.map((q) => ({ n: q.q.n, key: q.key, quote: q })),
  ].sort((a, b) => a.n - b.n);
  return (
    <div className="cm-sent qt-sent">
      {cards.map((card) => {
        if ('quote' in card) return <QuoteCard key={card.key} q={card.quote.q} jump={quoteJump} />;
        const { c, picture, key } = card.comment;
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

/** A sent quote: number, who · when, up to 3 lines of the passage (or a code box), the note. A click jumps back. */
function QuoteCard({ q, jump }: { q: ParsedQuote; jump?: QuoteJump }) {
  const here = !!jump?.has(q.seq);
  const body = (
    <>
      <span className="cm-num">{q.n}</span>
      <span className="cm-sref-main">
        <span className="cm-sref-w">{`${q.who} · ${q.when}`}</span>
        {q.code ? <pre className="cm-sref-pre">{codeLines(q.passage)}</pre> : <span className="cm-sref-q">{q.passage}</span>}
        {q.note && <span className="cm-sref-c">{q.note}</span>}
      </span>
    </>
  );
  return here ? (
    <button type="button" className="cm-sref qt-card" title="Show it in the chat" onClick={() => jump!.jump(q)}>
      {body}
    </button>
  ) : (
    <div className="cm-sref qt-card" title="No longer in this chat">
      {body}
    </div>
  );
}
