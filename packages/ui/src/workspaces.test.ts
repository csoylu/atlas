import { describe, expect, it } from 'vitest';
import type { Project, ProjectMember, SecretInfo } from '@atlas/shared';
import { allowPatch, effective, gitAccess, pendingFor, projectPending, refusedFor, workspacePath } from './workspaces.ts';

const member = (agentId: string, o: Partial<ProjectMember> = {}): ProjectMember =>
  ({ agentId, network: null, allowedHosts: null, workspace: null, home: false, cloneState: 'ready', cloneError: null, cloneProgress: null, mainChat: null, joinedAt: 'now', branch: null, ...o }) as ProjectMember;
const project = (o: Partial<Project> = {}): Project =>
  ({ id: 'p1', name: 'Datinel', repo: 'datinel/datinel', network: 'hosts', allowedHosts: ['github.com'], members: [member('a'), member('b')], ...o }) as Project;
const secret = (o: Partial<SecretInfo> = {}): SecretInfo => ({ name: 'GH_TOKEN', kind: 'agent', grant: 'all', agents: [], project: null, hasValue: true, ...o }) as SecretInfo;

describe('Settings → Workspaces (#308)', () => {
  it('the level and list in effect: own level over the default, own hosts replace the list, an empty own list is the project\'s', () => {
    const p = project();
    expect(effective(p, member('a'))).toEqual({ level: 'hosts', hosts: ['github.com'], ownHosts: false });
    expect(effective(p, member('a', { network: 'off' }))).toMatchObject({ level: 'off' });
    expect(effective(p, member('a', { allowedHosts: ['x.io'] }))).toEqual({ level: 'hosts', hosts: ['x.io'], ownHosts: true });
    expect(effective(p, member('a', { allowedHosts: [] }))).toMatchObject({ hosts: ['github.com'], ownHosts: false });
  });

  it('git access: no repo, no GH_TOKEN (or no value, or another project\'s), else granted N of M', () => {
    expect(gitAccess(project({ repo: null }), [secret()])).toEqual({ kind: 'norepo' });
    expect(gitAccess(project(), [])).toEqual({ kind: 'missing' });
    expect(gitAccess(project(), [secret({ hasValue: false })])).toEqual({ kind: 'missing' });
    expect(gitAccess(project(), [secret({ project: 'other' })])).toEqual({ kind: 'missing' });
    expect(gitAccess(project(), [secret()])).toMatchObject({ kind: 'granted', granted: 2, members: 2 });
    expect(gitAccess(project(), [secret({ project: 'p1', grant: 'agents', agents: ['b', 'zed'] })])).toMatchObject({ granted: 1, members: 2 });
    expect(gitAccess(project(), [secret({ grant: 'none' })])).toMatchObject({ granted: 0 });
  });

  it('recently refused: only at Allowed hosts in effect, this agent\'s, minus hosts allowed since', () => {
    const refusals = [
      { agentId: 'a', host: 'api.stripe.com', count: 4, lastAt: '2' },
      { agentId: 'a', host: 'github.com', count: 1, lastAt: '1' },
      { agentId: 'b', host: 'x.io', count: 1, lastAt: '1' },
    ];
    expect(refusedFor(project(), member('a'), refusals).map((r) => r.host)).toEqual(['api.stripe.com']);
    expect(refusedFor(project(), member('a', { network: 'on' }), refusals)).toEqual([]);
    expect(refusedFor(project({ network: 'off' }), member('a'), refusals)).toEqual([]);
  });

  it('« Allow » adds to the list in effect: the agent\'s own when it has one, else the project\'s', () => {
    expect(allowPatch(project(), member('a'), 'api.stripe.com')).toEqual({ target: 'project', hosts: ['github.com', 'api.stripe.com'] });
    expect(allowPatch(project(), member('a', { allowedHosts: ['x.io'] }), 'y.io')).toEqual({ target: 'agent', hosts: ['x.io', 'y.io'] });
  });

  it('change pending: per member; on the project row only for members following the default', () => {
    const p = project({ members: [member('a'), member('b', { network: 'off' })] });
    const pending = [
      { agentId: 'a', level: 'on' as const, count: 2 },
      { agentId: 'b', level: 'on' as const, count: 1 },
    ];
    expect(pendingFor(p.members[0]!, pending)).toEqual({ count: 2, level: 'on' });
    expect(pendingFor(member('c'), pending)).toBeNull();
    expect(projectPending(p, pending)).toBe(2);
    expect(projectPending(p, [])).toBeNull();
  });

  it('workspace path: relative to the data folder when inside it', () => {
    expect(workspacePath(member('a', { workspace: '/d/projects/p1/a' }), null, '/d')).toBe('data/projects/p1/a');
    expect(workspacePath(member('a'), '/d/workspaces/a', '/d/')).toBe('data/workspaces/a');
    expect(workspacePath(member('a'), '/elsewhere/a', '/d')).toBe('/elsewhere/a');
  });
});
