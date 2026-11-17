import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { looksSecret, parseReply, REVIEW_EVERY } from './memoryReview.ts';
import { FakeProvider } from './providers/fake.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input });
const start = (fake: FakeProvider) =>
  startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, providers: () => fake, env: {} });

describe('background memory review (v3)', () => {
  it('reviews a finished task: applies allowed changes as review:<agent>, never the user’s own or secrets', async () => {
    let review = '';
    const fake = new FakeProvider([
      [use('task_complete', { summary: 'Deployed with pnpm.' })],
      (req) => {
        review = (req.messages[0]!.content[0] as { text: string }).text;
        return text(
          '```json\n' +
            JSON.stringify({
              changes: [
                { action: 'add', kind: 'fact', scope: 'agent', text: 'The project deploys with pnpm, not npm.' },
                { action: 'update', id: `m1`, text: 'overwritten by the review' },
                { action: 'add', kind: 'fact', scope: 'shared', text: 'api_key = sk-abcdefghijklmnopqrstuv' },
              ],
            }) +
            '\n```',
        );
      },
    ]);
    const e = (engine = await start(fake));
    const mine = e.memories.add({ kind: 'preference', scope: 'agent:atlas', text: 'Short answers.' }, 'user');
    expect(mine.id).toBe(1);
    const card = e.kanban.create({ title: 'Deploy', assignee: 'atlas', status: 'running' }, 'user');
    e.kanban.appendMessage(card.id, 'user', 'user', text('deploy it, we use pnpm'));
    e.runner.wake(card.id, { kind: 'work' });
    await e.runner.settled(card.id);
    await e.review.idle;
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.tools).toEqual([]);
    expect(fake.calls[1]!.system).toContain('Most conversations need no change');
    expect(review).toContain('[m1 · preference · agent · by ');
    expect(review).toContain('deploy it, we use pnpm');
    const all = e.memories.list();
    expect(all.find((m) => m.id === 1)!.text).toBe('Short answers.');
    const added = all.find((m) => m.text.includes('pnpm'))!;
    expect(added).toMatchObject({ scope: 'agent:atlas', kind: 'fact', updatedBy: 'review:atlas', sourceConversationId: card.conversationId });
    expect(all.some((m) => m.text.includes('sk-'))).toBe(false);
    expect(e.kanban.lastEventAt(card.id, 'memory_reviewed')).not.toBeNull();
    // Reviewed once: the same transcript is not read again.
    expect(await e.review.review(card.id)).toEqual([]);
    expect(fake.calls).toHaveLength(2);
  });

  it('a chat is reviewed every REVIEW_EVERY messages; the agent hears of it in a [memory] note; off = no call', async () => {
    const replies = Array.from({ length: 40 }, () => text('ok'));
    let reviews = 0;
    const fake = new FakeProvider(
      replies.map((r) => (req) => {
        if (req.tools.length) return r;
        reviews++;
        return text('{"changes":[{"action":"add","kind":"preference","scope":"agent","text":"Master likes Turkish replies."}]}');
      }),
    );
    const e = (engine = await start(fake));
    const chat = e.kanban.newChat('atlas');
    const say = async (t: string) => {
      e.kanban.appendMessage(chat.id, 'user', 'user', text(t));
      e.runner.wake(chat.id);
      await e.runner.settled(chat.id);
      await e.review.idle;
    };
    for (let i = 0; i < REVIEW_EVERY / 2 - 1; i++) await say('hi ' + i);
    expect(reviews).toBe(0);
    await say('last');
    expect(reviews).toBe(1);
    await say('next');
    const note = e.kanban.messages(chat.id).find((m) => m.author === 'system' && JSON.stringify(m.content).includes('[memory]'));
    expect(JSON.stringify(note?.content)).toContain('added by the background review: Master likes Turkish replies.');

    e.settings.update({ memoryReviewModel: 'off' });
    for (let i = 0; i < REVIEW_EVERY / 2; i++) await say('more ' + i);
    expect(reviews).toBe(1);
  });

  it('names the user’s language from their own latest messages, even when the task has none and memories are French (#108)', async () => {
    const fake = new FakeProvider([[use('task_complete', { summary: 'Cloned.' })], text('{"changes":[]}')]);
    const e = (engine = await start(fake));
    e.memories.add({ kind: 'rule', scope: 'agent:atlas', text: 'Toujours faire git pull --rebase avant le travail, puis push.' }, 'review:atlas');
    const chat = e.kanban.newChat('atlas');
    e.kanban.appendMessage(chat.id, 'user', 'user', text('please keep the clone in sync with main'));
    // A task the agent works alone: its transcript holds no message of the user.
    const card = e.kanban.create({ title: 'Sync', assignee: 'atlas', status: 'running' }, 'atlas');
    e.kanban.appendMessage(card.id, 'user', 'system', text('This task is ready and assigned to you. Do it.'));
    e.runner.wake(card.id, { kind: 'work' });
    await e.runner.settled(card.id);
    await e.review.idle;
    const req = fake.calls[1]!;
    expect(req.tools).toEqual([]);
    const user = e.settings.user().name;
    expect(req.system).toContain(`in the language of ${user}'s own messages`);
    expect(req.system).toContain(`rewritten in ${user}'s`);
    expect(req.system).toContain('- "please keep the clone in sync with main"');
    expect(req.system).not.toMatch(/[«»]/); // no French typography to imitate
    const prompt = (req.messages[0]!.content[0] as { text: string }).text;
    expect(prompt).toContain('Toujours faire git pull');
    expect(prompt.endsWith(`Your JSON ("language" first: the language of ${user}'s own messages; every text in it):`)).toBe(true);
    expect(req.system).toContain(`{"language":"<${user}'s language>","changes":[...]}`);
  });

  it('picks the model: the setting, else a Sonnet, else the agent’s own', async () => {
    const e = (engine = await start(new FakeProvider([])));
    expect(e.review.modelFor('opus')).toBe('sonnet');
    e.settings.update({ memoryReviewModel: 'off' });
    expect(e.review.modelFor('opus')).toBeNull();
    expect(() => e.settings.update({ memoryReviewModel: 'nope' })).toThrow(/does not exist/);
  });

  it('parses the reply and spots secrets', () => {
    expect(parseReply('Sure:\n{"changes":[]}')).toEqual([]);
    expect(parseReply('{"language":"English","changes":[]}')).toEqual([]);
    expect(() => parseReply('nothing to add')).toThrow(/no JSON/);
    expect(() => parseReply('{"changes":[{"action":"add"}]}')).toThrow(/unexpected reply/);
    expect(looksSecret('token: ghp_abcdefghijklmnop1234')).toBe(true);
    expect(looksSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(looksSecret('The repo lives in ~/atlas and deploys with pnpm.')).toBe(false);
  });
});
