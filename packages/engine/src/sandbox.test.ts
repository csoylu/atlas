import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBlock, SandboxStatus } from '@atlas/shared';
import { launch } from '../test/kit/index.ts';
import type { ModelRequest } from './providers/types.ts';
import { gitEnv, Sandbox, SandboxUnavailable, seatbeltProfile, spawnAgentCommand } from './sandbox.ts';
import { spawnCommand } from './workflowCommand.ts';

/** #298 S1: one way to spawn an agent command, the Seatbelt profile, the git credential env, fail closed. */

const here = dirname(fileURLToPath(import.meta.url));
const tool = (id: string, name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id, name, input }];
const results = (req: ModelRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

/** A stand-in for sandbox-exec: drops `-p <profile>`, writes the profile next to itself, runs the rest unconfined. */
function fakeSandboxExec(): { bin: string; profile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-sbx-fake-'));
  const bin = join(dir, 'sandbox-exec');
  const profile = join(dir, 'last.sb');
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = -p ] || exit 64\nprintf '%s' "$2" > '${profile}'\nshift 2\nexec "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, profile };
}

describe('sandbox (#298 S1)', () => {
  it('no agent command is spawned anywhere but spawnAgentCommand: a test fails on any other shell spawn in engine/src', () => {
    // The engine's own processes (the login-shell PATH read, the updater's swap helper) are not agent commands.
    const own = new Set(['sandbox.ts', 'shellEnv.ts', 'updater.ts']);
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !own.has(e.name)) {
          readFileSync(p, 'utf8')
            .split('\n')
            .forEach((line, n) => {
              if (/shell:\s*(true|['"`])/.test(line) || /spawn(Sync)?\(\s*['"`](\/bin\/|\/usr\/bin\/)?(ba|z)?sh['"`]/.test(line) || /execSync\(/.test(line))
                bad.push(`${p.slice(here.length + 1)}:${n + 1}: ${line.trim()}`);
            });
        }
      }
    };
    walk(here);
    expect(bad).toEqual([]);
  });

  it('the profile denies home, data, shared tmp, keychain, LaunchServices, docker and the engine port; re-allows the workspace last', () => {
    const p = seatbeltProfile({ home: '/Users/u', dataDir: '/Users/u/Library/Application Support/Atlas/data', workspace: '/Users/u/Library/Application Support/Atlas/data/workspaces/a', private: '/Users/u/Library/Application Support/Atlas/data/sandbox/p/a', enginePort: 4317, path: '/Users/u/.local/bin:/Users/u:/opt/homebrew/bin:relative' });
    expect(p).toContain('(deny file-read* (subpath "/Users/u"))');
    expect(p).toContain('(deny file-read* file-write* (subpath "/Users/u/Library/Application Support/Atlas/data"))');
    expect(p).toContain('(deny file-read* file-write* (subpath "/private/tmp") (subpath "/private/var/tmp"))');
    expect(p).toContain('(global-name "com.apple.coreservices.launchservicesd")');
    expect(p).toContain('(global-name "com.apple.SecurityServer")');
    expect(p).toContain('(deny appleevent-send)');
    expect(p).toContain('(remote unix-socket (path-literal "/private/var/run/docker.sock"))');
    expect(p).toContain('(deny network-outbound (remote ip "*:4317"))');
    // A PATH folder under home is a toolchain; home itself and relative entries are not.
    expect(p).toContain('(subpath "/Users/u/.local/bin")');
    expect(p).not.toMatch(/allow file-read\* [^\n]*\(subpath "\/Users\/u"\)/);
    expect(p).not.toContain('relative');
    // Last rule wins: the workspace and the private folder come after every file deny.
    const allowWs = p.indexOf('(allow file-read* file-write* (subpath "/Users/u/Library/Application Support/Atlas/data/workspaces/a")');
    expect(allowWs).toBeGreaterThan(p.indexOf('(deny file-write* (subpath "/"))'));
    expect(allowWs).toBeGreaterThan(p.indexOf('(deny file-read* file-write* (subpath "/Users/u/Library/Application Support/Atlas/data"))'));
    expect(p).toContain('(literal "/Users/u/Library/Application Support/Atlas/data/workspaces")'); // stat of the folders above
    // Quotes in a path cannot end the string.
    expect(seatbeltProfile({ home: '/h', dataDir: '/d', workspace: '/w"x', private: '/p', enginePort: null, path: '' })).toContain('(subpath "/w\\"x")');
  });

  it('git: ssh remotes go over https, GH_TOKEN answers github.com only, without it the message of §1.5 and no prompt', () => {
    const env = { ...process.env, ...gitEnv("Atlas", { email: 'm@example.com' }) };
    delete env.GH_TOKEN;
    const fill = (host: string, extra: NodeJS.ProcessEnv = {}) => {
      try {
        return { out: execFileSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=${host}\n\n`, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), err: '' };
      } catch (e) {
        const x = e as { stdout: string; stderr: string };
        return { out: x.stdout, err: x.stderr };
      }
    };
    const withToken = fill('github.com', { GH_TOKEN: 'ghp_test_token_123' });
    expect(withToken.out).toContain('username=x-access-token');
    expect(withToken.out).toContain('password=ghp_test_token_123');
    const without = fill('github.com');
    expect(without.out).not.toContain('password=');
    expect(without.err).toContain('GH_TOKEN is not granted to you in project Atlas: ask Master for it with task_block(kind: "capability", secret: "GH_TOKEN")');
    expect(without.err).toContain('terminal prompts disabled');
    // Another host never gets the token.
    expect(fill('example.com', { GH_TOKEN: 'ghp_test_token_123' }).out).not.toContain('ghp_test_token_123');
    const url = (u: string) => execFileSync('git', ['ls-remote', '--get-url', u], { env, encoding: 'utf8' }).trim();
    expect(url('git@github.com:csoylu/atlas.git')).toBe('https://github.com/csoylu/atlas.git');
    expect(execFileSync('git', ['config', 'user.email'], { env, encoding: 'utf8', cwd: tmpdir() }).trim()).toBe('m@example.com');
  });

  it('off (no ATLAS_SANDBOX): GET /api/sandbox says so and commands run on the host as before', async () => {
    const l = await launch({ dispatch: false, env: {}, script: [tool('u1', 'shell', { command: 'echo "home=$HOME"' }), text('done')] });
    expect((await l.call<SandboxStatus>('GET', '/sandbox')).body).toMatchObject({ enabled: false, ok: false });
    const card = l.engine.kanban.create({ title: 'off', assignee: 'atlas' }, 'user');
    l.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    l.engine.runner.wake(card.id);
    await l.engine.runner.settled(card.id);
    expect(results(l.fake.calls[1]!)[0]).toContain(`home=${process.env.HOME}`);
  });

  it('probe failure: GET /api/sandbox has the reason; shell, background shell and secret_set each stop the run with « Sandbox unavailable »', async () => {
    for (const [name, input] of [
      ['shell', { command: 'echo hi > ran.txt' }],
      ['shell', { command: 'echo hi > ran.txt', background: true }],
      ['secret_set', { name: 'X_TOKEN', command: 'echo hi > ran.txt; echo value-1234567890' }],
    ] as const) {
      const l = await launch({ dispatch: false, env: {}, sandbox: { enabled: true, platform: 'darwin', sandboxExec: '/nonexistent/sandbox-exec' }, script: [tool('u1', name, input), text('should not get here')] });
      const st = (await l.call<SandboxStatus>('GET', '/sandbox')).body;
      expect(st).toMatchObject({ enabled: true, kind: 'seatbelt', ok: false });
      expect(st.reason).toContain('/nonexistent/sandbox-exec');
      const card = l.engine.kanban.create({ title: 'probe', assignee: 'atlas' }, 'user');
      l.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
      l.engine.runner.wake(card.id);
      await l.engine.runner.settled(card.id);
      const run = l.engine.runner.runs(card.id)[0]!;
      expect(run.status).toBe('failed');
      expect(run.error).toMatch(/^Sandbox unavailable: .*\/nonexistent\/sandbox-exec.*\. Agent commands are stopped\.$/);
      expect(l.fake.calls).toHaveLength(1); // the model never got a result: the run stopped
      expect(existsSync(join(l.workdir, 'ran.txt'))).toBe(false); // never a host fallback
      expect(l.engine.runner.runs(card.id)).toHaveLength(1);
    }
  });

  it('on: the command goes through sandbox-exec with HOME = workspace, a private TMPDIR, the git env, no ssh-agent', async () => {
    const fake = fakeSandboxExec();
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock');
    vi.stubEnv('GIT_ASKPASS', '/bin/echo');
    onTestFinished(() => void vi.unstubAllEnvs());
    const l = await launch({
      dispatch: false,
      env: {},
      shellPath: 'engine',
      sandbox: { enabled: true, platform: 'darwin', sandboxExec: fake.bin },
      script: [tool('u1', 'shell', { command: 'echo "home=$HOME tmp=$TMPDIR ssh=${SSH_AUTH_SOCK:-none} askpass=${GIT_ASKPASS:-none} git=$GIT_CONFIG_COUNT prompt=$GIT_TERMINAL_PROMPT shell=$BASH_VERSION"' }), text('done')],
    });
    expect((await l.call<SandboxStatus>('GET', '/sandbox')).body).toEqual({ enabled: true, kind: 'seatbelt', ok: true, reason: null });
    const card = l.engine.kanban.create({ title: 'on', assignee: 'atlas' }, 'user');
    l.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    l.engine.runner.wake(card.id);
    await l.engine.runner.settled(card.id);
    const out = results(l.fake.calls[1]!)[0]!;
    const priv = join(l.dataDir, 'sandbox', l.engine.projects.list()[0]!.id, 'atlas');
    expect(out).toContain(`home=${l.workdir} tmp=${join(priv, 'tmp')}/ ssh=none askpass=none git=`);
    expect(out).toContain('prompt=0');
    expect(out).toMatch(/shell=\d/); // bash
    expect(existsSync(join(priv, 'tmp'))).toBe(true);
    const profile = readFileSync(fake.profile, 'utf8');
    expect(profile).toContain(`(deny network-outbound (remote ip "*:${new URL(l.engine.url).port}"))`); // the engine port
  });

  it('workflow command steps go through the same spawn: sandboxed in the project checkout folder; unavailable throws before anything runs', async () => {
    const fake = fakeSandboxExec();
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-sbx-wf-'));
    const ws = join(dataDir, 'checkouts', 'p1');
    mkdirSync(join(ws, 'runs', 'k'), { recursive: true });
    const sandbox = new Sandbox({ enabled: true, dataDir, enginePort: () => 1234, platform: 'darwin', sandboxExec: fake.bin });
    expect((await sandbox.probe()).ok).toBe(true);
    const scope = { sandbox, projectId: 'p1', projectName: 'P', agentId: 'workflow', workspace: ws };
    const r = await spawnCommand('echo "home=$HOME"', { cwd: join(ws, 'runs', 'k'), env: { PATH: process.env.PATH }, limitMs: 10_000, onSpawn: () => {}, sandbox: scope });
    expect(r.output.trim()).toBe(`home=${ws}`);
    sandbox.setUnavailable('gone');
    expect(() => spawnAgentCommand({ cwd: ws, env: {}, sandbox: scope }, 'touch x')).toThrow(SandboxUnavailable);
    expect(() => spawnAgentCommand({ cwd: ws, env: {}, sandbox: scope }, 'touch x')).toThrow('Sandbox unavailable: gone. Agent commands are stopped.');
  });

  it('Linux and Windows: no sandbox yet, the probe says why (fail closed)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-sbx-os-'));
    expect((await new Sandbox({ enabled: true, dataDir, enginePort: () => null, platform: 'linux' }).probe()).reason).toContain('bubblewrap');
    expect((await new Sandbox({ enabled: true, dataDir, enginePort: () => null, platform: 'win32' }).probe())).toMatchObject({ ok: false, reason: 'no sandbox on win32' });
  });
});
