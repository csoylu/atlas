// Images in chats (#103): the composer's attachments (paste, drop, attach button) and the thumbnails in a transcript.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { IMAGE_MAX_BYTES, IMAGE_MAX_PER_MESSAGE, IMAGE_TYPES, type ImageBlock, type Upload } from '@atlas/shared';
import { createPortal } from 'react-dom';
import { api } from './api.ts';

export interface Attachment {
  key: string;
  name: string;
  /** Local preview (object URL of the file). */
  preview: string;
  upload?: Upload;
  error?: string;
  pending?: Promise<Upload | null>;
}

const MB = 1024 * 1024;
/** Why a file can't be attached, or null. Checked again by the engine (on the bytes). */
export function refuse(file: { name: string; type: string; size: number }, count: number): string | null {
  const name = file.name || 'This image';
  if (count >= IMAGE_MAX_PER_MESSAGE) return `${IMAGE_MAX_PER_MESSAGE} images per message at most`;
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return `${name}: only png, jpeg, gif or webp images`;
  if (file.size > IMAGE_MAX_BYTES) return `${name} is ${(file.size / MB).toFixed(1)} MB: images over ${IMAGE_MAX_BYTES / MB} MB are refused`;
  return null;
}

/** The images of a composer: each one is uploaded (staged) as soon as it's added; the message sends their ids. */
export function useAttachments(cardId: string) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(items);
  live.current = items;
  useEffect(() => () => live.current.forEach((a) => URL.revokeObjectURL(a.preview)), []);
  // Another chat: start empty.
  useEffect(() => {
    setItems((cur) => (cur.forEach((a) => URL.revokeObjectURL(a.preview)), []));
    setNotice(null);
  }, [cardId]);

  const add = useCallback(
    (files: File[]) => {
      const refused: string[] = [];
      let count = live.current.length;
      const added: Attachment[] = [];
      for (const f of files) {
        const why = refuse(f, count);
        if (why) {
          refused.push(why);
          continue;
        }
        count++;
        const key = Math.random().toString(36).slice(2);
        const a: Attachment = { key, name: f.name || 'image', preview: URL.createObjectURL(f) };
        a.pending = api.uploadImage(cardId, f).then(
          (upload) => {
            setItems((cur) => cur.map((x) => (x.key === key ? { ...x, upload, pending: undefined } : x)));
            return upload;
          },
          (e: unknown) => {
            setItems((cur) => cur.map((x) => (x.key === key ? { ...x, error: e instanceof Error ? e.message : String(e), pending: undefined } : x)));
            return null;
          },
        );
        added.push(a);
      }
      setNotice(refused.length ? [...new Set(refused)].join(' · ') : null);
      if (added.length) setItems((cur) => [...cur, ...added]);
    },
    [cardId],
  );
  const remove = (key: string) =>
    setItems((cur) =>
      cur.filter((a) => {
        if (a.key === key) URL.revokeObjectURL(a.preview);
        return a.key !== key;
      }),
    );
  /** Wait for uploads in flight; the ids of those that made it. Clears the list (call when sending). */
  const take = async (): Promise<string[]> => {
    const now = live.current;
    const done = await Promise.all(now.map((a) => (a.upload ? a.upload : a.pending ?? null)));
    return done.flatMap((u) => (u ? [u.id] : []));
  };
  const clear = () => {
    live.current.forEach((a) => URL.revokeObjectURL(a.preview));
    setItems([]);
    setNotice(null);
  };
  /** Put the list back after a failed send (the staged uploads stay valid). */
  const restore = (back: Attachment[]) => setItems(back.map((a) => ({ ...a, preview: a.upload ? a.preview : a.preview })));
  const ok = items.filter((a) => !a.error);
  return { items, notice, setNotice, add, remove, take, clear, restore, sendable: ok.length > 0, uploading: items.some((a) => a.pending) };
}

/** Image files of a paste or drop (screenshots paste as a file named image.png). */
export const imageFiles = (list: FileList | DataTransferItemList | null | undefined): File[] => {
  if (!list) return [];
  const out: File[] = [];
  for (const x of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const f = 'getAsFile' in x ? (x.kind === 'file' ? x.getAsFile() : null) : x;
    if (f) out.push(f);
  }
  return out;
};

/** Thumbnails above the composer's text, each with a remove ×; an upload error shows on its thumbnail. */
export function AttachmentStrip({ a }: { a: ReturnType<typeof useAttachments> }) {
  if (!a.items.length && !a.notice) return null;
  return (
    <div className="attach-strip">
      {a.items.map((x) => (
        <div key={x.key} className={'attach-thumb' + (x.error ? ' bad' : '') + (x.pending ? ' busy' : '')} title={x.error ?? x.name}>
          <img src={x.preview} alt={x.name} />
          {x.error && <span className="attach-err">!</span>}
          <button type="button" aria-label={`Remove ${x.name}`} onClick={() => a.remove(x.key)}>
            ×
          </button>
        </div>
      ))}
      {(a.notice || a.items.some((x) => x.error)) && (
        <span className="attach-note" role="alert">
          {[a.notice, ...a.items.flatMap((x) => (x.error ? [x.error] : []))].filter(Boolean).join(' · ')}
        </span>
      )}
    </div>
  );
}

/** The attach button: a file picker for images (on a phone, the photo picker). */
export function AttachButton({ onFiles, disabled }: { onFiles(files: File[]): void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="attach-btn" aria-label="Attach images" title="Attach images (or paste / drop them)" disabled={disabled} onClick={() => input.current?.click()}>
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <circle cx="6" cy="6.5" r="1.2" />
          <path d="M14 11l-3.5-3.5L4 13" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        accept={IMAGE_TYPES.join(',')}
        multiple
        hidden
        onChange={(e) => {
          onFiles(imageFiles(e.target.files));
          e.target.value = '';
        }}
      />
    </>
  );
}

const imageUrl = (cardId: string, path: string) => `/api/cards/${encodeURIComponent(cardId)}/image?path=${encodeURIComponent(path)}`;
const baseName = (p: string) => p.split('/').pop() ?? p;

/** Pictures in a message: thumbnails; a click opens the picture full size. */
export function ImageThumbs({ cardId, images }: { cardId: string; images: ImageBlock[] }) {
  const [open, setOpen] = useState<ImageBlock | null>(null);
  if (!images.length) return null;
  return (
    <div className="msg-images">
      {images.map((im, i) => (
        <button key={im.path + i} type="button" className="msg-image" title={`${baseName(im.path)} · ${im.width}×${im.height} px · open full size`} onClick={() => setOpen(im)}>
          <img src={imageUrl(cardId, im.path)} alt={baseName(im.path)} loading="lazy" width={im.width} height={im.height} />
        </button>
      ))}
      {open && <Lightbox src={imageUrl(cardId, open.path)} caption={`${baseName(open.path)} · ${open.width}×${open.height} px`} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Lightbox({ src, caption, onClose }: { src: string; caption: ReactNode; onClose(): void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return createPortal(
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Image"
      onClick={(e) => {
        e.stopPropagation(); // a portal: React would still bubble the click to the chat row around the thumbnail
        onClose();
      }}
    >
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>{caption}</span>
        <a href={src} target="_blank" rel="noreferrer">
          Open in a tab
        </a>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** The `[attached: uploads/…]` line the engine adds for the agent; not shown to the user (the thumbnail is). */
export const isAttachedLine = (t: string) => /^\[attached: [^\]\n]+\]$/.test(t);
