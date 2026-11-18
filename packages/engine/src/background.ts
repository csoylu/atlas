import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './store/db.ts';

/**
 * Background shell processes (shell with background: true). Each one runs in its own process group, writes stdout and
 * stderr to a log file in the agent's outputs folder, and has a row in `background_processes` (pid, lease) so a dead
 * engine's processes are killed at the next start (rule 2, like tool_calls pids). When one ends on its own, `onExit`
 * gets it (the runner posts a system note in the conversation and wakes the agent).
 */
export type BgStatus = 'running' | 'exited' | 'killed' | 'lost';

export interface BgProcess {
  id: string;
  agentId: string;
  cardId: string;
  command: string;
  pid: number | null;
  logPath: string;
  status: BgStatus;
  exitCode: number | null;
  signal: string | null;
  readOffset: number;
  startedAt: string;
  endedAt: string | null;
}

interface Row {
  id: string;
  agent_id: string;
  card_id: string;
  command: string;
  pid: number | null;
  log_path: string;
  status: BgStatus;
  exit_code: number | null;
  signal: string | null;
  read_offset: number;
  started_at: string;
  ended_at: string | null;
}
const toProc = (r: Row): BgProcess => ({
  id: r.id,
  agentId: r.agent_id,
  cardId: r.card_id,
  command: r.command,
  pid: r.pid,
  logPath: r.log_path,
  status: r.status,
  exitCode: r.exit_code,
  signal: r.signal,
  readOffset: r.read_offset,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

/** Output returned by one shell_output call at most. */
export const PAGE_BYTES = 30_000;
/** Tail of the output put in the exit note. */
const NOTE_TAIL = 2_000;

const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();

export class Background {
  /** Processes of this engine: killed by stop/kill or shutdown, so their exit isn't reported as a crash. */
  private live = new Map<string, { pid: number | null; killed: boolean }>();
  onExit: (p: BgProcess) => void = () => {};

  constructor(
    private db: Db,
    private instance: string,
    private leaseMs = 60_000,
  ) {}

  start(o: { command: string; cwd: string; logDir: string; agentId: string; cardId: string; env?: NodeJS.ProcessEnv }): BgProcess {
    const id = 'bg_' + randomUUID().slice(0, 8);
    mkdirSync(o.logDir, { recursive: true });
    const logPath = join(o.logDir, `${id}.log`);
    const fd = openSync(logPath, 'w');
    let child;
    try {
      // Own process group (Unix) so the whole tree can be killed; output straight to the file (no pipe to keep open).
      child = spawn(o.command, { cwd: o.cwd, shell: true, env: o.env ?? process.env, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
    } finally {
      closeSync(fd);
    }
    const pid = child.pid ?? null;
    this.db
      .prepare(
        `INSERT INTO background_processes (id, agent_id, card_id, command, pid, log_path, status, owner, lease_until, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(id, o.agentId, o.cardId, o.command, pid, logPath, this.instance, isoIn(this.leaseMs), new Date().toISOString());
    this.live.set(id, { pid, killed: false });
    child.on('error', (e) => this.ended(id, null, null, `could not start: ${e.message}`));
    child.on('exit', (code, sig) => this.ended(id, code, sig));
    child.unref();
    return this.get(id)!;
  }

  get(id: string): BgProcess | null {
    const r = this.db.prepare('SELECT * FROM background_processes WHERE id = ?').get(id) as Row | undefined;
    return r ? toProc(r) : null;
  }

  /** The process, if it belongs to this agent. */
  own(id: string, agentId: string): BgProcess {
    const p = this.get(id);
    if (!p || p.agentId !== agentId) throw new Error(`no background process ${id}`);
    return p;
  }

  /** New output since the last read (or from `offset`, in bytes), at most PAGE_BYTES; moves the read cursor. */
  read(id: string, agentId: string, offset?: number): string {
    const p = this.own(id, agentId);
    const from = offset ?? p.readOffset;
    const { text, end, size } = readSlice(p.logPath, from, PAGE_BYTES);
    this.db.prepare('UPDATE background_processes SET read_offset = ? WHERE id = ?').run(end, id);
    const head = `${id}: ${describe(p)}`;
    if (end === from) return `${head}\n(no new output; ${size} bytes in total)`;
    const more = end < size ? `\n[output bytes ${from}–${end} of ${size}; shell_output(id, offset=${end}) for more]` : '';
    return `${head}\n[output bytes ${from}–${end} of ${size}]\n${text}${more}`;
  }

  /** Kill the process group: TERM, then KILL after 2 s if still there. No exit note (the agent asked). */
  kill(id: string, agentId: string): string {
    const p = this.own(id, agentId);
    if (p.status !== 'running') return `${id} is not running (${describe(p)})`;
    const l = this.live.get(id);
    if (l) l.killed = true;
    signalGroup(p.pid, 'SIGTERM');
    setTimeout(() => signalGroup(p.pid, 'SIGKILL'), 2000).unref();
    if (!l) this.mark(id, 'killed', null, 'SIGTERM'); // another engine's process: its exit event won't come here
    return `sent SIGTERM to ${id} (pid ${p.pid}); its log stays at ${p.logPath}`;
  }

  running(): BgProcess[] {
    return (this.db.prepare("SELECT * FROM background_processes WHERE status = 'running'").all() as Row[]).map(toProc);
  }

  renew(): void {
    this.db
      .prepare("UPDATE background_processes SET lease_until = ? WHERE owner = ? AND status = 'running'")
      .run(isoIn(this.leaseMs), this.instance);
  }

  /** Processes whose engine died (lease expired): kill their process group, mark them lost, report them. */
  recover(): BgProcess[] {
    const stale = this.db
      .prepare("SELECT * FROM background_processes WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)")
      .all(new Date().toISOString()) as Row[];
    return stale.flatMap((r) => {
      signalGroup(r.pid, 'SIGKILL');
      const p = this.mark(r.id, 'lost', null, null);
      if (p) this.onExit(p);
      return p ? [p] : [];
    });
  }

  /** Engine stopping: kill this engine's processes (they'd be orphans), mark them killed. */
  shutdown(): void {
    for (const [id, l] of this.live) {
      l.killed = true;
      signalGroup(l.pid, 'SIGKILL');
      this.mark(id, 'killed', null, 'SIGKILL');
    }
    this.live.clear();
  }

  private ended(id: string, code: number | null, sig: NodeJS.Signals | null, error?: string): void {
    const l = this.live.get(id);
    if (!l) return; // shut down meanwhile: already marked killed (and the database may be closed)
    this.live.delete(id);
    const p = this.mark(id, l.killed ? 'killed' : 'exited', code, sig, error);
    if (p && !l.killed) this.onExit(p);
  }

  /** Set the final status once (a row already ended stays as it is). Returns the process if this call ended it. */
  private mark(id: string, status: BgStatus, code: number | null, sig: string | null, error?: string): BgProcess | null {
    const n = this.db
      .prepare("UPDATE background_processes SET status = ?, exit_code = ?, signal = ?, ended_at = ? WHERE id = ? AND status = 'running'")
      .run(status, code, error ?? sig, new Date().toISOString(), id).changes;
    return n ? this.get(id) : null;
  }
}

export function describe(p: BgProcess): string {
  if (p.status === 'running') return `running (pid ${p.pid}, since ${p.startedAt})`;
  if (p.status === 'exited') return p.exitCode != null ? `exited with code ${p.exitCode}` : `ended by ${p.signal ?? 'a signal'}`;
  if (p.status === 'killed') return 'killed';
  return 'lost: the engine stopped while it ran, so it was killed at restart';
}

/** The system note posted when a background process ends: status and the tail of its output. */
export function exitNote(p: BgProcess): string {
  const { text, size } = readTail(p.logPath, NOTE_TAIL);
  return [
    `Background process ${p.id} (\`${p.command.length > 200 ? p.command.slice(0, 200) + '…' : p.command}\`) ${describe(p)}.`,
    size ? `Last output (${size} bytes in total, full log: ${p.logPath}):\n\`\`\`\n${text}\n\`\`\`` : 'It wrote no output.',
  ].join('\n');
}

function signalGroup(pid: number | null, sig: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') process.kill(pid, sig);
    else process.kill(-pid, sig);
  } catch {
    // already gone
  }
}

/** Bytes [from, from+max) of a file as text, cut back to the last newline when there is more. */
function readSlice(path: string, from: number, max: number): { text: string; end: number; size: number } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { text: '', end: from, size: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.min(Math.max(0, from), size);
    const len = Math.min(max, size - start);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    let take = len;
    if (start + len < size) {
      const nl = buf.lastIndexOf(10);
      if (nl > 0) take = nl + 1;
    }
    return { text: buf.subarray(0, take).toString('utf8'), end: start + take, size };
  } finally {
    closeSync(fd);
  }
}

function readTail(path: string, max: number): { text: string; size: number } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { text: '', size: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(max, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8').replace(/\s+$/, '');
    return { text: (len < size ? '…' : '') + text, size };
  } finally {
    closeSync(fd);
  }
}
