import { describe, expect, it, onTestFinished } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NetworkPending, NetworkRefusal, SandboxStatus } from '@atlas/shared';
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
   * #322: another command's env (granted secrets, the proxy token) and argv. A reads B's node and an unsandboxed node
   * through the raw sysctl kern.procargs2 (what `ps` would show), lists them with pgrep and signals them: all refused.
   * Its own child stays readable and killable.
   */
  it.skipIf(!mac)('A cannot read the env or argv of B or of the host through kern.procargs2, nor list them (pgrep) or signal them; its own child it can (#322)', async () => {
    const dataDir = dataDirUnderHome();
    const wsA = join(dataDir, 'workspaces', 'a');
    const wsB = join(dataDir, 'workspaces', 'b');
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    const sandbox = new Sandbox({ enabled: true, dataDir, enginePort: () => null });
    expect(await sandbox.probe()).toMatchObject({ ok: true });
    const tag = `m322x${process.pid}x${Date.now() % 100000}`;
    const SECRET = 'ghp_FAKE_322_secret_value';
    const scope = (agentId: string, workspace: string) => ({ sandbox, projectId: 'p', projectName: 'P', agentId, workspace });
    const wait = `node -e "setTimeout(() => {}, 60000)" ${tag}`;
    const b = spawnAgentCommand({ cwd: wsB, env: { PATH: process.env.PATH, GH_TOKEN: SECRET }, sandbox: scope('b', wsB) }, `${wait}-b`);
    const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', `${tag}-host`], { env: { PATH: process.env.PATH, GH_TOKEN: SECRET }, stdio: 'ignore' });
    onTestFinished(() => {
      for (const [pid, group] of [[b.pid, true], [host.pid, false]] as const) {
        try {
          process.kill(group ? -pid! : pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    });
    const pidOf = (pattern: string) => {
      try {
        return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').map(Number);
      } catch {
        return [];
      }
    };
    // B's node itself (not its bash or sandbox-exec, whose command lines also hold the tag): the line starts with node.
    const nodeOf = (suffix: string) => pidOf(`^[^ ]*node -e setTimeout.* ${tag}-${suffix}$`);
    await eventually(() => expect(nodeOf('b')).toHaveLength(1), { timeout: 20_000, what: "B's node running" });
    await eventually(() => expect(nodeOf('host')).toHaveLength(1), { timeout: 20_000, what: 'the host node running' });
    const [bPid] = nodeOf('b');
    const [hostPid] = nodeOf('host');
    // The reader: raw sysctl {CTL_KERN, KERN_PROCARGS2, pid}; prints "read" + whether the secret is there, or the errno.
    writeFileSync(
      join(wsA, 'procargs.py'),
      [
        'import ctypes, sys',
        'libc = ctypes.CDLL(None, use_errno=True)',
        'pid = int(sys.argv[1])',
        'mib = (ctypes.c_int * 3)(1, 49, pid)',
        'size = ctypes.c_size_t(1 << 20)',
        'buf = ctypes.create_string_buffer(1 << 20)',
        'if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) == 0:',
        `    print("read", ${JSON.stringify(SECRET)}.encode() in buf.raw[: size.value], ${JSON.stringify(tag)}.encode() in buf.raw[: size.value])`,
        'else:',
        '    print("errno", ctypes.get_errno())',
      ].join('\n') + '\n',
    );
    const steps = [
      `echo "== b"; python3 procargs.py ${bPid}`,
      `echo "== host"; python3 procargs.py ${hostPid}`,
      `echo "== pgrep"; pgrep -lf ${tag} 2>&1; echo "exit=$?"`,
      `echo "== kill-b"; kill -0 ${bPid} 2>&1; echo "exit=$?"`,
      `echo "== kill-host"; kill -0 ${hostPid} 2>&1; echo "exit=$?"`,
      `echo "== own"; ${wait}-own & sleep 1; python3 procargs.py $!; kill $! && echo killed`,
      `echo "== nohup"; nohup sh -c 'echo nohup-ok' > nohup.txt 2>&1 & wait $!; echo "exit=$?"; cat nohup.txt`,
      'echo "== end"',
    ].join('\n');
    const a = spawnAgentCommand({ cwd: wsA, env: { PATH: process.env.PATH, GH_TOKEN: 'ghp_FAKE_322_own_value' }, sandbox: scope('a', wsA) }, steps);
    let out = '';
    a.stdout!.on('data', (d: Buffer) => (out += d));
    a.stderr!.on('data', (d: Buffer) => (out += d));
    await new Promise((r) => a.on('close', r));
    if (process.env.SBX_DEBUG) console.log(out);
    const section = (name: string) => out.split(`== ${name}\n`)[1]!.split('\n== ')[0]!;
    expect(out).not.toContain(SECRET);
    expect(section('b')).toBe('errno 1');
    expect(section('host')).toBe('errno 1');
    expect(section('pgrep')).not.toContain(String(bPid));
    expect(section('pgrep')).toContain('exit=3'); // « Cannot get process list »: sysmond is denied
    expect(section('kill-b')).toMatch(/Operation not permitted[\s\S]*exit=1/);
    expect(section('kill-host')).toMatch(/Operation not permitted[\s\S]*exit=1/);
    expect(section('own')).toMatch(/^read False True\n[\s\S]*killed/); // its own child: readable (its own env, not B's secret), killable
    expect(section('nohup')).toMatch(/exit=0\nnohup-ok$/); // the sandbox's nohup (macOS's asks launchd, refused)
    expect(nodeOf('b')).toEqual([bPid]); // B and the host are still running
    expect(nodeOf('host')).toEqual([hostPid]);
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

  /**
   * #308, Settings → Workspaces: what the page's controls send (PATCH of one member) changes what that agent's shell
   * reaches from its next command, while a background command started before keeps its level and shows as pending
   * until it ends. Reaches example.com and www.wikipedia.org.
   */
  it('Settings → Workspaces: one workspace set to Off, then Allowed hosts, from its next command; a running background command is « change pending » until it ends', async () => {
    const dataDir = dataDirUnderHome();
    const probe = [
      `echo "== allowed"; curl -s -o /dev/null -m 20 -w "code=%{http_code}/%{http_connect}" https://example.com/; echo " exit=$?"`,
      `echo "== other"; curl -s -o /dev/null -m 20 -w "code=%{http_code}/%{http_connect}" https://www.wikipedia.org/; echo " exit=$?"`,
      'echo "== end"',
    ].join('\n');
    const marker = join(dataDir, 'workspaces', 'atlas', 'bg-started');
    const l = await launch({
      dataDir,
      dispatch: false,
      env: {},
      password: LOGIN,
      sandbox: { enabled: true },
      script: [
        () => tool('bg', { command: `touch bg-started; sleep 120`, background: true }),
        text('started'),
        () => tool('off', { command: probe, timeout_s: 120 }),
        text('done'),
        () => tool('hosts', { command: probe, timeout_s: 120 }),
        text('done'),
      ],
    });
    const pid = l.engine.projects.list()[0]!.id;
    const run = async (title: string) => {
      const card = l.engine.kanban.create({ title, assignee: 'atlas' }, 'user');
      l.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
      l.engine.runner.wake(card.id);
      await l.engine.runner.settled(card.id);
      const out = results(l.fake.calls.at(-1)!)[0]!;
      return (name: string) => out.split(`== ${name}\n`)[1]!.split('\n== ')[0]!;
    };
    const pending = async () => (await l.call<NetworkPending[]>('GET', `/projects/${pid}/pending`)).body;

    // A background command at the project default (On).
    await run('background at On');
    await eventually(() => expect(existsSync(marker)).toBe(true), { timeout: 30_000, what: 'the background command started' });
    expect(await pending()).toEqual([]);

    // The workspace alone set to Off: its next command reaches nothing; the running one keeps On and is pending.
    expect((await l.call('PATCH', `/projects/${pid}/members/atlas`, { network: 'off' })).status).toBe(200);
    expect(await pending()).toEqual([{ agentId: 'atlas', level: 'on', count: 1 }]);
    const off = await run('off');
    expect(off('allowed')).not.toMatch(/code=(200|301|302)/);
    expect(off('other')).not.toMatch(/code=(200|301|302)/);

    // Its own Allowed hosts (the project stays On): the listed host only; the refusal is offered in Settings.
    expect((await l.call('PATCH', `/projects/${pid}/members/atlas`, { network: 'hosts', allowedHosts: ['example.com'] })).status).toBe(200);
    expect(l.engine.network.setting(pid, 'atlas')).toEqual({ level: 'hosts', hosts: ['example.com'] });
    const hosts = await run('hosts');
    expect(hosts('allowed')).toContain('code=200');
    expect(hosts('other')).toMatch(/code=000\/403/);
    const refusals = (await l.call<NetworkRefusal[]>('GET', `/projects/${pid}/refusals`)).body;
    expect(refusals).toEqual([expect.objectContaining({ agentId: 'atlas', host: 'www.wikipedia.org' })]);

    // Back to the project default (On): the background command's level again, nothing pending.
    await l.call('PATCH', `/projects/${pid}/members/atlas`, { network: null });
    expect(await pending()).toEqual([]);
    await l.call('PATCH', `/projects/${pid}`, { network: 'off' });
    expect(await pending()).toEqual([{ agentId: 'atlas', level: 'on', count: 1 }]);
    // It ends: nothing pending any more.
    const bgId = (l.engine.db.prepare("SELECT id FROM background_processes WHERE status = 'running'").get() as { id: string }).id;
    l.engine.runner.background.kill(bgId, 'atlas');
    await eventually(async () => expect(await pending()).toEqual([]), { timeout: 20_000, what: 'the background command ended' });
  }, 300_000);
});
