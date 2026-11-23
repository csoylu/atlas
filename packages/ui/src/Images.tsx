// Attachments in chats and tasks: pictures (#103, #119) and any other file (#348). The composer's attachments (paste,
// drop, the paperclip), their thumbnails and file chips, and what a sent message shows.
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ATTACH_MAX, FILE_MAX_BYTES, fileInfo, IMAGE_MAX_BYTES, IMAGE_MAX_PER_MESSAGE, IMAGE_MAX_PER_TASK, IMAGE_TYPES, opensInTab, parseFileLine, sizeLabel, type ImageBlock, type TaskFile, type Upload } from '@atlas/shared';
import { createPortal } from 'react-dom';
import { api } from './api.ts';

export interface Attachment {
  key: string;
  name: string;
  /** Its size, from the file picked (bytes). */
  size: number;
  /** A picture (a thumbnail; the model sees it) or any other file (a chip). The engine's answer has the last word. */
  kind: 'image' | 'file';
  /** Local preview of a picture (object URL of the file). */
  preview?: string;
  upload?: Upload;
  error?: string;
  /** Bytes sent so far while it uploads. */
  loaded?: number;
  pending?: Promise<Upload | null>;
  /** Cancel the upload in flight (× on an uploading chip). */
  abort?(): void;
}

const MB = 1024 * 1024;
/** How many attachments fit, and in what (the refusal says it): a message, or a task (#119, #348). */
export interface Limit {
  max: number;
  maxImages: number;
  per: 'message' | 'task';
}
const MESSAGE: Limit = { max: ATTACH_MAX, maxImages: IMAGE_MAX_PER_MESSAGE, per: 'message' };
export const TASK: Limit = { max: ATTACH_MAX, maxImages: IMAGE_MAX_PER_TASK, per: 'task' };

/** A picture the model can see (png, jpeg, gif, webp up to 10 MB); anything else goes as a file. */
export const isPicture = (file: { type: string; size: number }) => (IMAGE_TYPES as readonly string[]).includes(file.type) && file.size <= IMAGE_MAX_BYTES;

/** Why a file can't be attached, or null. `count`: the attachments there already, and how many are pictures. */
export function refuse(file: { name: string; type: string; size: number }, count: { all: number; images: number }, limit: Limit = MESSAGE): string | null {
  const name = file.name || 'This file';
  if (count.all >= limit.max) return `${limit.max} attachments per ${limit.per} at most`;
  if (isPicture(file) && count.images >= limit.maxImages) return `${limit.maxImages} pictures per ${limit.per} at most`;
  if (file.size > FILE_MAX_BYTES) return `${name} is ${(file.size / MB).toFixed(1)} MB: files over ${FILE_MAX_BYTES / MB} MB are refused`;
  return null;
}

/**
 * The attachments of a composer: each one is uploaded (staged) as soon as it's added; the message sends their ids.
 * `cardId` null: no task yet (the New task dialog). `limit.taken`: what is there already (a task's), counted in.
 */
export function useAttachments(cardId: string | null, limit: Limit & { taken?: { all: number; images: number } } = MESSAGE) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(items);
  live.current = items;
  const revoke = (a: Attachment) => a.preview && URL.revokeObjectURL(a.preview);
  useEffect(() => () => live.current.forEach((a) => (a.abort?.(), revoke(a))), []);
  // Another chat: start empty.
  useEffect(() => {
    setItems((cur) => (cur.forEach((a) => (a.abort?.(), revoke(a))), []));
    setNotice(null);
  }, [cardId]);

  const takenAll = limit.taken?.all ?? 0;
  const takenImages = limit.taken?.images ?? 0;
  const add = useCallback(
    (files: File[]) => {
      const refused: string[] = [];
      const count = { all: live.current.length + takenAll, images: live.current.filter((a) => a.kind === 'image').length + takenImages };
      const added: Attachment[] = [];
      for (const f of files) {
        const why = refuse(f, count, limit);
        if (why) {
          refused.push(why);
          continue;
        }
        const kind = isPicture(f) ? 'image' : 'file';
        count.all++;
        if (kind === 'image') count.images++;
        const key = Math.random().toString(36).slice(2);
        const set = (patch: Partial<Attachment>) => setItems((cur) => cur.map((x) => (x.key === key ? { ...x, ...patch } : x)));
        const up = api.uploadFile(cardId, f, (loaded) => set({ loaded }));
        const a: Attachment = { key, name: f.name || (kind === 'image' ? 'image' : 'file'), size: f.size, kind, ...(kind === 'image' ? { preview: URL.createObjectURL(f) } : {}), loaded: 0, abort: up.abort };
        a.pending = up.done.then(
          (upload) => {
            set({ upload, kind: upload.kind, pending: undefined, abort: undefined });
            return upload;
          },
          (e: unknown) => {
            if (e instanceof DOMException && e.name === 'AbortError') return null; // removed by the user: nothing to say
            set({ error: e instanceof Error ? e.message : String(e), pending: undefined, abort: undefined });
            return null;
          },
        );
        added.push(a);
      }
      setNotice(refused.length ? [...new Set(refused)].join(' · ') : null);
      if (added.length) setItems((cur) => [...cur, ...added]);
    },
    [cardId, limit.max, limit.maxImages, limit.per, takenAll, takenImages],
  );
  /** Out of the list; an upload in flight is cancelled, a staged file deleted (`keep`: it was sent, the engine has it). */
  const drop = (keys: string[], keep = false) => {
    const gone = live.current.filter((a) => keys.includes(a.key));
    for (const a of gone) {
      revoke(a);
      if (keep) continue;
      a.abort?.();
      void (a.upload ? Promise.resolve(a.upload) : (a.pending ?? Promise.resolve(null))).then((u) => u && api.discardUpload(u.id).catch(() => undefined));
    }
    setItems((cur) => cur.filter((a) => !keys.includes(a.key)));
  };
  const remove = (key: string) => drop([key]);
  /** Drop every staged file (a dialog cancelled): nothing stays behind. */
  const discardAll = () => {
    drop(live.current.map((a) => a.key));
    setNotice(null);
  };
  /** The ids of the uploads that made it (call when sending, once none is in flight). */
  const take = async (): Promise<string[]> => {
    const done = await Promise.all(live.current.map((a) => (a.upload ? a.upload : (a.pending ?? null))));
    return done.flatMap((u) => (u ? [u.id] : []));
  };
  /** Empty the list for a send; the previews stay valid until `release` (sent) or `restore` (the send failed). */
  const clear = () => {
    setItems([]);
    setNotice(null);
  };
  const release = (sent: Attachment[]) => sent.forEach(revoke);
  /** Put the list back after a failed send (the staged uploads stay valid). */
  const restore = (back: Attachment[]) => setItems(back);
  const ok = items.filter((a) => !a.error);
  return { items, notice, setNotice, add, remove, drop, discardAll, take, clear, release, restore, sendable: ok.length > 0, uploading: items.some((a) => a.pending), failed: items.some((a) => a.error) };
}

/** What Send (or Create task) says while it waits, and the refusal when an upload failed. */
export const WAITING = 'Waiting for the uploads';
export const FAILED = 'Remove the files that failed (marked !) before sending';

/** The files of a paste, a drop or a picker. */
export const fileList = (list: FileList | DataTransferItemList | null | undefined): File[] => {
  if (!list) return [];
  const out: File[] = [];
  for (const x of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const f = 'getAsFile' in x ? (x.kind === 'file' ? x.getAsFile() : null) : x;
    if (f) out.push(f);
  }
  return out;
};

/**
 * The files of a paste, or none if it's text: a copy from a document can carry a picture of the text too, and pasting
 * text must stay pasting text. A screenshot pastes as a file only; a file copied in the Finder (not a picture) is taken
 * even with its name as text.
 */
export function pastedFiles(data: DataTransfer): File[] {
  const files = fileList(data.items);
  if (!data.getData('text/plain').trim()) return files;
  return files.some((f) => !(IMAGE_TYPES as readonly string[]).includes(f.type)) ? files : [];
}

/** Drag and drop of files onto an area: `dragging` for its dashed outline, `props` to spread on it. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  return {
    dragging,
    props: {
      onDragOver: (e: DragEvent) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        e.stopPropagation(); // not the board's own drop target (a card being moved)
        setDragging(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: (e: DragEvent) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        onFiles(fileList(e.dataTransfer.files));
      },
    },
  };
}

/** The line in a dragged-over composer: what a drop does. */
export const DROP_HINT = `Drop files to attach them · up to ${FILE_MAX_BYTES / MB} MB each`;
export const NO_AGENT = 'Assign an agent first: files go into its workspace';

/** A file's name as the user gave it, from its place (uploads/2026-11-23-x.csv, task-12-2026-11-23-x.csv → x.csv). */
export const shownName = (path: string) => baseName(path).replace(/^(task-\d+-)?\d{4}-\d{2}-\d{2}-/, '');

function FileMark({ name }: { name: string }) {
  const mark = fileInfo(name).mark;
  return (
    <span className="file-mark" aria-hidden="true">
      {mark ?? (
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 2.5h6l3 3v8h-9z M9.5 2.5v3h3" />
        </svg>
      )}
    </span>
  );
}

/** The note under the attachments: refusals, and why an upload failed. */
const noteOf = (a: ReturnType<typeof useAttachments>) => [a.notice, ...a.items.flatMap((x) => (x.error ? [x.error.startsWith(x.name) ? x.error : `${x.name}: ${x.error}`] : []))].filter(Boolean).join(' · ');

/** One attachment of a composer: a picture's thumbnail, or a file's chip (uploading: a bar and « 18.4 of 84.0 MB »). */
function Pending({ x, onRemove, xClass }: { x: Attachment; onRemove(): void; xClass?: string }) {
  if (x.kind === 'image' && x.preview)
    return (
      <div className={'attach-thumb' + (x.error ? ' bad' : '') + (x.pending ? ' busy' : '')} title={x.error ?? x.name}>
        <img src={x.preview} alt={x.name} />
        {x.error && <span className="attach-err">!</span>}
        <button type="button" className={xClass} aria-label={`Remove ${x.name}`} onClick={onRemove}>
          ×
        </button>
      </div>
    );
  const sub = x.error ? 'Upload failed' : x.pending ? `${((x.loaded ?? 0) / MB).toFixed(1)} of ${(x.size / MB).toFixed(1)} MB` : sizeLabel(x.size);
  return (
    <div className={'file-chip' + (x.error ? ' bad' : '') + (x.pending ? ' busy' : '')} title={x.error ?? x.name}>
      <FileMark name={x.name} />
      <span className="file-txt">
        <span className="file-name">{x.name}</span>
        <span className="file-sub">{sub}</span>
      </span>
      {x.pending && (
        <span className="file-bar" role="progressbar" aria-label={`Uploading ${x.name}`} aria-valuemin={0} aria-valuemax={x.size} aria-valuenow={x.loaded ?? 0}>
          <i style={{ width: `${x.size ? Math.min(100, ((x.loaded ?? 0) / x.size) * 100) : 0}%` }} />
        </span>
      )}
      {x.error && <span className="attach-err">!</span>}
      <button type="button" className="file-x" aria-label={`${x.pending ? 'Cancel' : 'Remove'} ${x.name}`} onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

/** Open a file of a task (or a task thread's message) in a browser tab, or download what a browser can't show. */
export const openTaskFile = (cardId: string, path: string) => window.open(taskFileUrl(cardId, path), '_blank', 'noopener');
export const taskFileUrl = (cardId: string, path: string) => `/api/cards/${encodeURIComponent(cardId)}/file?path=${encodeURIComponent(path)}`;
const clickWhat = (name: string) => (opensInTab(name) ? 'open in a tab' : 'download');

/**
 * A task's own attachments (#119, #348), under its description: the saved pictures (click = full size) and files
 * (click = a browser tab or a download), × removes one from the task; the ones uploading, the refusals, and the
 * paperclip. Paste and drop are handled by the area around it.
 */
export function TaskImages({ cardId, images, files = [], att, onAdd, onRemove }: { cardId: string | null; images: ImageBlock[]; files?: TaskFile[]; att: ReturnType<typeof useAttachments>; onAdd(files: File[]): void; onRemove?(item: { path: string }): void }) {
  const [open, setOpen] = useState<ImageBlock | null>(null);
  const count = images.length + files.length + att.items.length;
  const note = noteOf(att);
  return (
    <div className="task-images">
      {cardId &&
        images.map((im) => (
          <div key={im.path} className="attach-thumb saved" title={`${baseName(im.path)} · ${im.width}×${im.height} px`}>
            <button type="button" className="attach-open" aria-label={`Open ${baseName(im.path)} full size`} onClick={() => setOpen(im)}>
              <img src={imageUrl(cardId, im.path)} alt={baseName(im.path)} loading="lazy" />
            </button>
            {onRemove && (
              <button type="button" className="attach-x" aria-label={`Remove ${baseName(im.path)}`} onClick={() => onRemove(im)}>
                ×
              </button>
            )}
          </div>
        ))}
      {cardId &&
        files.map((f) => {
          const name = shownName(f.path);
          return (
            <div
              key={f.path}
              className="file-chip saved"
              role="button"
              tabIndex={0}
              title={`${baseName(f.path)} · ${sizeLabel(f.bytes)} · ${clickWhat(name)}`}
              onClick={() => openTaskFile(cardId, f.path)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openTaskFile(cardId, f.path))}
            >
              <FileMark name={name} />
              <span className="file-txt">
                <span className="file-name">{name}</span>
                <span className="file-sub">{sizeLabel(f.bytes)}</span>
              </span>
              {onRemove && (
                <button
                  type="button"
                  className="file-x"
                  aria-label={`Remove ${name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(f);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      {att.items.map((x) => (
        <Pending key={x.key} x={x} xClass="attach-x" onRemove={() => att.remove(x.key)} />
      ))}
      <AttachButton onFiles={onAdd} label={count ? undefined : 'Add files'} />
      {note && (
        <span className="state-err inline attach-note" role="alert">
          {note}
        </span>
      )}
      {open && cardId && <Lightbox src={imageUrl(cardId, open.path)} caption={`${baseName(open.path)} · ${open.width}×${open.height} px`} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Thumbnails and file chips above the composer's text, each with a remove ×; an upload error shows on it. */
export function AttachmentStrip({ a }: { a: ReturnType<typeof useAttachments> }) {
  if (!a.items.length && !a.notice) return null;
  const note = noteOf(a);
  return (
    <div className="attach-strip">
      {a.items.map((x) => (
        <Pending key={x.key} x={x} onRemove={() => a.remove(x.key)} />
      ))}
      {note && (
        <span className="state-err inline attach-note" role="alert">
          {note}
        </span>
      )}
    </div>
  );
}

/** The paperclip: a file picker for any file (on a phone, the files or photo picker). */
export function AttachButton({ onFiles, disabled, label }: { onFiles(files: File[]): void; disabled?: boolean; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={'attach-btn' + (label ? ' labelled' : '')} aria-label="Attach files" title="Attach files (or paste / drop them)" disabled={disabled} onClick={() => input.current?.click()}>
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13.2 7.6 8.4 12.4a3.1 3.1 0 0 1-4.4-4.4l5-5a2.1 2.1 0 0 1 3 3l-5 5a1.05 1.05 0 0 1-1.5-1.5l4.6-4.6" />
        </svg>
        {label && <span>{label}</span>}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFiles(fileList(e.target.files));
          e.target.value = '';
        }}
      />
    </>
  );
}

export const imageUrl = (cardId: string, path: string) => `/api/cards/${encodeURIComponent(cardId)}/image?path=${encodeURIComponent(path)}`;
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

/**
 * The files of a sent message (#348): a chip each (no ×; size · kind). `onOpen`: what a click does (a chat: the side
 * panel's Files tab; a task thread: a browser tab or a download); `opens`: the tooltip's end, from the file's name.
 */
export function FileChips({ files, onOpen, opens }: { files: { path: string; size: string; label: string }[]; onOpen(path: string): void; opens(name: string): string }) {
  if (!files.length) return null;
  return (
    <div className="msg-files">
      {files.map((f, i) => {
        const name = shownName(f.path);
        return (
          <button key={f.path + i} type="button" className="file-chip sent" title={`${f.path} · ${f.size} · ${opens(name)}`} onClick={() => onOpen(f.path)}>
            <FileMark name={name} />
            <span className="file-txt">
              <span className="file-name">{name}</span>
              <span className="file-sub">
                {f.size} · {f.label}
              </span>
            </span>
          </button>
        );
      })}
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

/** The lines the engine adds for the agent (`[attached: …]`, `[file attached: …]`): not shown as text (a chip is). */
export const isAttachedLine = (t: string) => /^\[attached: [^\]\n]+\]$/.test(t) || parseFileLine(t) !== null;
