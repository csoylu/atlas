// Images (#103): what a picture in the transcript is (a file + its reference), and how it goes to a model.
// The transcript stores only ImageBlock references (path, hash, size); the bytes are read, checked and downscaled
// here, at send time, for the newest IMAGE_KEEP pictures of the view. Older ones become a text line.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { Metadata, Sharp, SharpOptions } from 'sharp';

/**
 * sharp (native libvips) is loaded on first use: if its binary is missing for this platform, only pictures fail, with
 * the reason, and the engine still starts.
 */
let lib: Promise<(input: Buffer, o?: SharpOptions) => Sharp> | null = null;
const sharp = async (input: Buffer, o?: SharpOptions): Promise<Sharp> => {
  lib ??= import('sharp').then(
    (m) => m.default,
    (e: unknown) => {
      lib = null;
      throw new Error(`images are unavailable: the image library (sharp) did not load on this machine (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
    },
  );
  return (await lib)(input, o);
};
/** The same loader for other modules (comment pictures, #304). */
export const loadSharp = sharp;
import { IMAGE_KEEP, IMAGE_MAX_BYTES, type ContentBlock, type ImageBlock, type ImageMediaType } from '@atlas/shared';
import type { ModelRequest } from './providers/types.ts';

/** Long side sent to a model at most (Anthropic's own resize threshold). */
export const MAX_SIDE = 1568;
/** Raw bytes sent at most per picture (Anthropic refuses images over 5 MB; base64 adds a third). */
export const MAX_SEND_BYTES = 3_600_000;
/** Rough tokens a picture costs a model (≈ 1568×1568 / 750 is ~3.3k; typical screenshots ~1.6k). */
export const IMAGE_TOKENS = 1600;

const EXT: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const extOf = (t: ImageMediaType) => EXT[t];

/** The picture's type from its first bytes (never from the name or a header): null if not png, jpeg, gif or webp. */
export function sniff(buf: Uint8Array): ImageMediaType | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, 16));
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Does this file name look like a picture read_file should return as one? */
export const looksLikeImage = (path: string) => /\.(png|jpe?g|gif|webp)$/i.test(path);

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A picture's reference from its bytes (already on disk at `path`). Throws a clear error when it isn't one we take. */
export async function describeImage(path: string, buf: Buffer): Promise<ImageBlock> {
  if (buf.length > IMAGE_MAX_BYTES) throw new Error(`${path} is ${mb(buf.length)}: images over ${mb(IMAGE_MAX_BYTES)} are refused`);
  const media_type = sniff(buf);
  if (!media_type) throw new Error(`${path} is not a png, jpeg, gif or webp image`);
  let meta: Metadata;
  try {
    meta = await (await sharp(buf)).metadata();
  } catch (e) {
    throw new Error(`${path} could not be decoded as ${media_type}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!meta.width || !meta.height) throw new Error(`${path}: the image has no size`);
  return {
    type: 'image',
    path,
    media_type,
    width: meta.width,
    height: meta.pageHeight ?? meta.height,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

/** A picture file's reference (read_file). */
export async function imageFile(path: string): Promise<ImageBlock> {
  const st = await stat(path);
  if (st.size > IMAGE_MAX_BYTES) throw new Error(`${path} is ${mb(st.size)}: images over ${mb(IMAGE_MAX_BYTES)} are refused`);
  return describeImage(path, await readFile(path));
}

/** The text line the model reads with a picture: path and size. */
export const imageLine = (b: ImageBlock) => `[image: ${b.path} (${b.width}×${b.height} px, ${Math.max(1, Math.round(b.bytes / 1024))} KB)]`;
const oldLine = (b: ImageBlock) =>
  `[image: ${b.path} (${b.width}×${b.height} px), no longer shown as a picture to save context; read_file it to see it again]`;

/**
 * The bytes a model gets for a picture: as is when small enough, else resized to MAX_SIDE on the long side (gif: its
 * first frame, as png) and, if still too heavy, re-encoded as jpeg. Throws when the file is gone or changed.
 */
export async function wireImage(b: ImageBlock): Promise<{ media_type: ImageMediaType; data: string }> {
  const key = `${b.path}\n${b.sha256}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const buf = await readFile(b.path);
  if (createHash('sha256').update(buf).digest('hex') !== b.sha256) throw new ChangedError();
  let out: { media_type: ImageMediaType; data: Buffer } = { media_type: b.media_type, data: buf };
  const big = Math.max(b.width, b.height) > MAX_SIDE || buf.length > MAX_SEND_BYTES || b.media_type === 'image/gif';
  if (big) {
    const img = (await sharp(buf, { animated: false })).resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    out =
      b.media_type === 'image/jpeg'
        ? { media_type: 'image/jpeg', data: await img.jpeg({ quality: 85 }).toBuffer() }
        : b.media_type === 'image/webp'
          ? { media_type: 'image/webp', data: await img.webp({ quality: 85 }).toBuffer() }
          : { media_type: 'image/png', data: await img.png().toBuffer() };
    if (out.data.length > MAX_SEND_BYTES)
      out = { media_type: 'image/jpeg', data: await (await sharp(out.data)).flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer() };
  }
  const wire = { media_type: out.media_type, data: out.data.toString('base64') };
  cache.set(key, wire);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return wire;
}
class ChangedError extends Error {}
const CACHE_MAX = 24;
const cache = new Map<string, { media_type: ImageMediaType; data: string }>();

/** Why a picture can't be shown, as the line the model reads instead (never a crash: rule 3 is the text itself). */
async function wireOrNote(b: ImageBlock): Promise<ImageBlock | string> {
  try {
    return { ...b, ...(await wireImage(b)) };
  } catch (e) {
    if (e instanceof ChangedError) return `[image: ${b.path}: the file changed since it was attached; read_file it to see the current version]`;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return `[image: ${b.path}: the file no longer exists, it can't be shown]`;
    return `[image: ${b.path}: it can't be shown (${e instanceof Error ? e.message : String(e)})]`;
  }
}

/**
 * The view as it goes to the provider: the newest `keep` pictures carry their bytes (`data`), older ones and missing
 * files become text. `pinned` pictures always carry their bytes, on top of the `keep` (a task's own images, #119).
 * Returns copies; the view's blocks are never touched.
 */
export async function withPictures(view: ModelRequest['messages'], keep = IMAGE_KEEP, pinned: ReadonlySet<ImageBlock> = new Set()): Promise<ModelRequest['messages']> {
  // Which pictures are among the newest `keep` (walking back from the end), plus the pinned ones.
  const recent = new Set<ImageBlock>(pinned);
  const max = keep + pinned.size;
  for (let i = view.length - 1; i >= 0 && recent.size < max; i--) {
    const c = view[i]!.content;
    for (let j = c.length - 1; j >= 0 && recent.size < max; j--) {
      const b = c[j]!;
      if (b.type === 'image') recent.add(b);
      else if (b.type === 'tool_result' && b.images) for (let k = b.images.length - 1; k >= 0 && recent.size < max; k--) recent.add(b.images[k]!);
    }
  }
  if (!recent.size && !view.some((t) => t.content.some(hasImage))) return view;
  const wired = new Map<ImageBlock, ImageBlock | string>();
  await Promise.all([...recent].map(async (b) => wired.set(b, await wireOrNote(b))));
  return view.map((t) => {
    if (!t.content.some(hasImage)) return t;
    const content = t.content.map((b): ContentBlock => {
      if (b.type === 'image') {
        const w = wired.get(b);
        return w === undefined ? { type: 'text', text: oldLine(b) } : typeof w === 'string' ? { type: 'text', text: w } : w;
      }
      if (b.type === 'tool_result' && b.images?.length) {
        const images: ImageBlock[] = [];
        const notes: string[] = [];
        for (const im of b.images) {
          const w = wired.get(im);
          if (w === undefined) notes.push(oldLine(im));
          else if (typeof w === 'string') notes.push(w);
          else images.push(w);
        }
        const { images: _drop, ...rest } = b;
        return { ...rest, content: [b.content, ...notes].join('\n'), ...(images.length ? { images } : {}) };
      }
      return b;
    });
    return { role: t.role, content };
  });
}

export const hasImage = (b: ContentBlock) => b.type === 'image' || (b.type === 'tool_result' && !!b.images?.length);

/** Does any picture in this view carry bytes (what a provider must be able to send)? */
export const viewHasPictures = (view: ModelRequest['messages']) =>
  view.some((t) => t.content.some((b) => (b.type === 'image' && !!b.data) || (b.type === 'tool_result' && !!b.images?.some((i) => i.data))));

/** The transcript form: a block as stored, `data` never kept. */
export function stripData(content: ContentBlock[]): ContentBlock[] {
  if (!content.some(hasImage)) return content;
  return content.map((b) => {
    if (b.type === 'image' && b.data !== undefined) {
      const { data: _d, ...r } = b;
      return r;
    }
    if (b.type === 'tool_result' && b.images?.some((i) => i.data !== undefined))
      return { ...b, images: b.images.map(({ data: _d, ...r }) => r) };
    return b;
  });
}
