import { describe, expect, it, onTestFinished } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, SandboxStatus } from '@atlas/shared';
import { launch } from './kit/index.ts';
import type { ModelRequest } from '../src/providers/types.ts';

/**
 * #298 S1 with the real sandbox-exec (slow project, macOS only): agent A's commands, whatever path they take, cannot
 * read or change agent B's workspace, Master's home, the database, the keychain, the shared /tmp or the engine API.
 * Judged by B's marker content and A's captured output, never by exit codes.
 */

const mac = process.platform === 'darwin';
const tool = (id: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id, name: 'shell', input }];
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const results = (req: ModelRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));

/** A data dir under the real home (as Atlas's is), so the home rules are the real ones. */
function dataDirUnderHome(): string {
  const base = join(homedir(), 'Library', 'Caches');
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

describe.skipIf(!mac)('sandbox with the real sandbox-exec (#298 S1)', () => {
  it('A cannot read or change B: shell, python child, & grandchild, nohup, symlinks old and new, hardlink, LSOpen of an .app; nor home, ~/.ssh, atlas.db, keychain, /tmp, the engine port', async () => {
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
    const tmpDir = mkdtempSync('/private/tmp/atlas-sbx-');
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
      `echo "== lsopen"; mkdir -p Esc.app/Contents/MacOS; printf '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>esc</string><key>CFBundleIdentifier</key><string>dev.atlas.sbxtest.esc${process.pid}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>' > Esc.app/Contents/Info.plist; printf '#!/bin/sh\\necho lsopen-was-here >> ${markerB}\\n' > Esc.app/Contents/MacOS/esc; chmod +x Esc.app/Contents/MacOS/esc; cc -o lsopen lsopen.c -framework CoreServices && ./lsopen "$PWD/Esc.app"`,
      `echo "== home"; cat ${q(homeMarker)}; ls ~/.ssh "$HOME/../.ssh" ${q(join(homedir(), '.ssh'))}`,
      `echo "== db"; cat ${q(join(dataDir, 'atlas.db'))}; cat ${q(join(homedir(), 'Library/Application Support/Atlas/data/atlas.db'))} | head -c 64`,
      `echo "== keychain"; security dump-keychain 2>&1 | head -5`,
      `echo "== tmp"; cat ${q(join(tmpDir, 'm.txt'))}; echo tmp-was-here > /tmp/atlas-sbx-${process.pid}.txt; ls /tmp/atlas-sbx-${process.pid}.txt`,
      `echo "== port"; curl -s -m 5 "$ENGINE/api/health"; echo "curl=$?"`,
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
    expect((await l.call<SandboxStatus>('GET', '/sandbox')).body).toEqual({ enabled: true, kind: 'seatbelt', ok: true, reason: null });
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
    for (const s of ['shell', 'grandchild', 'nohup', 'old symlink', 'new symlink', 'hardlink', 'home', 'db', 'tmp']) expect(section(s)).toContain('Operation not permitted');
    expect(section('python')).toMatch(/python: \[Errno 1\] Operation not permitted/);
    // LaunchServices refused the open (a non-zero OSStatus): the .app never ran, so nothing ran outside the sandbox.
    expect(section('lsopen')).toMatch(/LSOpen=-\d+/);
    expect(section('keychain')).not.toMatch(/class: |keychain: "/);
    expect(section('port')).not.toContain('"ok"');
    expect(section('port')).toMatch(/curl=(7|28)/);
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
});

