import { lstat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { Db } from './store/db.ts';
import { inside } from './tools.ts';
import { MAX_FILE_BYTES, snapshotted, type FileState, type Snapshots } from './snapshots.ts';

/**
 * Which files each card's tool calls changed (card #68), so a rewind puts back only its own chat's changes and never
 * another card's work in the same workdir. write_file/edit_file: the file's state before and after. A foreground shell
 * command: the files that differ between snapshots taken right before and after it (a change another card made during
 * the command is counted too: the rewind then sees both cards changed the file and refuses, never overwrites).
 * Background commands are not tracked (a rewind kills those started since).
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface Change {
  path: string;
  before: FileState;
  after: FileState;
}

export class FileLog {
  /** Tool calls being tracked, per card: a rewind waits for them (a stopped command records its changes first). */
  private pending = new Map<string, Set<Promise<unknown>>>();

  constructor(
    private db: Db,
    readonly snapshots: Snapshots,
  ) {}

  /** Run a tool call of `cardId` in `workdir`, logging the files it changed. Tracking failures are logged as such, never thrown. */
  track<T>(cardId: string, workdir: string, tool: string, input: unknown, run: () => Promise<T>): Promise<T> {
    const p = this.trackNow(cardId, workdir, tool, input, run);
    const set = this.pending.get(cardId) ?? new Set();
    this.pending.set(cardId, set);
    const settled = p.catch(() => undefined);
    set.add(settled);
    void settled.then(() => {
      set.delete(settled);
      if (!set.size && this.pending.get(cardId) === set) this.pending.delete(cardId);
    });
    return p;
  }

  /** Wait for the card's tool calls still recording their changes. */
  async idle(cardId: string): Promise<void> {
    await Promise.all([...(this.pending.get(cardId) ?? [])]);
  }

  private async trackNow<T>(cardId: string, workdir: string, tool: string, input: unknown, run: () => Promise<T>): Promise<T> {
    const started = new Date().toISOString();
    const i = (input ?? {}) as { path?: unknown; command?: unknown; background?: unknown };
    if ((tool === 'write_file' || tool === 'edit_file') && typeof i.path === 'string') {
      const path = this.relPath(workdir, i.path);
      if (!path) return run(); // outside the workdir (refused by the tool) or excluded from snapshots
      let before: FileState;
      try {
        before = await this.fileState(workdir, path);
      } catch (e) {
        this.log(cardId, workdir, tool, started, [], `${path}: ${errText(e)}`);
        return run();
      }
      try {
        return await run();
      } finally {
        try {
          const after = await this.fileState(workdir, path);
          this.log(cardId, workdir, tool, started, same(before, after) ? [] : [{ path, before, after }], null);
        } catch (e) {
          this.log(cardId, workdir, tool, started, [], `${path}: ${errText(e)}`);
        }
      }
    }
    if (tool === 'shell' && i.background !== true) {
      let from: string;
      try {
        from = await this.snapshots.take(workdir);
      } catch (e) {
        this.log(cardId, workdir, tool, started, [], `the snapshot before \`${String(i.command).slice(0, 80)}\` failed: ${errText(e)}`);
        return run();
      }
      try {
        return await run();
      } finally {
        try {
          const to = await this.snapshots.take(workdir);
          const changes = from === to ? [] : await this.snapshots.diff(workdir, from, to);
          await this.snapshots.keepBlobs(changes.flatMap((c) => [c.before?.sha, c.after?.sha].filter((s): s is string => !!s)));
          this.log(cardId, workdir, tool, started, changes, null);
        } catch (e) {
          this.log(cardId, workdir, tool, started, [], `the snapshot after \`${String(i.command).slice(0, 80)}\` failed: ${errText(e)}`);
        }
      }
    }
    return run();
  }

  /** A file tool's path relative to the workdir, or null when it isn't one a snapshot covers. */
  private relPath(workdir: string, p: string): string | null {
    let full: string;
    try {
      full = inside(workdir, p);
    } catch {
      return null; // outside the workdir: the tool refuses it, nothing changes
    }
    const rel = relative(workdir, full).split(sep).join('/');
    return rel && snapshotted(rel) ? rel : null;
  }

  /** Oversize files are left out, like snapshots do: logged as absent on both sides, so never restored. */
  private async fileState(workdir: string, path: string): Promise<FileState> {
    const st = await lstat(inside(workdir, path)).catch(() => null);
    if (st?.isFile() && st.size > MAX_FILE_BYTES) return null;
    return this.snapshots.state(workdir, path, true);
  }

  private log(cardId: string, workdir: string, tool: string, started: string, changes: Change[], error: string | null): void {
    const ended = new Date().toISOString();
    const ins = this.db.prepare(
      `INSERT INTO file_changes (card_id, workdir, path, before_sha, before_mode, after_sha, after_mode, error, tool, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    if (error) console.warn(`file changes of a ${tool} call on ${cardId} not tracked: ${error}`);
    this.db.transaction(() => {
      if (error) ins.run(cardId, workdir, null, null, null, null, null, error, tool, started, ended);
      for (const c of changes) ins.run(cardId, workdir, c.path, c.before?.sha ?? null, c.before?.mode ?? null, c.after?.sha ?? null, c.after?.mode ?? null, null, tool, started, ended);
    })();
  }
}

export const same = (a: FileState, b: FileState): boolean => (a === null ? b === null : b !== null && a.sha === b.sha && a.mode === b.mode);
