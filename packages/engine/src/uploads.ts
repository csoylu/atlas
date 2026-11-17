// Images the user pastes or drops into a composer (#103). Two steps, both durable on disk:
// 1. POST /api/cards/:id/uploads: the bytes are checked (type from the bytes, 10 MB) and kept in <data>/uploads/,
//    named `up_<uuid>--<name>.<ext>` (the file is its own record: no table, no JSON state).
// 2. POST /api/cards/:id/messages with `uploads: [ids]`: each file is copied into the agent's workspace
//    (uploads/<date>-<name>.<ext>), then the message row (with its image blocks) is written in its transaction, then
//    the staged file is removed. A crash before the row leaves the staged file (send again works; the copy is a
//    harmless extra file); after it, only a staged leftover, pruned after a day. A failed row write removes the copies.
import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_MAX_BYTES, type ImageBlock, type Upload } from '@atlas/shared';
import { describeImage, extOf, sniff } from './images.ts';
import { InvalidError, NotFoundError } from './kanban.ts';

const STAGING_DAYS = 1;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A file name safe on every OS, without its extension: letters, digits, - and _, at most 60 chars. */
export function safeName(name: string): string {
  const base = (name.split(/[/\\]/).pop() ?? '').replace(/\.[^.]*$/, '').normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return base.slice(0, 60) || 'image';
}

export class Uploads {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'uploads');
  }

  /** Keep a pasted/dropped picture until its message is sent. Refuses anything not png/jpeg/gif/webp or over 10 MB. */
  async stage(name: string, buf: Buffer): Promise<Upload> {
    if (buf.length === 0) throw new InvalidError('the file is empty');
    if (buf.length > IMAGE_MAX_BYTES) throw new InvalidError(`${name} is ${mb(buf.length)}: images over ${mb(IMAGE_MAX_BYTES)} are refused`);
    const type = sniff(buf);
    if (!type) throw new InvalidError(`${name} is not a png, jpeg, gif or webp image`);
    const id = 'up_' + randomUUID();
    const file = join(this.dir, `${id}--${safeName(name)}.${extOf(type)}`);
    let info: ImageBlock;
    try {
      info = await describeImage(file, buf);
    } catch (e) {
      throw new InvalidError(e instanceof Error ? e.message : String(e));
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(file + '.part', buf);
    renameSync(file + '.part', file); // never a half-written upload under its real name
    return { id, name, media_type: info.media_type, width: info.width, height: info.height, bytes: info.bytes };
  }

  /** The staged file of an upload id. */
  private staged(id: string): string {
    if (!/^up_[a-z0-9-]+$/.test(id)) throw new InvalidError(`not an upload id: ${id}`);
    const f = existsSync(this.dir) ? readdirSync(this.dir).find((n) => n.startsWith(id + '--') && !n.endsWith('.part')) : undefined;
    if (!f) throw new NotFoundError(`upload ${id} not found (sent already, or older than ${STAGING_DAYS} day): attach the image again`);
    return join(this.dir, f);
  }

  /**
   * Copy uploads into `workdir`/uploads/ and give their image blocks to `write` (which writes the message row), then
   * drop the staged files. If `write` throws, the copies are removed and the uploads stay staged, so sending again works.
   */
  async send<T>(ids: string[], workdir: string, write: (images: ImageBlock[]) => T, now = new Date()): Promise<T> {
    if (!ids.length) return write([]);
    const from = ids.map((id) => this.staged(id));
    const dest = join(workdir, 'uploads');
    mkdirSync(dest, { recursive: true });
    const date = now.toISOString().slice(0, 10);
    const copied: string[] = [];
    let result: T;
    try {
      const images: ImageBlock[] = [];
      for (const f of from) {
        const name = f.slice(f.lastIndexOf('--') + 2);
        const ext = name.slice(name.lastIndexOf('.'));
        const stem = `${date}-${name.slice(0, -ext.length)}`;
        let to = join(dest, stem + ext);
        for (let i = 2; existsSync(to); i++) to = join(dest, `${stem}-${i}${ext}`);
        copyFileSync(f, to, constants.COPYFILE_EXCL);
        copied.push(to);
        images.push(await describeImage(to, readFileSync(to)));
      }
      result = write(images);
    } catch (e) {
      for (const to of copied) rmSync(to, { force: true });
      throw e;
    }
    for (const f of from) rmSync(f, { force: true });
    return result;
  }

  /** Staged files older than a day: nobody sent them. Called at start. */
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
