// The main-process notifier (#350): which events notify, osascript's arguments, failures. No Electron, a fake exec.
import { describe, expect, it } from 'vitest';
import { markdownToPlainText as plain, type Notification, type ServerEvent } from '@atlas/shared';
import { DesktopNotifier, noticeOf, osascriptArgs, OSASCRIPT_TIMEOUT_MS, type Exec, type Notice } from './notifier.ts';

const row: Notification = { id: 1, at: '2026-11-23T10:00:00Z', kind: 'card.blocked', title: 'Pick a source', body: '#12 needs you', cardId: 'c1', readAt: null, archivedAt: null, projectId: 'atlas', link: null };
const reply: ServerEvent = { type: 'chat.replied', chatId: 'chat1', agentId: 'munih', projectId: 'atlas', seq: 7, text: 'Done.' };
const ctx = (notifyReplies: boolean) => ({ notifyReplies, projectName: (id: string) => (id === 'atlas' ? 'Atlas' : id) });

describe('noticeOf: which engine events notify', () => {
  it('a new Inbox item, with the Inbox title', () => {
    expect(noticeOf({ type: 'notification.created', notification: row }, ctx(false))).toEqual({ title: 'Needs you · Pick a source', body: '#12 needs you' });
  });

  it('an agent reply only while « When an agent replies » is on', () => {
    expect(noticeOf(reply, ctx(true))).toEqual({ title: 'munih · Atlas', body: 'Done.', hash: '#/chat/chat1' });
    expect(noticeOf(reply, ctx(false))).toBeNull();
  });

  it('nothing for other events', () => {
    expect(noticeOf({ type: 'inbox.changed' } as ServerEvent, ctx(true))).toBeNull();
  });
});

/** Runs the script the way AppleScript would read it: the text is only ever items -2 and -1 of argv. */
function argvOf(args: string[]): { script: string[]; argv: string[] } {
  const script: string[] = [];
  let i = 0;
  while (args[i] === '-e') {
    script.push(args[i + 1]!);
    i += 2;
  }
  return { script, argv: args.slice(i) };
}

describe('osascriptArgs: agent text stays text', () => {
  const nasty = [`"; do shell script "touch /tmp/pwned"; "`, 'back\\slash \\" end', 'line one\nline two\r\nthree', `it's "quoted"`, '-e', '--', 'end run', 'nul\0byte'];

  it('the script is fixed; title and body are the last two arguments, untouched', () => {
    for (const title of nasty)
      for (const body of nasty) {
        const { script, argv } = argvOf(osascriptArgs({ title, body }));
        expect(script).toEqual(['on run argv', 'display notification (item -1 of argv) with title (item -2 of argv)', 'end run']);
        expect(argv).toEqual(['--', title.replaceAll('\0', ''), body.replaceAll('\0', '')]);
      }
  });

  it('nothing of the text is in a script line', () => {
    const args = osascriptArgs({ title: 'T"x', body: 'B"y' });
    const lines = argvOf(args).script.join('\n');
    expect(lines).not.toContain('T"x');
    expect(lines).not.toContain('B"y');
  });
});

type Call = { file: string; args: string[]; timeout: number; done: Parameters<Exec>[3] };
function kit(platform: NodeJS.Platform = 'darwin') {
  const calls: Call[] = [];
  const logs: string[] = [];
  const posted: Notice[] = [];
  const opened: string[] = [];
  let electron: Parameters<ConstructorParameters<typeof DesktopNotifier>[0]['electron']>[1] | undefined;
  const n = new DesktopNotifier({
    platform,
    exec: (file, args, opts, done) => calls.push({ file, args, timeout: opts.timeout, done }),
    electron: (notice, on) => {
      posted.push(notice);
      electron = on;
    },
    log: (line) => logs.push(line),
    open: (hash) => opened.push(hash),
  });
  return { n, calls, logs, posted, opened, electron: () => electron! };
}

describe('DesktopNotifier on a Mac: osascript', () => {
  it('one osascript call per notice, with a timeout, no shell', () => {
    const k = kit();
    k.n.show({ title: 'Needs you · X', body: 'b' });
    expect(k.calls).toHaveLength(1);
    expect(k.calls[0]).toMatchObject({ file: '/usr/bin/osascript', timeout: OSASCRIPT_TIMEOUT_MS });
    expect(k.calls[0]!.args.slice(-2)).toEqual(['Needs you · X', 'b']);
    k.calls[0]!.done(null, '', '');
    expect(k.n.status()).toEqual({ by: 'osascript', error: null });
    expect(k.logs).toEqual([]);
  });

  it('a non-zero exit: logged and shown in Settings, nothing thrown; the next success clears it', () => {
    const k = kit();
    k.n.show({ title: 't', body: 'b' });
    expect(() => k.calls[0]!.done(Object.assign(new Error('Command failed'), { code: 1 }), '', '0:5: execution error: denied (-1743)\n')).not.toThrow();
    expect(k.n.status()).toEqual({ by: 'osascript', error: 'osascript exited with code 1: 0:5: execution error: denied (-1743)' });
    expect(k.logs).toEqual(['notification not shown: osascript exited with code 1: 0:5: execution error: denied (-1743)']);
    k.n.show({ title: 't', body: 'b' });
    k.calls[1]!.done(null, '', '');
    expect(k.n.status().error).toBeNull();
  });

  it('a timeout and a missing osascript say so', () => {
    const k = kit();
    k.n.show({ title: 't', body: 'b' });
    k.calls[0]!.done(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', code: null }), '', '');
    expect(k.n.status().error).toBe('osascript did not answer within 10 s');
    k.n.show({ title: 't', body: 'b' });
    k.calls[1]!.done(Object.assign(new Error('spawn /usr/bin/osascript ENOENT'), { code: 'ENOENT' }), '', '');
    expect(k.n.status().error).toBe('osascript could not run (spawn /usr/bin/osascript ENOENT)');
  });
});

describe('plain text in banners (#363)', () => {
  it('bold, italics, strike and code markers go, the words stay', () => {
    expect(plain('I created **#362** (mine) for the __fix__, *see* _this_ and ~~not~~ `npm test`')).toBe('I created #362 (mine) for the fix, see this and not npm test');
    expect(plain('keep snake_case_name and 2*3*4')).toBe('keep snake_case_name and 2*3*4');
    expect(plain('a `a**b*c` code span')).toBe('a a**b*c code span');
  });

  it('links become their text, images their alt text', () => {
    expect(plain('See [PR #144](https://github.com/x/y/pull/144) and ![the board](shots/b.png) or <https://a.io>')).toBe('See PR #144 and the board or https://a.io');
    expect(plain('![](x.png)Done')).toBe('Done');
  });

  it('headings, quotes, lists and fences', () => {
    expect(plain('## Summary\n> quoted line\n\nChanges:\n- one\n* two\n1. three\n\n```ts\nconst x = 1;\n```\nEnd')).toBe('Summary quoted line Changes: one · two · three const x = 1; End');
  });

  it('a table loses its pipes and separator row', () => {
    expect(plain('| Task | State |\n|---|:---:|\n| #362 | done |')).toBe('Task · State #362 · done');
  });

  it('a lone task number stays, whitespace collapses', () => {
    expect(plain('#362')).toBe('#362');
    expect(plain('  #362 \n\n  needs   you\t now ')).toBe('#362 needs you now');
  });

  it('cut at about 180 characters on a word, with « … »', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const out = plain(long);
    expect(out.length).toBeLessThanOrEqual(180);
    expect(out.endsWith('…')).toBe(true);
    expect(long.startsWith(out.slice(0, -1) + ' ')).toBe(true);
    expect(plain('short')).toBe('short');
  });

  it('show() posts plain title and body, through osascript and Electron', () => {
    const mac = kit();
    mac.n.show({ title: 'munih · **Atlas**', body: 'I created **#362** (mine) for the [fix](https://x.io)' });
    expect(mac.calls[0]!.args.slice(-2)).toEqual(['munih · Atlas', 'I created #362 (mine) for the fix']);
    const other = kit('linux');
    other.n.show({ title: '# Done', body: '- a\n- b', hash: '#/chat/c' });
    expect(other.posted).toEqual([{ title: 'Done', body: 'a · b', hash: '#/chat/c' }]);
  });
});

describe('DesktopNotifier elsewhere: Electron Notification', () => {
  it('posts through Electron; `failed` is reported like an osascript failure; a click opens its place', () => {
    const k = kit('linux');
    k.n.show({ title: 'munih · Atlas', body: 'Done.', hash: '#/chat/chat1' });
    expect(k.calls).toEqual([]);
    expect(k.posted).toEqual([{ title: 'munih · Atlas', body: 'Done.', hash: '#/chat/chat1' }]);
    k.electron().click();
    expect(k.opened).toEqual(['#/chat/chat1']);
    k.electron().failed('no notification server');
    expect(k.n.status()).toEqual({ by: 'electron', error: 'no notification server' });
    expect(k.logs).toEqual(['notification not shown: no notification server']);
  });
});
