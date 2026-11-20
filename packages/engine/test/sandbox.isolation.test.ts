import { describe, expect, it, onTestFinished } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NetworkRefusal, SandboxStatus } from '@atlas/shared';
import { eventually, launch } from './kit/index.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import { Sandbox, spawnAgentCommand } from '../src/sandbox.ts';

/**
 * #298 S1 + S2, the real sandbox (slow project): sandbox-exec on macOS, bubblewrap on Linux (CI job `sandbox-linux`,
 * ubuntu-24.04). Agent A's commands, whatever path they take, cannot read or change agent B's workspace, the home
 * folder, the database or the shared /tmp; on macOS also the keychain, LaunchServices and the engine API (on Linux the
 * engine port is reachable at network level On, so the engine runs with its login there: S3). Judged by B's marker
 * content and A's captured output, never by exit codes.
 */
const LOGIN = 'sandbox-test-login';

const mac = process.platform === 'darwin';
const linux = process.platform === 'linux';
/** How a denial reads: Seatbelt refuses (EPERM); under bwrap the path does not exist (ENOENT) or is read-only. */
const DENIED = mac ? /Operation not permitted/ : /No such file or directory|Read-only file system|Permission denied/;
const tool = (id: string, input: Record<string, unknown>, name = 'shell'): ContentBlock[] => [{ type: 'tool_use', id, name, input }];
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const results = (req: ModelRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));

/** A data dir under the real home (as Atlas's is), so the home rules are the real ones. */
function dataDirUnderHome(): string {
  const base = mac ? join(homedir(), 'Library', 'Caches') : join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  const d = mkdtempSync(join(base, 'atlas-sbx-test-'));
  onTestFinished(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const LSOPEN_C = `#include <CoreServices/CoreServices.h>
#include <stdio.h>
#include <string.h>
int main(int c, char **v) {
  CFURLRef u = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)v[1], strlen(v[1]), true);
  printf("LSOpen=%d\\n", (int)LSOpenCFURLRef(u, NULL));
  return 0;
}
`;

describe.skipIf(!mac && !linux)(`sandbox with the real ${mac ? 'sandbox-exec' : 'bwrap'} (#298 S1, S2)`, () => {
  it('probe on this machine: ok, or (SBX_EXPECT_USERNS_BLOCKED=1: stock Ubuntu 24.04) the user-namespace restriction and its fix', async () => {
    const st = await new Sandbox({ enabled: true, dataDir: dataDirUnderHome(), enginePort: () => null }).probe();
    if (process.env.SBX_EXPECT_USERNS_BLOCKED === '1') {
      expect(st).toMatchObject({ enabled: true, kind: 'bwrap', ok: false });
      expect(st.reason).toContain('kernel.apparmor_restrict_unprivileged_userns=1');
      expect(st.reason).toContain('docs/server-sandbox.md');
    } else expect(st).toMatchObject({ enabled: true, ok: true, reason: null });
  });

  it('A cannot read or change B: shell, python child, & grandchild, nohup, symlinks old and new, hardlink, LSOpen of an .app (macOS); nor home, ~/.ssh, atlas.db, keychain (macOS), /tmp, docker, the engine port (macOS), the engine process (Linux)', async () => {
    const dataDir = dataDirUnderHome();
    const wsA = join(dataDir, 'workspaces', 'atlas');
    const wsB = join(dataDir, 'workspaces', 'b', 'clone');
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    const SECRET_B = 'B-MARKER-7f3a9c';
    const markerB = join(wsB, 'marker.txt');
    writeFileSync(markerB, SECRET_B + '\n');
    const homeMarker = join(dataDir, '..', `atlas-sbx-home-${process.pid}.txt`); // under ~/Library/Caches, outside the data dir
    writeFileSync(homeMarker, 'HOME-MARKER-51d2\n');
    onTestFinished(() => rmSync(homeMarker, { force: true }));
    writeFileSync(join(dataDir, 'atlas.db'), 'DB-MARKER-88e1\n');
    const tmpDir = mkdtempSync(mac ? '/private/tmp/atlas-sbx-' : '/tmp/atlas-sbx-');
    onTestFinished(() => rmSync(tmpDir, { recursive: true, force: true }));
    writeFileSync(join(tmpDir, 'm.txt'), 'TMP-MARKER-0c4b\n');
    symlinkSync(markerB, join(wsA, 'old-link')); // a symlink that was already there
    writeFileSync(join(wsA, 'lsopen.c'), LSOPEN_C);
    const py = JSON.stringify(markerB);
    writeFileSync(join(wsA, 'child.py'), `for mode in ('r', 'a'):\n    try:\n        with open(${py}, mode) as f:\n            print(f.read() if mode == 'r' else f.write('python-was-here'))\n    except Exception as e:\n        print('python:', e)\n`);

    const q = (s: string) => `'${s}'`;
    const B = q(markerB);
    const steps = [
      `echo "== shell"; cat ${B}; echo shell-was-here >> ${B}`,
      `echo "== python"; python3 child.py`,
      `echo "== grandchild"; bash -c "cat ${B} > gc.txt 2>&1; echo gc-was-here >> ${B}" & wait $!; cat gc.txt`,
      `echo "== nohup"; nohup bash -c "cat ${B}; echo nohup-was-here >> ${B}" > nohup.txt 2>&1; cat nohup.txt`,
      `echo "== old symlink"; cat old-link; echo old-link-was-here >> old-link`,
      `echo "== new symlink"; ln -s ${B} new-link; cat new-link; echo new-link-was-here >> new-link`,
      `echo "== hardlink"; ln ${B} hard-link; cat hard-link; echo hard-was-here >> hard-link`,
      // An .app built in A, opened through LaunchServices, would run outside the sandbox: it must not start.
      ...(mac
        ? [
            `echo "== lsopen"; mkdir -p Esc.app/Contents/MacOS; printf '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>esc</string><key>CFBundleIdentifier</key><string>dev.atlas.sbxtest.esc${process.pid}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>' > Esc.app/Contents/Info.plist; printf '#!/bin/sh\\necho lsopen-was-here >> ${markerB}\\n' > Esc.app/Contents/MacOS/esc; chmod +x Esc.app/Contents/MacOS/esc; cc -o lsopen lsopen.c -framework CoreServices && ./lsopen "$PWD/Esc.app"`,
          ]
        : []),
      `echo "== home"; cat ${q(homeMarker)}; ls ~/.ssh "$HOME/../.ssh" ${q(join(homedir(), '.ssh'))}`,
      `echo "== db"; cat ${q(join(dataDir, 'atlas.db'))}; cat ${q(join(homedir(), 'Library/Application Support/Atlas/data/atlas.db'))} | head -c 64`,
      ...(mac ? [`echo "== keychain"; security dump-keychain 2>&1 | head -5`] : []),
      `echo "== tmp"; cat ${q(join(tmpDir, 'm.txt'))}; echo tmp-was-here > /tmp/atlas-sbx-${process.pid}.txt; ls /tmp/atlas-sbx-${process.pid}.txt`,
      `echo "== docker"; curl -s -m 5 --unix-socket /var/run/docker.sock http://localhost/_ping; echo "docker=$?"`,
      ...(mac ? [`echo "== port"; curl -s -m 5 "$ENGINE/api/health"; echo "curl=$?"`] : []),
      // Linux: its own pid namespace; the engine's process (its command line, environment) is out of sight.
      ...(linux ? [`echo "== proc"; cat /proc/${process.pid}/cmdline; cat /proc/${process.pid}/environ; echo "pids=$(ls /proc | grep -cE '^[0-9]+$')"`] : []),
      `echo "== own"; echo own > own.txt && cat own.txt; echo tmp-own > "$TMPDIR/x" && cat "$TMPDIR/x"; echo "home=$HOME"`,
    ];
    let engineUrl = '';
    const l = await launch({
      dataDir,
      dispatch: false,
      env: {},
      sandbox: { enabled: true },
      password: LOGIN, // Linux, level On: the engine port is reachable, so the engine needs its login (#298 S3)
      script: [() => tool('u1', { command: `export ENGINE=${engineUrl}\n${steps.join('\n')}`, timeout_s: 600 }), text('done')],
    });
    engineUrl = l.engine.url;
    expect((await l.call<SandboxStatus>('GET', '/sandbox')).body).toEqual({ enabled: true, kind: mac ? 'seatbelt' : 'bwrap', ok: true, reason: null });
    const card = l.engine.kanban.create({ title: 'escape', assignee: 'atlas' }, 'user');
    l.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    l.engine.runner.wake(card.id);
    await l.engine.runner.settled(card.id);
    const out = results(l.fake.calls[1]!)[0]!;
    if (process.env.SBX_DEBUG) console.log(out);
    const section = (name: string) => out.split(`== ${name}\n`)[1]!.split('\n== ')[0]!;

    // B's marker: never read, never changed, by any route.
    expect(readFileSync(markerB, 'utf8')).toBe(SECRET_B + '\n');
    for (const secret of [SECRET_B, 'HOME-MARKER-51d2', 'DB-MARKER-88e1', 'TMP-MARKER-0c4b']) expect(out).not.toContain(secret);
    for (const s of ['shell', 'grandchild', 'nohup', 'old symlink', 'new symlink', 'hardlink', 'home', 'db', 'tmp']) expect(section(s), s).toMatch(DENIED);
    expect(section('python')).toMatch(/python: \[Errno (1|2|13|30)\] (Operation not permitted|No such file or directory|Permission denied|Read-only file system)/);
    // The shared /tmp: nothing written there from inside reached the real one.
    expect(existsSync(`/tmp/atlas-sbx-${process.pid}.txt`)).toBe(false);
    expect(section('docker')).not.toContain('OK');
    if (mac) {
      // LaunchServices refused the open (a non-zero OSStatus): the .app never ran, so nothing ran outside the sandbox.
      expect(section('lsopen')).toMatch(/LSOpen=-\d+/);
      expect(section('keychain')).not.toMatch(/class: |keychain: "/);
      expect(section('port')).not.toContain('"ok"');
      expect(section('port')).toMatch(/curl=(7|28)/);
    }
    if (linux) {
      expect(section('proc')).toContain('No such file or directory');
      expect(section('proc')).not.toMatch(/vitest|node/);
      expect(Number(/pids=(\d+)/.exec(section('proc'))![1])).toBeLessThan(10);
    }
    // Its own workspace and private TMPDIR work, HOME is the workspace.
    expect(section('own')).toContain('own\ntmp-own\n');
    expect(section('own')).toContain(`home=${wsA}`);
  }, 300_000);

  it('git push in the sandbox: an ssh remote goes over https; without GH_TOKEN the §1.5 message, no prompt; with it the token is sent', async () => {
    const dataDir = dataDirUnderHome();
    const repo = 'git@github.com:csoylu/atlas-sandbox-test-does-not-exist.git';
    const push = `git init -q r && cd r && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m x && git push ${repo} HEAD:main 2>&1; echo "push-done"`;
    const l = await launch({
      dataDir,
      dispatch: false,
      env: {},
      sandbox: { enabled: true },
      password: LOGIN,
      script: [
        tool('u1', { command: `unset GH_TOKEN; ${push}`, timeout_s: 120 }),
        tool('u2', { command: `rm -rf r; export GH_TOKEN=ghp_atlasSandboxTestFakeToken000000000000; ${push}`, timeout_s: 120 }),
        text('done'),
      ],
    });
    const card = l.engine.kanban.create({ title: 'push', assignee: 'atlas' }, 'user');
    l.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    l.engine.runner.wake(card.id);
    await l.engine.runner.settled(card.id);
    const [without, withToken] = [results(l.fake.calls[1]!)[0]!, results(l.fake.calls[2]!)[0]!];
    if (process.env.SBX_DEBUG) console.log(without, withToken);
    expect(without).toContain('GH_TOKEN is not granted to you in project');
    expect(without).toContain('terminal prompts disabled');
    expect(without).toContain('push-done'); // it ended by itself: nothing waited for a password
    expect(without).not.toMatch(/Permission denied \(publickey\)|ssh:/); // https, not ssh
    expect(withToken).not.toContain('GH_TOKEN is not granted');
    expect(withToken).toMatch(/Authentication failed for 'https:\/\/github\.com\/csoylu\/atlas-sandbox-test-does-not-exist/);
    expect(withToken).toContain('push-done');
  }, 300_000);

  it('killing a command kills all of it: its children and a & grandchild end with it', async () => {
    const dataDir = dataDirUnderHome();
    const ws = join(dataDir, 'workspaces', 'k');
    mkdirSync(ws, { recursive: true });
    const sandbox = new Sandbox({ enabled: true, dataDir, enginePort: () => null });
    expect(await sandbox.probe()).toMatchObject({ ok: true });
    const tag = `${process.pid}.${Date.now() % 1000}`;
    const child = spawnAgentCommand({ cwd: ws, env: { PATH: process.env.PATH }, sandbox: { sandbox, projectId: 'p', projectName: 'P', agentId: 'k', workspace: ws } }, `sleep 3${tag} & (sleep 3${tag} &) ; sleep 3${tag}`);
    const count = () => {
      try {
        return execFileSync('pgrep', ['-f', `sleep 3${tag}`], { encoding: 'utf8' }).trim().split('\n').length;
      } catch {
        return 0;
      }
    };
    await eventually(() => expect(count()).toBeGreaterThanOrEqual(3), { timeout: 20_000, what: 'three sleeps running' }); // + the shell's (and bwrap's) own command line
    process.kill(-child.pid!, 'SIGTERM');
    await eventually(() => expect(count()).toBe(0), { timeout: 20_000, what: 'every sleep gone after the kill' });
  }, 60_000);

  /**
   * #298 S3: the matrix of §4. Each level × {curl allowed host, curl other host, direct --noproxy, DNS, UDP, the agent's
   * own localhost server, the engine port, node fetch, git ls-remote}; a refusal in the API; after a restart the levels
   * and the proxy come back. Reaches example.com, www.wikipedia.org and github.com.
   */
  it('internet levels On / Allowed hosts / Off, the whole matrix; refusals in the API; levels and proxy back after a restart', async () => {
    const dataDir = dataDirUnderHome();
    const dbFile = join(dataDir, 'atlas.db');
    const port = 40000 + (process.pid % 20000);
    let engine = '';
    const steps = () =>
      [
        `export ENGINE=${engine}`,
        `echo "== allowed"; curl -s -o /dev/null -m 20 -w "code=%{http_code}/%{http_connect}" https://example.com/; echo " exit=$?"`,
        `echo "== other"; curl -s -o /dev/null -m 20 -w "code=%{http_code}/%{http_connect}" https://www.wikipedia.org/; echo " exit=$?"`,
        `echo "== direct"; curl -s -o /dev/null -m 20 --noproxy '*' -w "code=%{http_code}" https://example.com/; echo " exit=$?"`,
        `echo "== dns"; python3 -c "import socket; print('dns', socket.gethostbyname('example.com'))" 2>&1 | tail -1`,
        `echo "== udp"; python3 -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.sendto(b'x', ('1.1.1.1', 53)); print('udp-sent')" 2>&1 | tail -1`,
        `echo "== own"; python3 -m http.server ${port} --bind 127.0.0.1 >/dev/null 2>&1 & S=$!; for i in $(seq 50); do curl -s --noproxy '*' -o /dev/null http://127.0.0.1:${port}/ && break; sleep 0.1; done; curl -s --noproxy '*' -o /dev/null -w "code=%{http_code}" http://127.0.0.1:${port}/; echo; { kill $S; wait $S; } 2>/dev/null`,
        `echo "== engine"; curl -s -o /dev/null -m 10 --noproxy '*' -w "code=%{http_code}" "$ENGINE/api/agents"; echo " exit=$?"`,
        `echo "== engine-proxy"; curl -s -o /dev/null -m 10 -w "code=%{http_code}" "$ENGINE/api/agents"; echo " exit=$?"`,
        `echo "== node"; node -e "fetch('https://example.com/').then((r) => console.log('node', r.status), (e) => console.log('node-err', e.cause?.code ?? e.message))"`,
        `echo "== git"; git ls-remote https://github.com/git/git HEAD 2>&1 | tail -1; echo "exit=$?"`,
        `echo "== ps"; ps eww -p $$ 2>&1 | tail -1`,
        'echo "== end"',
      ].join('\n');
    const run = async (l: Awaited<ReturnType<typeof launch>>, title: string) => {
      const card = l.engine.kanban.create({ title, assignee: 'atlas' }, 'user');
      l.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
      l.engine.runner.wake(card.id);
      await l.engine.runner.settled(card.id);
      const out = results(l.fake.calls.at(-1)!)[0]!;
      if (process.env.SBX_DEBUG) console.log(title, out);
      return (name: string) => out.split(`== ${name}\n`)[1]!.split('\n== ')[0]!;
    };
    const turn = () => [() => tool('u', { command: steps(), timeout_s: 300 }), text('done')];
    const l = await launch({ dataDir, dbFile, dispatch: false, env: {}, password: LOGIN, sandbox: { enabled: true }, script: [...turn(), ...turn(), ...turn()] });
    engine = l.engine.url;
    const pid = l.engine.projects.list()[0]!.id;
    expect((await l.call('PATCH', `/projects/${pid}`, { allowedHosts: ['example.com', 'github.com'] })).status).toBe(200);

    // On: everything goes out; the engine port is still denied on macOS, needs the login on Linux.
    const on = await run(l, 'on');
    expect(on('allowed')).toContain('code=200');
    expect(on('other')).toMatch(/code=(200|301|302)/);
    expect(on('direct')).toContain('code=200');
    expect(on('dns')).toMatch(/^dns \d+\.\d+/);
    expect(on('udp')).toContain('udp-sent');
    expect(on('own')).toContain('code=200');
    expect(on('engine')).toMatch(mac ? /code=000 exit=(7|28)/ : /code=401/);
    expect(on('node')).toContain('node 200');
    expect(on('git')).toMatch(/\tHEAD/);

    // Allowed hosts: through the proxy only, the listed hosts only.
    await l.call('PATCH', `/projects/${pid}`, { network: 'hosts' });
    const hosts = await run(l, 'hosts');
    expect(hosts('allowed')).toContain('code=200');
    expect(hosts('other')).toMatch(/code=000\/403/);
    expect(hosts('direct')).not.toContain('code=200');
    expect(hosts('dns')).not.toMatch(/^dns \d/);
    expect(hosts('udp')).not.toContain('udp-sent');
    expect(hosts('own')).toContain('code=200');
    expect(hosts('engine')).toMatch(/code=000 exit=(7|28)/);
    expect(hosts('engine-proxy')).not.toMatch(/code=(200|401)/); // the proxy never reaches a local address
    expect(hosts('node')).toContain('node 200');
    expect(hosts('git')).toMatch(/\tHEAD/);
    const refusals = (await l.call<NetworkRefusal[]>('GET', `/projects/${pid}/refusals`)).body;
    expect(refusals).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: 'atlas', host: 'www.wikipedia.org' })]));

    // Off, set on the workspace over the project's Allowed hosts: nothing out, its own localhost server still works.
    await l.call('PATCH', `/projects/${pid}/members/atlas`, { network: 'off' });
    const off = await run(l, 'off');
    for (const k of ['allowed', 'other', 'direct']) expect(off(k)).not.toMatch(/code=(200|301|302)/);
    expect(off('dns')).not.toMatch(/^dns \d/);
    expect(off('udp')).not.toContain('udp-sent');
    expect(off('own')).toContain('code=200');
    expect(off('engine')).toMatch(/code=000 exit=(7|28)/);
    expect(off('node')).toContain('node-err');
    expect(off('git')).not.toMatch(/\tHEAD/);
    // `ps` cannot read another process's environment from the sandbox: it does not run at all on macOS (setuid,
    // refused by Seatbelt); on Linux the pid namespace shows only the sandbox's own processes.
    if (mac) expect(off('ps')).toContain('Operation not permitted');
    await l.engine.stop();

    // Restart on the same database: the levels are kept and the proxy is back.
    const l2 = await launch({ dataDir, dbFile, dispatch: false, env: {}, password: LOGIN, sandbox: { enabled: true }, script: turn() });
    engine = l2.engine.url;
    expect(l2.engine.network.setting(pid, 'atlas')).toEqual({ level: 'off', hosts: ['example.com', 'github.com'] });
    await l2.call('PATCH', `/projects/${pid}/members/atlas`, { network: null });
    const back = await run(l2, 'after restart');
    expect(back('allowed')).toContain('code=200');
    expect(back('other')).toMatch(/code=000\/403/);
  }, 600_000);
});

