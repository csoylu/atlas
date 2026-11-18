import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { agentEnv, resolveShellPath } from './shellEnv.ts';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import type { ModelRequest } from './providers/types.ts';

const LOGIN_PATH = '/login/bin:/usr/bin:/bin';

/** A fake login shell: chatty rc files, then runs the command with LOGIN_PATH (like zsh -ilc after .zshrc). */
function fakeShell(body = `echo "welcome banner"; PATH='${LOGIN_PATH}'; eval "$2"`): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-shell-'));
  const sh = join(dir, 'loginsh');
  writeFileSync(sh, `#!/bin/sh\n${body}\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe('resolveShellPath', () => {
  it("reads the login shell's PATH between the marks, ignoring what rc files print", async () => {
    const shell = fakeShell();
    expect(await resolveShellPath({ mode: 'login', shell, platform: 'darwin' })).toEqual({ path: LOGIN_PATH, source: 'login', shell, error: null });
  });

  it("starts the login shell from the system PATH, not the engine's (like a new terminal)", async () => {
    const shell = fakeShell('eval "$2"');
    const r = await resolveShellPath({ mode: 'login', shell, env: { PATH: '/engine/node_modules/.bin:/usr/bin' }, platform: 'darwin' });
    expect(r).toMatchObject({ path: '/usr/bin:/bin:/usr/sbin:/sbin', source: 'login' });
  });

  it("server mode and Windows keep the engine's PATH", async () => {
    expect(await resolveShellPath({ mode: 'engine', env: { PATH: '/engine' } })).toEqual({ path: '/engine', source: 'engine', shell: null, error: null });
    expect(await resolveShellPath({ mode: 'login', env: { PATH: '/engine', SHELL: '/bin/zsh' }, platform: 'win32' })).toMatchObject({ path: '/engine', error: null });
  });

  it('fails loudly: the error is reported and the engine PATH is used', async () => {
    const env = { PATH: '/engine' };
    expect(await resolveShellPath({ mode: 'login', env, platform: 'darwin' })).toEqual({ path: '/engine', source: 'engine', shell: null, error: '$SHELL is not set' });
    expect(await resolveShellPath({ mode: 'login', env, shell: '/nope/zsh', platform: 'darwin' })).toMatchObject({ source: 'engine', shell: '/nope/zsh', error: expect.stringMatching(/ENOENT/) });
    expect(await resolveShellPath({ mode: 'login', env, shell: fakeShell('exit 3'), platform: 'darwin' })).toMatchObject({ source: 'engine', error: expect.stringMatching(/exited with 3/) });
    const slow = await resolveShellPath({ mode: 'login', env, shell: fakeShell('/bin/sleep 10'), platform: 'darwin', timeoutMs: 300 });
    expect(slow).toMatchObject({ path: '/engine', source: 'engine', error: expect.stringMatching(/took more than 0.3s/) });
  });
});

describe('agentEnv', () => {
  it('sets PATH and the git names, keeps the rest (email included)', () => {
    const env = agentEnv({ HOME: '/h', PATH: '/old', GIT_AUTHOR_EMAIL: 'me@x' }, '/new', 'munih');
    expect(env).toEqual({ HOME: '/h', PATH: '/new', GIT_AUTHOR_EMAIL: 'me@x', GIT_AUTHOR_NAME: 'munih', GIT_COMMITTER_NAME: 'munih' });
  });

  it('a git commit made with it carries the agent name and the configured email', () => {
    const repo = mkdtempSync(join(tmpdir(), 'atlas-git-'));
    const git = (args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.name', 'Can Soylu']);
    git(['config', 'user.email', 'can@example.com']);
    git(['commit', '-q', '--allow-empty', '-m', 'by the agent'], agentEnv(process.env, process.env.PATH ?? '', 'munih'));
    git(['commit', '-q', '--allow-empty', '-m', 'by the user']);
    expect(git(['log', '--format=%an <%ae> | %cn <%ce> | %s']).trim().split('\n')).toEqual([
      'Can Soylu <can@example.com> | Can Soylu <can@example.com> | by the user',
      'munih <can@example.com> | munih <can@example.com> | by the agent',
    ]);
  });
});

describe('agent shells in the engine', () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
  const lastText = (req: ModelRequest) =>
    req.messages.at(-1)!.content.flatMap((b) => (b.type === 'text' ? [b.text] : b.type === 'tool_result' ? [b.content] : [])).join('\n');

  it('foreground and background commands get the login PATH and the agent as git author; About reports it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const shell = fakeShell();
    const probe = 'printf "%s|%s|%s" "$PATH" "$GIT_AUTHOR_NAME" "$GIT_COMMITTER_NAME"';
    let bgLog = '';
    const fake = new FakeProvider([
      [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: probe } }],
      [{ type: 'tool_use', id: 't2', name: 'shell', input: { command: `${probe} > bg.txt`, background: true } }],
      (req) => {
        bgLog = lastText(req);
        return text('done');
      },
      text('noted'),
    ]);
    engine = await startEngine({ dbFile: ':memory:', dataDir, port: 0, dispatch: false, providers: () => fake, env: {}, shellPath: { mode: 'login', shell, platform: 'darwin' } });
    const card = engine.kanban.create({ title: 'env', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    expect(lastText(fake.calls[1]!)).toBe(`exit 0\n${LOGIN_PATH}|atlas|atlas`);
    expect(bgLog).toMatch(/started bg_/);
    const workdir = engine.agents.get('atlas')!.workdir ?? join(dataDir, 'workspaces/atlas');
    const end = Date.now() + 5000;
    let bg = '';
    while (Date.now() < end && !bg) {
      try {
        bg = readFileSync(join(workdir, 'bg.txt'), 'utf8');
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    expect(bg).toBe(`${LOGIN_PATH}|atlas|atlas`);

    const about = (await (await fetch(`${engine.url}/api/about`)).json()) as { shellPath: unknown };
    expect(about.shellPath).toEqual({ path: LOGIN_PATH, source: 'login', shell, error: null });
  });
});
