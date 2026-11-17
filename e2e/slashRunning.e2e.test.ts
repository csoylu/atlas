import { describe, expect, it } from 'vitest';
import { useChat } from './fixtures.ts';
import { see } from './see.ts';

const t = useChat();

/** Start a turn that never ends by itself, and wait until the page shows it working. */
async function startHang(chat: typeof t.chat) {
  await chat.say('HANG on a long job');
  await see.visible(chat.page.getByText('working…'));
  await expect.poll(() => chat.app.engine.runner.current(chat.id), { timeout: 8000 }).not.toBeNull();
}

describe('a command while the agent is running', () => {
  it('/clear stops the run first (not a rewind), then clears', async () => {
    const { chat, app } = t;
    await startHang(chat);
    await chat.say('/clear');

    const row = chat.row('Context cleared by you');
    await see.visible(row);
    // The run is over and was stopped by the user, as Stop does.
    expect(app.engine.runner.current(chat.id)).toBeNull();
    const runs = app.engine.runner.runs(chat.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'stopped', error: 'stopped by you' });
    // Not a rewind: your message is still in the transcript, the timeline has no rewind, the box is empty.
    expect(app.engine.kanban.messages(chat.id).some((m) => m.author === 'user')).toBe(true);
    const tl = await app.api<{ rewinds: unknown[] }>('GET', `/cards/${chat.id}/timeline`);
    expect(tl.rewinds).toEqual([]);
    await see.value(chat.composer, '');
    await see.absent(chat.page.locator('.rewind-note'));
    // The message is behind the marker, and the next turn does not know it.
    await see.count(chat.page.locator('.msg'), 0);
    await chat.open(row);
    await row.getByRole('button', { name: /Show \d+ earlier message/ }).click();
    await see.visible(chat.page.locator('.msg.user').filter({ hasText: 'HANG on a long job' }));
    await chat.ask('RECALL', 'I see: nothing ; summary: none');
    expect(app.provider.turns().at(-1)!.view).not.toContain('long job');
  });

  it('/compact stops the run first (not a rewind), then summarizes', async () => {
    const { chat, app } = t;
    await startHang(chat);
    await chat.say('/compact focus on the job');

    const row = chat.row('Compacted by you');
    await see.visible(row);
    expect(app.engine.runner.current(chat.id)).toBeNull();
    expect(app.engine.runner.runs(chat.id).find((r) => r.status === 'stopped')).toMatchObject({ error: 'stopped by you' });
    // Not a rewind: the message stays in the chat and nothing was put back in the box.
    await see.visible(chat.page.locator('.msg.user').filter({ hasText: 'HANG on a long job' }));
    await see.value(chat.composer, '');
    // The summary was written after the stop, so it covers the stopped turn.
    const summaryCall = app.provider.calls.filter((c) => c.kind === 'summary');
    expect(summaryCall).toHaveLength(1);
    expect(summaryCall[0]!.view).toContain('HANG on a long job');
    expect(summaryCall[0]!.view).toContain('focus on the job');
    await chat.open(row);
    await see.visible(row.locator('.chat-row-body').filter({ hasText: 'SUMMARY[focus=focus on the job] HANG on a long job' }));
    // The agent carries on from the summary when you write next.
    await chat.ask('RECALL', 'summary: SUMMARY[focus=focus on the job]');
  });

  // Found by this suite: compactNow's finally woke the agent, and the message the stop left unanswered was owed a turn, so
  // the job you just stopped started again by itself (fixed in 7ed9267).
  it('/compact does not restart the run it just stopped', async () => {
    const { chat, app } = t;
    await startHang(chat);
    await chat.say('/compact');
    await see.visible(chat.row('Compacted by you'));
    await chat.page.waitForTimeout(1000); // time for a stray wake to start a run
    expect(app.engine.runner.runs(chat.id)).toHaveLength(1);
    expect(app.provider.turns()).toHaveLength(1);
    await see.absent(chat.page.locator('.msg.assistant'));
  });

  it('the agent answers normally afterwards (the stop left it healthy)', async () => {
    const { chat } = t;
    await startHang(chat);
    await chat.say('/clear');
    await see.visible(chat.row('Context cleared by you'));
    await chat.ask('are you there', 'ack: are you there');
    await see.visible(chat.page.locator('.msg.user').filter({ hasText: 'are you there' }));
  });
});
