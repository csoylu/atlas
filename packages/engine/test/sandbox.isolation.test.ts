import { describe, expect, it, onTestFinished } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, SandboxStatus } from '@atlas/shared';
import { eventually, launch } from './kit/index.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import { Sandbox, spawnAgentCommand } from '../src/sandbox.ts';

/**
 * #298 S1 + S2, the real sandbox (slow project): sandbox-exec on macOS, bubblewrap on Linux (CI job `sandbox-linux`,
 * ubuntu-24.04). Agent A's commands, whatever path they take, cannot read or change agent B's workspace, the home
 * folder, the database or the shared /tmp; on macOS also the keychain, LaunchServices and the engine API (on Linux the
 * engine port is reachable at network level On: S3). Judged by B's marker content and A's captured output, never by
 * exit codes.
 */

const mac = process.platform === 'darwin';
const linux = process.platform === 'linux';
/** How a denial reads: Seatbelt refuses (EPERM); under bwrap the path does not exist (ENOENT) or is read-only. */
const DENIED = mac ? /Operation not permitted/ : /No such file or directory|Read-only file system|Permission denied/;
const tool = (id: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id, name: 'shell', input }];
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
});

