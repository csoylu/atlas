// Files the user pastes, drops or picks in a composer (#103 pictures, #348 any file). Two steps, both durable on disk:
// 1. POST /api/cards/:id/uploads: the bytes are streamed to <data>/uploads/ (100 MB at most) and kept there, named
//    `up_<uuid>--<name>[.<ext>]` (the file is its own record: no table, no JSON state). A png/jpeg/gif/webp up to 10 MB,
//    by its bytes, is a picture (the model sees it); anything else is a file (the agent gets its path).
// 2. POST /api/cards/:id/messages with `uploads: [ids]`: each file is copied into the agent's workspace
//    (uploads/<date>-<name>.<ext>), then the message row (its image blocks, a line per file) is written in its
//    transaction, then the staged file is removed. A crash before the row leaves the staged file (send again works; the
//    copy is a harmless extra file); after it, only a staged leftover, pruned after a day. A failed row write removes the copies.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ATTACH_MAX, FILE_MAX_BYTES, fileInfo, IMAGE_MAX_BYTES, IMAGE_MAX_PER_MESSAGE, type ImageBlock, type TaskFile, type Upload } from '@atlas/shared';
import { describeImage, extOf, sniff } from './images.ts';
import { InvalidError, NotFoundError } from './kanban.ts';

const STAGING_DAYS = 1;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
/** « 100 MB », as the composer says it. */
const LIMIT = `${FILE_MAX_BYTES / 1024 / 1024} MB`;

/** A file name safe on every OS, without its extension: letters, digits, - and _, at most 60 chars. */
export function safeName(name: string, fallback = 'file'): string {
  const base = (name.split(/[/\\]/).pop() ?? '').replace(/\.[^.]*$/, '').normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return base.slice(0, 60) || fallback;
}
/** A file name's extension, safe: lower-case letters and digits, at most 10; '' when it has none. */
export function safeExt(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/** What a staged or placed file is: a picture the model can see, or any other file. */
type Kind = { kind: 'image'; block: ImageBlock } | { kind: 'file'; mediaType: string };
async function classify(path: string, name: string): Promise<Kind> {
  const size = statSync(path).size;
  const head = Buffer.alloc(16);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, head, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  if (size > 0 && size <= IMAGE_MAX_BYTES && sniff(head.subarray(0, Math.min(16, size)))) {
    try {
      return { kind: 'image', block: await describeImage(path, readFileSync(path)) };
    } catch (e) {
      // The image library is missing: say so (rule 3). Not decodable as the picture its first bytes say: a file.
      if (e instanceof Error && /images are unavailable/.test(e.message)) throw new InvalidError(e.message);
    }
  }
  return { kind: 'file', mediaType: fileInfo(name).mediaType };
}

class TooBig extends Error {}

/** What a placed message or task gets: its pictures (image blocks) and its other files, in the order given. */
export interface Placed {
  images: ImageBlock[];
  files: TaskFile[];
}
/** Pictures and attachments at most; `taken`: what the task has already. */
export interface PlaceLimit {
  maxImages: number;
  max: number;
  per: 'message' | 'task';
  taken?: { images: number; all: number };
}
export const MESSAGE_LIMIT: PlaceLimit = { maxImages: IMAGE_MAX_PER_MESSAGE, max: ATTACH_MAX, per: 'message' };

export class Uploads {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'uploads');
  }

  /**
   * Keep a pasted/dropped/picked file until its message is sent. Streamed to a `.part` file (never a half-written
   * upload under its real name), refused past FILE_MAX_BYTES. `declared`: the request's length, refused before reading.
   */
  async stage(name: string, body: Buffer | Readable, declared?: number): Promise<Upload> {
    const label = name || 'This file';
    if (declared !== undefined && declared > FILE_MAX_BYTES) throw new InvalidError(`${label} is ${mb(declared)}: files over ${LIMIT} are refused`);
    const id = 'up_' + randomUUID();
    mkdirSync(this.dir, { recursive: true });
    const part = join(this.dir, `${id}.part`);
    let n = 0;
    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        n += chunk.length;
        if (n > FILE_MAX_BYTES) done(new TooBig());
        else done(null, chunk);
      },
    });
    try {
      await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : body, count, createWriteStream(part, { flags: 'wx' }));
    } catch (e) {
      rmSync(part, { force: true });
      if (e instanceof TooBig) throw new InvalidError(`${label} is over ${LIMIT}: files over ${LIMIT} are refused`);
      throw e;
    }
    let what: Kind;
    try {
      what = await classify(part, name);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
    const ext = what.kind === 'image' ? extOf(what.block.media_type) : safeExt(name);
    const file = join(this.dir, `${id}--${safeName(name, what.kind === 'image' ? 'image' : 'file')}${ext ? '.' + ext : ''}`);
    renameSync(part, file);
    if (what.kind === 'image') {
      const b = what.block;
      return { id, name, kind: 'image', media_type: b.media_type, width: b.width, height: b.height, bytes: b.bytes };
    }
    return { id, name, kind: 'file', media_type: what.mediaType, bytes: n };
  }

  /** The staged file of an upload id. */
  private staged(id: string): string {
    if (!/^up_[a-z0-9-]+$/.test(id)) throw new InvalidError(`not an upload id: ${id}`);
    const f = existsSync(this.dir) ? readdirSync(this.dir).find((n) => n.startsWith(id + '--') && !n.endsWith('.part')) : undefined;
    if (!f) throw new NotFoundError(`upload ${id} not found (sent already, or older than ${STAGING_DAYS} day): attach the file again`);
    return join(this.dir, f);
  }

  /**
   * Copy uploads into `workdir`/uploads/ and give their blocks to `write` (which writes the message row), then drop the
   * staged files. If `write` throws, the copies are removed and the uploads stay staged, so sending again works.
   */
  send<T>(ids: string[], workdir: string, write: (placed: Placed) => T, now = new Date()): Promise<T> {
    return this.place(ids, join(workdir, 'uploads'), write, MESSAGE_LIMIT, now);
  }

  /** The same steps into any folder (`dest`/<date>-<name>.<ext>): a message's workspace, or a task's files (#119). */
  async place<T>(ids: string[], dest: string, write: (placed: Placed) => T, limit: PlaceLimit, now = new Date()): Promise<T> {
    if (!ids.length) return write({ images: [], files: [] });
    if (new Set(ids).size !== ids.length) throw new InvalidError('the same upload is named twice');
    const from = ids.map((id) => this.staged(id));
    const names = from.map((f) => basename(f).replace(/^up_[a-z0-9-]+--/, ''));
    const kinds = await Promise.all(from.map((f, i) => classify(f, names[i]!)));
    const taken = limit.taken ?? { images: 0, all: 0 };
    const pictures = kinds.filter((k) => k.kind === 'image').length;
    if (taken.all + ids.length > limit.max) throw new InvalidError(`${limit.max} attachments per ${limit.per} at most${taken.all ? ` (it has ${taken.all})` : ''}`);
    if (taken.images + pictures > limit.maxImages) throw new InvalidError(`${limit.maxImages} pictures per ${limit.per} at most${taken.images ? ` (it has ${taken.images})` : ''}`);
    mkdirSync(dest, { recursive: true });
    const date = now.toISOString().slice(0, 10);
    const copied: string[] = [];
    let result: T;
    try {
      const placed: Placed = { images: [], files: [] };
      for (const [i, f] of from.entries()) {
        const name = names[i]!;
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 ? name.slice(dot) : '';
        const stem = `${date}-${name.slice(0, name.length - ext.length)}`;
        let to = join(dest, stem + ext);
        for (let k = 2; existsSync(to); k++) to = join(dest, `${stem}-${k}${ext}`);
        copyFileSync(f, to, constants.COPYFILE_EXCL);
        copied.push(to);
        const kind = kinds[i]!;
        if (kind.kind === 'image') placed.images.push(await describeImage(to, readFileSync(to)));
        else placed.files.push({ path: to, bytes: statSync(to).size, media_type: kind.mediaType });
      }
      result = write(placed);
    } catch (e) {
      for (const to of copied) rmSync(to, { force: true });
      throw e;
    }
    for (const f of from) rmSync(f, { force: true });
    return result;
  }

  /** A staged file the user removed before sending (×, or the New task dialog cancelled): it goes now. */
  discard(id: string): void {
    try {
      rmSync(this.staged(id), { force: true });
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e; // gone already: nothing to do
    }
  }

  /** Staged files (and cut-off `.part` files) older than a day: nobody sent them. Called at start. */
  prune(now = Date.now()): number {
    if (!existsSync(this.dir)) return 0;
    let n = 0;
    for (const f of readdirSync(this.dir)) {
      const p = join(this.dir, f);
      if (now - statSync(p).mtimeMs > STAGING_DAYS * 86_400_000) {
        unlinkSync(p);
        n++;
      }
    }
    return n;
  }
}
