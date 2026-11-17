import { describe, expect, it } from 'vitest';
import { useChat } from './fixtures.ts';
import { see } from './see.ts';

const t = useChat();

describe('/compact', () => {
  it('without a focus: a « Compacted by you » row, and the next turn sees the summary', async () => {
    const { chat, app } = t;
    await chat.ask('The launch date is 12 March', 'ack: The launch date is 12 March');
    await chat.ask('The budget is 40k', 'ack: The budget is 40k');

    await chat.say('/compact');
    const row = chat.row('Compacted by you');
    await see.visible(row);
    await see.visible(row.locator('.chat-row-meta, .chat-row-obj').filter({ hasText: '4 messages → 1 summary' }));

    // The summary can be read: it was written from the whole conversation, without a focus.
    await chat.open(row);
    await see.visible(row.locator('.chat-row-body').filter({ hasText: 'SUMMARY[focus=none] The launch date is 12 March / The budget is 40k' }));
    expect(app.provider.calls.filter((c) => c.kind === 'summary')).toHaveLength(1);
    // The composer is empty and the command was not sent as a message.
    await see.value(chat.composer, '');
    expect(app.provider.turns()).toHaveLength(2);

    // The next turn: the agent gets the summary instead of the four messages.
    await chat.ask('RECALL', 'I see: nothing ; summary: SUMMARY[focus=none] The launch date is 12 March / The budget is 40k');
    const users = chat.lastTurnUsers();
    expect(users.some((u) => u.startsWith('Summary of the earlier part'))).toBe(true);
    expect(users).not.toContain('The launch date is 12 March');
    expect(users).not.toContain('The budget is 40k');
    expect(users).toContain('RECALL');
    // The chat itself still shows all its messages (compacting hides nothing).
    expect(await chat.shown()).toEqual(expect.arrayContaining([expect.stringContaining('The launch date is 12 March'), expect.stringContaining('The budget is 40k')]));
  });

  it('with a focus: the summarizer is told, and the summary follows it', async () => {
    const { chat, app } = t;
    await chat.ask('We compared two vendors', 'ack: We compared two vendors');

    await chat.say('/compact keep the pricing decision');
    const row = chat.row('Compacted by you');
    await see.visible(row);
    const summaryCall = app.provider.calls.find((c) => c.kind === 'summary')!;
    expect(summaryCall.view).toContain('keep the pricing decision');
    await chat.open(row);
    await see.visible(row.locator('.chat-row-body').filter({ hasText: 'SUMMARY[focus=keep the pricing decision] We compared two vendors' }));

    await chat.ask('RECALL', 'summary: SUMMARY[focus=keep the pricing decision]');
    expect(chat.lastTurnUsers().join('\n')).toContain('SUMMARY[focus=keep the pricing decision]');
  });

  it('compacts again later: the new summary covers the old one and what came after', async () => {
    const { chat, app } = t;
    await chat.ask('first topic', 'ack: first topic');
    await chat.say('/compact');
    await see.visible(chat.row('Compacted by you'));
    await chat.ask('second topic', 'ack: second topic');
    await chat.say('/compact');
    await see.count(chat.page.locator('.chat-row-line', { hasText: 'Compacted by you' }), 1); // one summary point, moved forward
    const second = app.provider.calls.filter((c) => c.kind === 'summary').at(-1)!;
    expect(second.view).toContain('Summary so far');
    expect(second.view).toContain('SUMMARY[focus=none] first topic');
    expect(second.view).toContain('second topic');
  });

  it('nothing to compact: says so, keeps the text, writes no summary', async () => {
    const { chat, app } = t;
    await chat.say('/compact');
    await see.visible(chat.page.getByText(/nothing to compact/i));
    await see.absent(chat.row('Compacted by you'));
    await see.value(chat.composer, '/compact');
    expect(app.provider.calls.filter((c) => c.kind === 'summary')).toHaveLength(0);
    app.errors.length = 0; // the browser logs the 409 as a console error: expected here
  });
});
