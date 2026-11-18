// Images attached to a task itself (#119), not to one of its messages. Stored once, in <data>/task-images/
// (<date>-<name>.<ext>, like a message's uploads); the card row lists their image blocks (cards.images, migration
// 0040). The same two durable steps as a message (uploads.ts): the staged files are copied here, the row is written
// in its transaction, then the staged files go; a failed row write removes the copies. Files no card lists (a crash
// between the copy and the row, a removed image whose delete failed, a deleted card) are swept at start.
//
// At each turn the agent running the task sees them at the start of its view (not stored in its transcript): so the
// assignee of the moment, a later assignee and the triage agent all see the task's current images, and a removed
// image is gone from the next turn on. Each one is also copied into that agent's workspace (uploads/task-N-…), so it
// can use the file; the picture itself is read from the task's copy, which the agent can't change.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { cardRef, type Card, type ContentBlock, type ImageBlock } from '@atlas/shared';
import type { ModelRequest } from './providers/types.ts';
import type { Uploads } from './uploads.ts';

export class TaskImages {
  readonly dir: string;
  constructor(
    dataDir: string,
    private uploads: Uploads,
  ) {
    this.dir = join(dataDir, 'task-images');
  }

  /** Copy staged uploads here and hand their blocks to `write` (the row write); see Uploads.place. */
  attach<T>(ids: string[], write: (images: ImageBlock[]) => T): Promise<T> {
    return this.uploads.place(ids, this.dir, write);
  }

  /** Is this a file of ours (a task image)? Only those are ever deleted or served as a task's picture. */
  owns(path: string): boolean {
    const p = resolve(path);
    return dirname(p) === resolve(this.dir);
  }

  /** Delete images the row no longer lists (after its write: a failed delete leaves a file the sweep removes). */
  drop(images: ImageBlock[]): void {
    for (const im of images) {
      if (!this.owns(im.path)) continue;
      try {
        rmSync(im.path, { force: true });
      } catch (e) {
        console.error('removing a task image failed', im.path, e);
      }
    }
  }

  /** At start: files no card lists. Returns how many were removed. */
  sweep(listed: Iterable<string>): number {
    if (!existsSync(this.dir)) return 0;
    const keep = new Set([...listed].map((p) => resolve(p)));
    let n = 0;
    for (const f of readdirSync(this.dir)) {
      const p = resolve(this.dir, f);
      if (keep.has(p) || !statSync(p).isFile()) continue;
      rmSync(p, { force: true });
      n++;
    }
    return n;
  }
}

/** Where a task image goes in an agent's workspace. */
export const workspaceName = (card: Pick<Card, 'id' | 'number'>, im: ImageBlock) =>
  join('uploads', `task-${cardRef(card).replace(/^#/, '')}-${basename(im.path)}`);

/**
 * The blocks that open the view of a run on this task: a line, then each picture with the path of its copy in
 * `workdir` (copied now if missing). A copy that fails is said in the text; the picture still goes (from the task's file).
 */
export function taskImageBlocks(card: Card, workdir: string): ContentBlock[] {
  if (!card.images.length) return [];
  const out: ContentBlock[] = [{ type: 'text', text: `Images attached to task ${cardRef(card)} (${card.images.length}):` }];
  for (const im of card.images) {
    const rel = workspaceName(card, im);
    const to = join(workdir, rel);
    let line = `[attached: ${rel}]`;
    try {
      if (!existsSync(to) || statSync(to).size !== im.bytes) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(im.path, to);
      }
    } catch (e) {
      line = `[image: ${relative(workdir, to)} could not be copied into your workspace: ${e instanceof Error ? e.message : String(e)}]`;
    }
    out.push(im, { type: 'text', text: line });
  }
  return out;
}

/** The view with the task's pictures at its start (in the first user message, or a user message of their own). */
export function withTaskImages(view: ModelRequest['messages'], blocks: ContentBlock[]): ModelRequest['messages'] {
  if (!blocks.length) return view;
  const [first, ...rest] = view;
  if (first?.role === 'user') return [{ role: 'user', content: [...blocks, ...first.content] }, ...rest];
  return [{ role: 'user', content: blocks }, ...view];
}
