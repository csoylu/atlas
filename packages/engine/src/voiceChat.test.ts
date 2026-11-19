// VoiceChat.watch and task notes (#52, #143, #251): a task note in the voice chat wakes no agent, so the voice says the
// note itself, once, and only while Master is talking by voice there. No voice models needed (fast project).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { launch } from '../test/kit/index.ts';
import { spokenNote } from './voiceChat.ts';

const text = (t: string) => [{ type: 'text' as const, text: t }];
const host = () => ({ modelsDir: mkdtempSync(join(tmpdir(), 'vm-')), micAccess: () => 'granted' as const, requestMicAccess: async () => true });

describe('VoiceChat.watch: task notes', () => {
  it('says a task note in the voice chat once, after a voice message; never after a typed one; no agent turn', async () => {
    const t = await launch({ script: [text('Typed answer.'), text('Voice answer.')], voice: host() });
    const vc = t.engine.voiceChat!;
    const said: string[] = [];
    vc.watch((s) => said.push(s));
    const chatId = vc.id();
    const first = t.engine.kanban.create({ title: 'Typed one', status: 'todo' }, 'atlas', chatId);
    const second = t.engine.kanban.create({ title: 'Spoken one.', status: 'todo' }, 'atlas', chatId);

    await t.say(chatId, 'typed question');
    await t.idle(chatId);
    t.engine.kanban.update(first.id, { status: 'closed' }, 'atlas');
    expect(said).toEqual([]); // Master typed last: the note stays silent

    await t.say(chatId, '🎙 by voice');
    await t.idle(chatId);
    said.length = 0; // the reply to the voice message (watch hands it over: no ask() claimed it)
    t.engine.kanban.update(second.id, { status: 'closed' }, 'atlas');
    expect(said).toEqual([`Task ${second.number} is closed: Spoken one.`]);
    expect(t.engine.runner.runs(chatId)).toHaveLength(2); // the note started no run
  });

  it('a note in another chat is not said', async () => {
    const t = await launch({ script: [text('Ok.')], voice: host() });
    const vc = t.engine.voiceChat!;
    const said: string[] = [];
    vc.watch((s) => said.push(s));
    const voiceId = vc.id();
    await t.say(voiceId, '🎙 hello');
    await t.idle(voiceId);
    said.length = 0;
    const other = await t.chat();
    const card = t.engine.kanban.create({ title: 'Elsewhere', status: 'todo' }, 'atlas', other.id);
    t.engine.kanban.update(card.id, { status: 'closed' }, 'atlas');
    expect(said).toEqual([]);
  });

  it('spokenNote: one sentence per transition, no number → « a task »', () => {
    expect(spokenNote({ transition: 'done', title: 'Fix login', number: 12 })).toBe('Task 12 is finished: Fix login.');
    expect(spokenNote({ transition: 'review', title: 'Fix login', number: 12 })).toBe('Task 12 is ready for your review: Fix login.');
    expect(spokenNote({ transition: 'needs_input', title: 'Fix login?', number: 12 })).toBe('Task 12 needs your OK: Fix login.');
    expect(spokenNote({ transition: 'capability', title: 'Fix login', number: 12 })).toBe('Task 12 is blocked: Fix login.');
    expect(spokenNote({ transition: 'stopped', title: 'Fix login', number: null })).toBe('You stopped a task: Fix login.');
  });
});
