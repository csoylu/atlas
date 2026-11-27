// Comment mode (#304): what Master pinned on the pane's open tab, turned into text the agent can act on, with a cropped
// picture for an area of something visual. Called by POST /api/cards/:id/messages before the message row is written;
// the result is stored with the message (text + image blocks), so a restart or a rewind keeps it.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findSection, formatComment, isImageAddress, linkOf, splitSections, type CommentAnchor, type CommentExtra, type CommentWhere, type Doc, type ImageBlock, type PostComment } from '@atlas/shared';
import { describeImage, loadSharp, sniff } from './images.ts';
import { inside } from './tools.ts';
import { InvalidError } from './kanban.ts';

/** A picture of part of a workspace page, taken in headless Chrome (screenshot.ts); returns the png's path. */
export type PageShot = (o: { page: string; width: number; height: number; region: { x: number; y: number; w: number; h: number }; workdir: string }) => Promise<string>;

export interface CommentDeps {
  /** An artifact at a version (the latest when that one is no longer kept). */
  doc(docId: string, version: number): { doc: Doc; version: number; content: string; latest: number };
  /** The folder behind /api/files/<root>/… */
  filesDir(root: string): string;
  /** The chat's agent workspace (where pictures go) and the folder files are read from (the code tab: the same). */
  workdir: string;
  /** null: pages are never shot (tests); the text says so. */
  shoot: PageShot | null;
  /** The chat's browser page as Master last saw it in comment mode (#306), a png; null when that page is gone. */
  browserPage?: ((url: string) => Promise<Buffer | null>) | null;
  /** Secrets.redact (rule 5): every comment's text, the quoted file lines included, passes it before it is stored or sent. */
  redact(text: string): string;
  now?: Date;
}

const KIND_NAME = { markdown: 'markdown', html: 'html page', diagram: 'svg diagram', url: 'link' } as const;
/** Smallest side of an area worth a picture (px of the document); a pin is described by what is under it. */
const MIN_SIDE = 4;

/** The message blocks of these comments, in order: each comment's text, then its picture if any. */
export async function commentBlocks(comments: PostComment[], d: CommentDeps): Promise<({ type: 'text'; text: string } | ImageBlock)[]> {
  const out: ({ type: 'text'; text: string } | ImageBlock)[] = [];
  for (const [i, c] of comments.entries()) {
    const n = c.n ?? i + 1;
    const { where, extra, picture } = await describe(c, d, n);
    out.push({ type: 'text', text: d.redact(formatComment(n, where, c.anchor, c.text, extra)) });
    if (picture) out.push(picture);
  }
  return out;
}

async function describe(c: PostComment, d: CommentDeps, n: number): Promise<{ where: CommentWhere; extra: CommentExtra; picture: ImageBlock | null }> {
  const a = c.anchor;
  const extra: CommentExtra = {};
  let picture: ImageBlock | null = null;
  const crop = async (make: () => Promise<{ file: string } | { buf: Buffer }>) => {
    try {
      const r = await make();
      const file = 'file' in r ? r.file : await save(d, r.buf, n);
      picture = await describeImage(file, await readFile(file));
      extra.picture = relative(d.workdir, file);
    } catch (e) {
      extra.noPicture = `it could not be made (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`;
    }
  };

  if (c.target.kind === 'file') {
    const full = inside(d.workdir, c.target.path);
    // Like /api/files: a dotfile or a file in a dot folder (.env, .git/…) is never read for the agent.
    if (relative(d.workdir, full).split(/[\\/]/).some((p) => p.startsWith('.'))) throw new InvalidError(`comment ${n}: ${c.target.path} is a hidden file: it can't be quoted`);
    if (!existsSync(full)) throw new InvalidError(`comment ${n}: ${c.target.path} does not exist in the agent's workspace`);
    const where = { title: c.target.path.split('/').pop()!, what: `file ${c.target.path}` };
    if (a.type === 'lines') {
      const lines = (await readFile(full, 'utf8')).split('\n');
      if (a.from > a.to || a.from > lines.length) throw new InvalidError(`comment ${n}: ${c.target.path} has ${lines.length} lines, not ${a.from}–${a.to}`);
      extra.source = { from: a.from, lines: lines.slice(a.from - 1, a.to).map((l) => d.redact(l)) };
    } else if (a.type === 'area' && a.box.w >= MIN_SIDE && a.box.h >= MIN_SIDE) {
      const buf = await readFile(full);
      if (sniff(buf) || /\.svg$/i.test(full)) await crop(async () => ({ buf: await cropImage(buf, a) }));
    }
    return { where, extra, picture };
  }

  if (c.target.kind === 'browser') {
    const url = c.target.url;
    const where = { title: c.target.title.trim() || hostOf(url), what: `page ${url} in the chat's browser` };
    if (a.type === 'area' && a.box.w >= MIN_SIDE && a.box.h >= MIN_SIDE) {
      if (!d.browserPage) extra.noPicture = 'pages are not shot here';
      else
        await crop(async () => {
          const png = await d.browserPage!(url);
          if (!png) throw new Error('the page is no longer the one on screen');
          return { buf: await cropImage(png, a) };
        });
    }
    return { where, extra, picture };
  }

  const { doc, version, content, latest } = d.doc(c.target.docId, c.target.version);
  const kind = KIND_NAME[doc.kind];
  const at = `${doc.agentId}'s workspace`;
  let what = `${kind} ${doc.path} in ${at}, ${doc.id} v${version}${version !== latest ? ` (the latest is v${latest})` : ''}`;
  const link = doc.kind === 'url' ? linkOf(content) : '';
  if (link) what += `, address ${link}`;
  const where = { title: doc.title, what };

  if (doc.kind === 'markdown' && a.type === 'text') {
    const sections = splitSections(content);
    // The section from the lines when the UI did not give it (the text before the first heading is '').
    if (a.section === null && a.lines) a.section = [...sections].reverse().find((s) => s.line <= a.lines![0])?.id ?? null;
    else if (a.section !== null) a.section = findSection(sections, a.section)?.id ?? a.section;
  }
  if (a.type !== 'area' || a.box.w < MIN_SIDE || a.box.h < MIN_SIDE) return { where, extra, picture };

  // An area: a picture of it, from the version shown.
  if (doc.kind === 'diagram') await crop(async () => ({ buf: await cropImage(Buffer.from(content), a) }));
  else if (doc.kind === 'html') {
    if (version !== latest) extra.noPicture = `the file is now v${latest}; only the latest version can be shot`;
    else if (!d.shoot) extra.noPicture = 'pages are not shot here';
    else await crop(async () => ({ file: await d.shoot!({ page: `/api/files/${encodeURIComponent(doc.filesRoot)}/${doc.path.split('/').map(encodeURIComponent).join('/')}`, width: a.of.w, height: a.of.h, region: a.box, workdir: d.workdir }) }));
  } else if (doc.kind === 'url') {
    const local = /^\/api\/files\/([^/]+)\/(.+?)(?:[?#].*)?$/.exec(link.replace(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?=\/api\/files\/)/, ''));
    if (!local) extra.noPicture = 'the page is on another site; the coordinates are of the frame as shown';
    else if (isImageAddress(link)) await crop(async () => ({ buf: await cropImage(await readFile(inside(d.filesDir(decodeURIComponent(local[1]!)), decodeURIComponent(local[2]!))), a) }));
    else if (!d.shoot) extra.noPicture = 'pages are not shot here';
    else await crop(async () => ({ file: await d.shoot!({ page: `/api/files/${local[1]}/${local[2]}`, width: a.of.w, height: a.of.h, region: a.box, workdir: d.workdir }) }));
  }
  return { where, extra, picture };
}

/** Part of an image (its own pixels) or of an svg (its own units, rendered at 2×), as a png. */
export async function cropImage(buf: Buffer, a: Extract<CommentAnchor, { type: 'area' }>): Promise<Buffer> {
  const svg = !sniff(buf);
  const img = await loadSharp(buf, svg ? { density: 144 } : {});
  const meta = await img.metadata();
  const W = meta.width ?? 0;
  const H = meta.pageHeight ?? meta.height ?? 0;
  if (!W || !H) throw new Error('the picture has no size');
  // Document units → pixels of the rendered picture (the svg's viewBox maps to the rendered size).
  const kx = W / a.of.w;
  const ky = H / a.of.h;
  // An svg's coordinates are its user units: a viewBox that does not start at 0 0 moves them.
  const vb = svg ? /viewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(buf.toString('utf8', 0, 4000)) : null;
  const ox = vb ? Number(vb[1]) : 0;
  const oy = vb ? Number(vb[2]) : 0;
  const left = clamp(Math.floor((a.box.x - ox) * kx), 0, W - 1);
  const top = clamp(Math.floor((a.box.y - oy) * ky), 0, H - 1);
  const width = clamp(Math.ceil(a.box.w * kx), 1, W - left);
  const height = clamp(Math.ceil(a.box.h * ky), 1, H - top);
  return (await loadSharp(await img.png().toBuffer())).extract({ left, top, width, height }).png().toBuffer();
}
const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url; // not a full address: shown as it is
  }
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

async function save(d: CommentDeps, buf: Buffer, n: number): Promise<string> {
  const dir = join(d.workdir, 'uploads');
  await mkdir(dir, { recursive: true });
  const stamp = (d.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  let file = join(dir, `${stamp}-comment-${n}.png`);
  for (let i = 2; existsSync(file); i++) file = join(dir, `${stamp}-comment-${n}-${i}.png`);
  await writeFile(file, buf);
  return file;
}
