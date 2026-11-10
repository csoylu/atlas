import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inside, runTool, toolSpecs } from './tools.ts';

const ctx = () => ({ workdir: mkdtempSync(join(tmpdir(), 'atlas-tools-')), signal: new AbortController().signal });

describe('tools', () => {
  it('keeps paths inside the workdir', () => {
    expect(inside('/w', 'a/b.txt')).toBe('/w/a/b.txt');
    expect(() => inside('/w', '../etc/passwd')).toThrow(/outside/);
    expect(() => inside('/w', '/etc/passwd')).toThrow(/outside/);
  });

  it('writes, edits, reads and lists files', async () => {
    const c = ctx();
    expect((await runTool('write_file', { path: 'src/a.txt', content: 'hello world' }, c)).isError).toBe(false);
    expect((await runTool('edit_file', { path: 'src/a.txt', old_text: 'world', new_text: 'there' }, c)).isError).toBe(false);
    expect(await runTool('read_file', { path: 'src/a.txt' }, c)).toEqual({ output: 'hello there', isError: false });
    expect((await runTool('list_files', {}, c)).output).toBe('src/\nsrc/a.txt');
  });

  it('returns errors to the model instead of throwing', async () => {
    const c = ctx();
    writeFileSync(join(c.workdir, 'x'), 'aa');
    expect(await runTool('edit_file', { path: 'x', old_text: 'a', new_text: 'b' }, c)).toMatchObject({ isError: true });
    expect(await runTool('read_file', { path: '../x' }, c)).toMatchObject({ isError: true });
    expect(await runTool('nope', {}, c)).toEqual({ output: 'unknown tool nope', isError: true });
    expect(await runTool('read_file', {}, c)).toMatchObject({ isError: true });
  });

  it('runs shell commands in the workdir with exit codes', async () => {
    const c = ctx();
    const r = await runTool('shell', { command: 'pwd && exit 3' }, c);
    expect(r.output).toMatch(/^exit 3\n/);
    expect(r.output).toContain(c.workdir.split('/').pop());
  });

  it('describes every tool with a JSON schema', () => {
    const specs = toolSpecs();
    expect(specs.map((s) => s.name)).toEqual(['read_file', 'write_file', 'edit_file', 'list_files', 'shell']);
    expect(specs[0]!.input_schema).toMatchObject({ type: 'object', required: ['path'] });
  });
});
