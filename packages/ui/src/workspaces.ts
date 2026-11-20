import { hostAllowed, type NetworkLevel, type NetworkPending, type NetworkRefusal, type Project, type ProjectMember, type SecretInfo } from '@atlas/shared';

/**
 * Settings → Workspaces (#308, #298 §2.5, mockup #299 v8): what each row shows, from the project, its members, the
 * secrets' metadata, the refusals and the pending background commands. Pure, so it is tested without a page.
 */

export const LEVELS: NetworkLevel[] = ['on', 'hosts', 'off'];
export const LEVEL_LABEL: Record<NetworkLevel, string> = { on: 'On', hosts: 'Allowed hosts', off: 'Off' };
/** The line under an agent's name: what its commands get. */
export const LEVEL_STATE: Record<NetworkLevel, string> = { on: 'Internet on', hosts: 'Allowed hosts only', off: 'No internet' };

/** The level and host list in effect for a workspace (engine: effectiveNetwork). An empty own list = the project's. */
export function effective(p: Project, m: ProjectMember): { level: NetworkLevel; hosts: string[]; ownHosts: boolean } {
  const ownHosts = !!m.allowedHosts?.length;
  return { level: m.network ?? p.network, hosts: ownHosts ? m.allowedHosts! : p.allowedHosts, ownHosts };
}

/** The workspace path shown read-only: relative to the data folder when it is inside it. */
export function workspacePath(m: ProjectMember, agentWorkdir: string | null, dataDir: string | null): string {
  const abs = m.workspace ?? agentWorkdir ?? (dataDir ? `${dataDir}/workspaces/${m.agentId}` : `workspaces/${m.agentId}`);
  if (!dataDir) return abs;
  const base = dataDir.replace(/\/+$/, '');
  return abs.startsWith(base + '/') ? 'data/' + abs.slice(base.length + 1) : abs;
}

export type GitAccess =
  | { kind: 'norepo' }
  | { kind: 'missing' }
  | { kind: 'granted'; granted: number; members: number; secret: SecretInfo };

/**
 * The git access row: the GH_TOKEN agents get in this project. Secret names are unique across projects: one GH_TOKEN,
 * global (Master's choice in #316) or one project's. Another project's, or no value stored, = no secret here.
 */
export function gitAccess(p: Project, secrets: SecretInfo[]): GitAccess {
  if (!p.repo) return { kind: 'norepo' };
  const secret = secrets.find((s) => s.kind === 'agent' && s.name === 'GH_TOKEN' && (s.project === null || s.project === p.id));
  if (!secret || !secret.hasValue) return { kind: 'missing' };
  const ids = p.members.map((m) => m.agentId);
  const granted = secret.grant === 'all' ? ids.length : secret.grant === 'agents' ? ids.filter((a) => secret.agents.includes(a)).length : 0;
  return { kind: 'granted', granted, members: ids.length, secret };
}

/**
 * « Recently refused » of one workspace: only at the effective level Allowed hosts (only the proxy records refusals),
 * without the hosts the list in effect allows now (allowed since). Newest first, as the API sends them.
 */
export function refusedFor(p: Project, m: ProjectMember, all: NetworkRefusal[]): NetworkRefusal[] {
  const e = effective(p, m);
  if (e.level !== 'hosts') return [];
  return all.filter((r) => r.agentId === m.agentId && !hostAllowed(r.host, e.hosts));
}

/**
 * What « Allow » changes: the list in effect, the agent's own when it has one, else the project's. The patch adds the
 * host to that list.
 */
export function allowPatch(p: Project, m: ProjectMember, host: string): { target: 'agent'; hosts: string[] } | { target: 'project'; hosts: string[] } {
  const e = effective(p, m);
  const hosts = e.hosts.includes(host) ? e.hosts : [...e.hosts, host];
  return e.ownHosts ? { target: 'agent', hosts } : { target: 'project', hosts };
}

/** Pending background commands of one workspace: how many still run, and on which older level. */
export function pendingFor(m: ProjectMember, pending: NetworkPending[]): { count: number; level: NetworkLevel } | null {
  const rows = pending.filter((x) => x.agentId === m.agentId);
  if (!rows.length) return null;
  return { count: rows.reduce((n, r) => n + r.count, 0), level: rows[0]!.level };
}

/**
 * The project row's « Change pending »: background commands of members that follow the project's default level,
 * which a change of the project's default caused. Null when none.
 */
export function projectPending(p: Project, pending: NetworkPending[]): number | null {
  const n = p.members.filter((m) => m.network === null).reduce((sum, m) => sum + (pendingFor(m, pending)?.count ?? 0), 0);
  return n || null;
}

/** « 2 background commands », « 1 background command ». */
export const commands = (n: number) => `${n} background command${n === 1 ? '' : 's'}`;
