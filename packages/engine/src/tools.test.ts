import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inside, landedLines, numberedPage, runTool, toolSpecs, type ToolContext } from './tools.ts';
import { tailOf } from './runner.ts';
import { findRg, globToRegex, grep } from './search.ts';
import { lineTrimmedSpans, whitespaceNormalizedSpans } from './fuzzy.ts';
import { htmlToMarkdown } from './web.ts';

const ctx = (): ToolContext => ({
  workdir: mkdtempSync(join(tmpdir(), 'atlas-tools-')),
  outputsDir: mkdtempSync(join(tmpdir(), 'atlas-out-')),
  conversationId: 'c_' + randomUUID(),
  signal: new AbortController().signal,
});
const out = async (name: string, input: unknown, c: ToolContext) => {
  const r = await runTool(name, input, c);
  if (r.isError) throw new Error(`${name} failed: ${r.output}`);
  return r.output;
};
const err = async (name: string, input: unknown, c: ToolContext) => {
  const r = await runTool(name, input, c);
  expect(r.isError).toBe(true);
  return r.output;
};

describe('tools', () => {
  it('keeps paths inside the workdir', () => {
    expect(inside('/w', 'a/b.txt')).toBe('/w/a/b.txt');
    expect(() => inside('/w', '../etc/passwd')).toThrow(/outside/);
    expect(() => inside('/w', '/etc/passwd')).toThrow(/outside/);
  });

  it('writes, edits, reads (with line numbers) and lists files', async () => {
    const c = ctx();
    await out('write_file', { path: 'src/a.txt', content: 'hello world\nsecond\n' }, c);
    await out('edit_file', { path: 'src/a.txt', old_text: 'world', new_text: 'there' }, c);
    expect(await out('read_file', { path: 'src/a.txt' }, c)).toBe('1|hello there\n2|second');
    expect(await out('list_files', {}, c)).toBe('src/\nsrc/a.txt');
  });

  it('returns errors to the model instead of throwing', async () => {
    const c = ctx();
    writeFileSync(join(c.workdir, 'x'), 'aa');
    await out('read_file', { path: 'x' }, c);
    expect(await err('edit_file', { path: 'x', old_text: 'a', new_text: 'b' }, c)).toMatch(/found 2 times/);
    await err('read_file', { path: '../x' }, c);
    expect(await runTool('nope', {}, c)).toEqual({ output: 'unknown tool nope', isError: true });
    await err('read_file', {}, c);
  });

  it('runs shell commands in the workdir with exit codes', async () => {
    const c = ctx();
    const r = await runTool('shell', { command: 'pwd && exit 3' }, c);
    expect(r.output).toMatch(/^exit 3\n/);
    expect(r.output).toContain(c.workdir.split('/').pop());
  });

  it('describes every tool with a JSON schema', () => {
    const specs = toolSpecs();
    expect(specs.map((s) => s.name)).toEqual([
      'read_file', 'write_file', 'edit_file', 'list_files', 'grep', 'glob', 'shell', 'shell_output', 'shell_kill', 'web_fetch',
    ]);
    expect(specs[0]!.input_schema).toMatchObject({ type: 'object', required: ['path'] });
  });
});

describe('read_file paging', () => {
  it('pages by lines with a footer telling how to continue', async () => {
    const c = ctx();
    writeFileSync(join(c.workdir, 'big.txt'), Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const first = await out('read_file', { path: 'big.txt' }, c);
    expect(first.split('\n')[0]).toBe('   1|line 1');
    expect(first).toContain('2000|line 2000\n[showing lines 1–2000 of 3000; use offset=2001 to continue]');
    const next = await out('read_file', { path: 'big.txt', offset: 2001, limit: 3 }, c);
    expect(next).toBe('2001|line 2001\n2002|line 2002\n2003|line 2003\n[showing lines 2001–2003 of 3000; use offset=2004 to continue]');
    const end = await out('read_file', { path: 'big.txt', offset: 2999 }, c);
    expect(end).toBe('2999|line 2999\n3000|line 3000');
    expect(await err('read_file', { path: 'big.txt', offset: 3001 }, c)).toMatch(/past the end of the file \(3000 lines\)/);
  });

  it('caps characters on a line boundary, never cutting the tail mid-line', () => {
    const text = Array.from({ length: 300 }, (_, i) => `${i + 1}:`.padEnd(1000, 'x')).join('\n');
    const page = numberedPage(text, 1, 2000);
    expect(page.length).toBeLessThan(101_000);
    const rows = page.split('\n');
    const footer = rows.pop()!;
    expect(footer).toMatch(/^\[showing lines 1–(\d+) of 300; use offset=\d+ to continue\]$/);
    const shown = Number(/1–(\d+)/.exec(footer)![1]);
    expect(rows).toHaveLength(shown);
    expect(rows.every((r) => r.endsWith('x'))).toBe(true); // whole lines only
    expect(numberedPage('', 1, 10)).toBe('(empty file)');
  });

  it('refuses binary files and directories clearly', async () => {
    const c = ctx();
    writeFileSync(join(c.workdir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    expect(await err('read_file', { path: 'img.png' }, c)).toMatch(/binary file \(8 bytes\)/);
    mkdirSync(join(c.workdir, 'd'));
    expect(await err('read_file', { path: 'd' }, c)).toMatch(/is a directory/);
  });
});

describe('safe edits', () => {
  it('edits an unread file, but refuses a blind overwrite or an edit of a file that changed since', async () => {
    const c = ctx();
    const f = join(c.workdir, 'f.txt');
    writeFileSync(f, 'one\ntwo\n');
    // Never read here: write_file (blind overwrite) is refused, edit_file (exact old_text) is not.
    expect(await err('write_file', { path: 'f.txt', content: 'x' }, c)).toMatch(/has not been read in this conversation: read_file it first/);
    expect(await out('edit_file', { path: 'f.txt', old_text: 'one', new_text: '1' }, c)).toBe('edited f.txt');
    await out('edit_file', { path: 'f.txt', old_text: 'two', new_text: '2' }, c); // its own write counts as read
    expect(readFileSync(f, 'utf8')).toBe('1\n2\n');
    // Someone else changes it: refused until read again.
    writeFileSync(f, '1\n2\n3\n');
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(await err('edit_file', { path: 'f.txt', old_text: '3', new_text: 'three' }, c)).toMatch(/changed on disk since you last read or wrote it: read_file it first/);
    // Another conversation has its own reads: it never saw the file, so its exact edit goes through.
    await out('edit_file', { path: 'f.txt', old_text: '3', new_text: 'three' }, { ...c, conversationId: 'other' });
    // After a read, a later change on disk still blocks the edit.
    const d = { ...c, conversationId: 'reader' };
    await out('read_file', { path: 'f.txt' }, d);
    writeFileSync(f, '1\n2\nthree\nfour\n');
    utimesSync(f, new Date(), new Date(Date.now() + 10000));
    expect(await err('edit_file', { path: 'f.txt', old_text: 'four', new_text: '4' }, d)).toMatch(/changed on disk/);
    await out('read_file', { path: 'f.txt' }, c);
    await out('write_file', { path: 'f.txt', content: 'new' }, c);
    expect(readFileSync(f, 'utf8')).toBe('new');
    // New files need no read.
    await out('write_file', { path: 'g.txt', content: 'g' }, c);
  });

  it('replace_all replaces every occurrence', async () => {
    const c = ctx();
    await out('write_file', { path: 'r.txt', content: 'a-b a-b a-b' }, c);
    expect(await err('edit_file', { path: 'r.txt', old_text: 'a-b', new_text: 'c' }, c)).toMatch(/found 3 times.*replace_all/);
    expect(await out('edit_file', { path: 'r.txt', old_text: 'a-b', new_text: 'c', replace_all: true }, c)).toBe('edited r.txt (3 replacements)');
    expect(readFileSync(join(c.workdir, 'r.txt'), 'utf8')).toBe('c c c');
    expect(await err('edit_file', { path: 'r.txt', old_text: 'c', new_text: 'c' }, c)).toMatch(/identical/);
    expect(await err('edit_file', { path: 'nope.txt', old_text: 'c', new_text: 'd' }, c)).toMatch(/does not exist/);
  });

  it('falls back to line-trimmed and whitespace-normalized matching, and says so', async () => {
    const c = ctx();
    await out('write_file', { path: 'f.ts', content: 'function f() {\n  if (x) {\n    go();\n  }\n}\nconst  a =   1;\n' }, c);
    const r1 = await out('edit_file', { path: 'f.ts', old_text: 'if (x) {\ngo();\n}', new_text: '  if (y) {\n    stop();\n  }' }, c);
    expect(r1).toMatch(/line-trimmed matching/);
    const r2 = await out('edit_file', { path: 'f.ts', old_text: 'const a = 1;', new_text: 'const a = 2;' }, c);
    expect(r2).toMatch(/whitespace-normalized matching/);
    expect(readFileSync(join(c.workdir, 'f.ts'), 'utf8')).toBe('function f() {\n  if (y) {\n    stop();\n  }\n}\nconst a = 2;\n');
    expect(await err('edit_file', { path: 'f.ts', old_text: 'nothing like it', new_text: 'z' }, c)).toMatch(/not found/);
  });

  it('fuzzy spans map back to the original text', () => {
    expect(lineTrimmedSpans('a\n  b\n  c\nd', 'b\nc')).toEqual([[2, 9]]);
    const t = 'x =\t\t1;  y  = 2;';
    const [[s, e]] = whitespaceNormalizedSpans(t, 'y = 2;') as [[number, number]];
    expect(t.slice(s, e)).toBe('y  = 2;');
  });

  it('runs parallel edits of one file one after the other', async () => {
    const c = ctx();
    await out('write_file', { path: 'p.txt', content: Array.from({ length: 50 }, (_, i) => `k${i}=0`).join('\n') }, c);
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => runTool('edit_file', { path: 'p.txt', old_text: `k${i}=0`, new_text: `k${i}=1` }, c)));
    expect(rs.filter((r) => r.isError)).toEqual([]);
    expect(readFileSync(join(c.workdir, 'p.txt'), 'utf8')).toBe(Array.from({ length: 50 }, (_, i) => `k${i}=1`).join('\n'));
  });
});

describe('grep and glob', () => {
  const tree = () => {
    const c = ctx();
    const w = (p: string, s: string) => {
      mkdirSync(join(c.workdir, p, '..'), { recursive: true });
      writeFileSync(join(c.workdir, p), s);
    };
    w('src/a.ts', 'import x\nconst needle = 1;\nexport {}\n');
    w('src/deep/b.tsx', 'needle\nother\nNEEDLE\n');
    w('notes.md', 'no match here\n');
    w('node_modules/pkg/index.js', 'needle\n');
    w('.git/config', 'needle\n');
    return c;
  };
  // The rg backend runs when ripgrep is installed (PATH, Homebrew, or a copy unpacked in /tmp for this test).
  const tmpRg = '/tmp/ripgrep-14.1.1-aarch64-apple-darwin/rg';
  const rg = findRg() ?? (existsSync(tmpRg) ? tmpRg : null);
  const backends: [string, string | null][] = [['js', null], ...(rg ? [['ripgrep', rg] as [string, string]] : [])];

  for (const [name, bin] of backends)
    it(`searches with the ${name} backend: content, files, count, glob, context; skips node_modules and .git`, async () => {
      const c = tree();
      const g = (o: Partial<Parameters<typeof grep>[0]>) =>
        grep({ pattern: 'needle', root: c.workdir, base: c.workdir, mode: 'content', limit: 100, ...o }, bin);
      expect((await g({})).split('\n').sort()).toEqual(['src/a.ts:2:const needle = 1;', 'src/deep/b.tsx:1:needle']);
      expect((await g({ ignoreCase: true, mode: 'files' })).split('\n').sort()).toEqual(['src/a.ts', 'src/deep/b.tsx']);
      expect((await g({ ignoreCase: true, mode: 'count' })).split('\n').sort()).toEqual(['src/a.ts:1', 'src/deep/b.tsx:2']);
      expect(await g({ glob: '*.tsx' })).toBe('src/deep/b.tsx:1:needle');
      expect(await g({ glob: '*.tsx', context: 1 })).toBe('src/deep/b.tsx:1:needle\nsrc/deep/b.tsx-2-other');
      expect(await g({ pattern: 'zzz' })).toBe('no matches');
      expect(await g({ root: join(c.workdir, 'src/a.ts') })).toBe('src/a.ts:2:const needle = 1;');
      expect(await g({ ignoreCase: true, limit: 1 })).toMatch(/\n\[2 more not shown; narrow the search or raise limit\]$/);
    });

  it('grep tool searches the workdir', async () => {
    const c = tree();
    expect((await out('grep', { pattern: 'need+le', mode: 'files' }, c)).split('\n').sort()).toEqual(['src/a.ts', 'src/deep/b.tsx']);
    await err('grep', { pattern: 'x', path: 'missing' }, c);
  });

  it('glob lists matches newest first, skipping node_modules', async () => {
    const c = tree();
    utimesSync(join(c.workdir, 'src/a.ts'), new Date(), new Date(Date.now() - 60_000));
    expect(await out('glob', { pattern: '**/*.{ts,tsx}' }, c)).toBe('src/deep/b.tsx\nsrc/a.ts');
    expect(await out('glob', { pattern: '*.js' }, c)).toBe('no files match');
    expect(await out('glob', { pattern: 'src/*.ts' }, c)).toBe('src/a.ts');
    expect(await out('glob', { pattern: '*', limit: 1 }, c)).toMatch(/\n\[2 more not shown\]$/);
  });

  it('globToRegex', () => {
    expect(globToRegex('*.ts').test('a/b/c.ts')).toBe(true);
    expect(globToRegex('src/*.ts').test('src/x/c.ts')).toBe(false);
    expect(globToRegex('src/**/*.ts').test('src/c.ts')).toBe(true);
    expect(globToRegex('src/**/*.ts').test('src/x/y/c.ts')).toBe(true);
    expect(globToRegex('file?.[jt]s').test('file1.js')).toBe(true);
  });
});

describe('shell output', () => {
  it('saves a long output to a file read_file can read, and shows the tail', async () => {
    const c = ctx();
    const r = await out('shell', { command: 'seq 1 20000' }, c);
    const path = /full output is in (\S+) \(read_file/.exec(r)![1]!;
    expect(r).toMatch(/^exit 0\n\[output is 108894 chars: showing the last 30000;/);
    expect(r.endsWith('19999\n20000\n')).toBe(true);
    expect(path.startsWith(c.outputsDir)).toBe(true);
    expect(await out('read_file', { path, offset: 5, limit: 1 }, c)).toBe('5|5\n[showing lines 5–5 of 20000; use offset=6 to continue]');
    expect((await out('grep', { pattern: '^19999$', path }, c))).toMatch(/:19999:19999$/);
  });
});

describe('web_fetch', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/page') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html><head><title>Test &amp; page</title><style>p{}</style><script>alert(1)</script></head>
          <body><nav>menu</nav><h1>Hello</h1><p>Some <b>bold</b> text with a <a href="/next">link</a>.</p>
          <ul><li>one</li><li>two</li></ul><pre>  code
  block</pre></body></html>`);
      } else if (req.url === '/long') {
        res.setHeader('content-type', 'text/plain');
        res.end('START ' + 'x'.repeat(50_000) + ' END');
      } else {
        res.statusCode = 404;
        res.end('not here');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('turns HTML into markdown-ish text', async () => {
    const c = ctx();
    const r = await out('web_fetch', { url: `${base}/page` }, c);
    expect(r).toBe(
      `URL: ${base}/page\nTitle: Test & page\n\n# Hello\n\nSome **bold** text with a [link](${base}/next).\n\n- one\n- two\n\n\`\`\`\n  code\n  block\n\`\`\``,
    );
  });

  it('shows head and tail of a long page and saves the full text', async () => {
    const c = ctx();
    const r = await out('web_fetch', { url: `${base}/long`, max_chars: 2000 }, c);
    expect(r.startsWith(`URL: ${base}/long\n\nSTART xxx`)).toBe(true);
    expect(r.endsWith('xxx END')).toBe(true);
    const path = /in (\S+): read_file it/.exec(r)![1]!;
    expect(readFileSync(path, 'utf8')).toContain(' END');
    expect(r.length).toBeLessThan(2400);
  });

  it('reports HTTP errors and bad URLs', async () => {
    const c = ctx();
    expect(await err('web_fetch', { url: `${base}/missing` }, c)).toBe(`HTTP 404 from ${base}/missing: not here`);
    expect(await err('web_fetch', { url: 'file:///etc/passwd' }, c)).toMatch(/only http/);
  });

  it('htmlToMarkdown keeps the main content and decodes entities', () => {
    const body = 'x'.repeat(300);
    expect(htmlToMarkdown(`<header>site</header><main><p>${body} &eacute;&#233;&#xe9;</p></main><aside>ads</aside>`).text).toBe(`${body} &eacute;éé`);
  });
});

describe('chat details (#63)', () => {
  it('landedLines: the line each replacement starts on, shifted by earlier replacements', () => {
    const text = 'a\nX\nb\nc\nX\nd';
    const spans: [number, number][] = [[2, 3], [8, 9]];
    expect(landedLines(text, spans, 'X')).toEqual([2, 5]);
    expect(landedLines(text, spans, 'Y\nY\nY')).toEqual([2, 7]);
    expect(landedLines('X', [[0, 1]], 'Z')).toEqual([1]);
    // A multi-line span removed before the next one.
    expect(landedLines('A\nB\nC\nA\nB', [[0, 3], [6, 9]], 'Q')).toEqual([1, 3]);
  });

  it('tailOf keeps the last lines', () => {
    expect(tailOf('1\n2\n3\n', 2)).toBe('2\n3');
    expect(tailOf('1\n2\npart', 2)).toBe('2\npart');
  });
});
