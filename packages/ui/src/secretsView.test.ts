import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import type { Account, Model, SecretInfo, SecretStoreStatus } from '@atlas/shared';
import { HiddenNote, SecretText } from './SecretMarks.tsx';
import { rehypeCaret } from './streamDraft.ts';

const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
import { agentSecrets, agoText, andList, cleanName, deleteText, grantees, hiddenNames, hiddenPill, modelKeyRow, rehypeSecrets, splitSecretMarks, storeLine, whenText } from './secretsView.ts';

const secret = (over: Partial<SecretInfo>): SecretInfo => ({
  name: 'X_KEY',
  description: '',
  kind: 'agent',
  grant: 'none',
  agents: [],
  project: null,
  hasValue: true,
  createdBy: 'user',
  createdCard: null,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  updatedBy: 'user',
  lastUsedAt: null,
  lastUsedBy: null,
  waitingCard: null,
  ...over,
});

describe('secret marks in tool output and messages', () => {
  it('splits a text around [secret NAME] and lists the names once', () => {
    const t = 'GET /api?apikey=[secret ETHERSCAN_KEY] then [secret RPC_URL] and [secret ETHERSCAN_KEY]';
    expect(splitSecretMarks(t)).toEqual(['GET /api?apikey=', { secret: 'ETHERSCAN_KEY' }, ' then ', { secret: 'RPC_URL' }, ' and ', { secret: 'ETHERSCAN_KEY' }]);
    expect(hiddenNames(t)).toEqual(['ETHERSCAN_KEY', 'RPC_URL']);
    expect(splitSecretMarks('no secret here [secret lower]')).toEqual(['no secret here [secret lower]']);
    expect(hiddenNames('plain')).toEqual([]);
  });
  it('says how many were hidden', () => {
    expect(hiddenPill(1)).toBe('1 secret hidden');
    expect(hiddenPill(3)).toBe('3 secrets hidden');
  });
  it('highlights the marks in a terminal line and names them under it', () => {
    expect(renderToStaticMarkup(createElement(SecretText, { text: 'key=[secret A_KEY] ok' }))).toBe('key=<span class="sec-redacted" title="The value of A_KEY is hidden">[secret A_KEY]</span> ok');
    expect(renderToStaticMarkup(createElement(SecretText, { text: 'nothing' }))).toBe('nothing');
    const note = renderToStaticMarkup(createElement(HiddenNote, { names: ['A_KEY', 'B_KEY'] }));
    expect(note).toContain('<span class="sec-redacted">A_KEY</span> and <span class="sec-redacted">B_KEY</span> were in this output');
  });
  it('marks them in a markdown message, inline code included, next to the streaming caret', () => {
    const html = (md: string, plugins: unknown[]) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], rehypePlugins: plugins as never }, md));
    const out = html('The chat shows [secret ETHERSCAN_KEY] there, and `[secret RPC_URL]`.', [rehypeSecrets]);
    expect(out).toContain('shows <span class="sec-redacted" title="The value of ETHERSCAN_KEY is hidden">[secret ETHERSCAN_KEY]</span> there');
    expect(out).toContain('<code><span class="sec-redacted" title="The value of RPC_URL is hidden">[secret RPC_URL]</span></code>');
    expect(html('Plain [secret] text', [rehypeSecrets])).toBe('<p>Plain [secret] text</p>');
    expect(html('a [secret B_KEY] b\u2063', [rehypeSecrets, rehypeCaret])).toContain('sec-redacted');
  });
});

describe('Settings → Secrets rows', () => {
  it('lists agent secrets by name, the ones without a value last, and no model key', () => {
    const list = [secret({ name: 'ZED' }), secret({ name: 'DUNE', hasValue: false }), secret({ name: 'ALPHA' }), secret({ name: 'ANTHROPIC_API_KEY', kind: 'model_key' })];
    expect(agentSecrets(list).map((s) => s.name)).toEqual(['ALPHA', 'ZED', 'DUNE']);
  });
  it('says who gets a secret and what Delete costs', () => {
    expect(grantees({ grant: 'all', agents: [] }, ['atlas', 'munih'])).toEqual(['atlas', 'munih']);
    expect(grantees({ grant: 'none', agents: ['munih'] }, ['atlas'])).toEqual([]);
    expect(andList(['munih', 'paris', 'zurich'])).toBe('munih, paris and zurich');
    expect(deleteText({ name: 'E', grant: 'agents', agents: ['munih', 'zurich'] })).toBe('munih and zurich lose it: $E is empty in their next commands.');
    expect(deleteText({ name: 'E', grant: 'agents', agents: ['munih'] })).toBe('munih loses it: $E is empty in their next commands.');
    expect(deleteText({ name: 'E', grant: 'none', agents: [] })).toBe('No agent has it; the value is gone for good.');
  });
  it('names a model key after its Anthropic account or the models that use it', () => {
    const accounts = [{ secret: 'ANTHROPIC_API_KEY', label: 'Work' }] as Account[];
    const models = [{ id: 'openrouter-gpt-oss', credentialEnv: 'OPENROUTER_API_KEY' }] as Model[];
    expect(modelKeyRow({ name: 'ANTHROPIC_API_KEY' }, accounts, models)).toMatchObject({ title: 'Anthropic · Work', description: 'Anthropic account 1 of 1 · Claude models', open: { hash: '#/settings/api-keys' } });
    expect(modelKeyRow({ name: 'OPENROUTER_API_KEY' }, accounts, models)).toMatchObject({ title: 'OPENROUTER_API_KEY', description: 'Key of the model « openrouter-gpt-oss »', open: { hash: '#/settings/model-list' } });
    expect(modelKeyRow({ name: 'OLD_KEY' }, accounts, models).description).toBe('No model uses this key');
  });
  it('says where values are kept and how the server file was unlocked', () => {
    const now = new Date('2026-11-18T15:00:00');
    const st = (o: Partial<SecretStoreStatus>): SecretStoreStatus => ({ kind: 'file', exists: true, locked: false, since: null, source: null, error: null, ...o });
    expect(storeLine('macOS Keychain', st({ kind: 'keychain' }))).toBe('Encrypted with the macOS Keychain');
    expect(storeLine(null, st({ source: 'ui', since: new Date('2026-11-18T09:12:00').toISOString() }), now)).toBe(`unlocked by you today ${hm('2026-11-18T09:12:00')}`);
    expect(storeLine(null, st({ source: 'env' }), now)).toBe('unlocked at start by ATLAS_SECRETS_PASSWORD');
    expect(storeLine(null, st({ kind: 'env' }))).toMatch(/no secret store/);
  });
  it('writes dates the short way', () => {
    const now = new Date('2026-11-18T15:00:00');
    expect(whenText(new Date('2026-11-18T09:40:00').toISOString(), now)).toBe(`today ${hm('2026-11-18T09:40:00')}`);
    expect(whenText(new Date('2026-11-17T20:00:00').toISOString(), now)).toBe('yesterday');
    expect(agoText(new Date('2026-11-18T14:46:00').toISOString(), now)).toBe('14 min ago');
    expect(agoText(new Date('2026-11-18T13:00:00').toISOString(), now)).toBe('2 h ago');
    expect(agoText(new Date('2026-11-18T14:59:30').toISOString(), now)).toBe('just now');
  });
  it('cleans a typed name to A-Z, 0-9 and _', () => {
    expect(cleanName('dune api-key!')).toBe('DUNE_API_KEY');
  });
});
