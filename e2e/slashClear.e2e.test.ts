import { describe, expect, it } from 'vitest';
import { useChat } from './fixtures.ts';
import { see } from './see.ts';

const t = useChat();
const CLEARED = 'Context cleared by you';

describe('/clear', () => {
  it('hides the earlier messages behind a marker that expands and collapses', async () => {
    const { chat } = t;
    await chat.ask('The code word is banana', 'ack: The code word is banana');
    await chat.say('/clear');
    const row = chat.row(CLEARED);
    await see.visible(row);
    await see.visible(row.locator('.chat-row-obj').filter({ hasText: '2 earlier messages' }));
    // The chat is empty below the marker: no message is on screen.
    await see.count(chat.page.locator('.msg'), 0);
    await see.visible(chat.page.getByText('Context cleared. The agent starts fresh from your next message.'));

    // Expand: the earlier messages come back, in place.
    await chat.open(row);
    await row.getByRole('button', { name: 'Show 2 earlier messages' }).click();
    await see.count(chat.page.locator('.msg'), 2);
    expect(await chat.shown()).toEqual([expect.stringContaining('The code word is banana'), expect.stringContaining('ack: The code word is banana')]);
    // Collapse again.
    await row.getByRole('button', { name: 'Hide earlier messages' }).click();
    await see.count(chat.page.locator('.msg'), 0);

    // New messages show below the marker while the old ones stay folded.
    await chat.ask('fresh start', 'ack: fresh start');
    expect(await chat.shown()).toEqual([expect.stringContaining('fresh start'), expect.stringContaining('ack: fresh start')]);
    await see.visible(chat.row(CLEARED));
  });

  it('the agent no longer knows what was said before', async () => {
    const { chat, app } = t;
    await chat.ask('The code word is banana', 'ack: The code word is banana');
    await chat.ask('Remember the number 42', 'ack: Remember the number 42');
    await chat.say('/clear');
    await see.visible(chat.row(CLEARED));
    // Nothing went to the model for the command itself.
    expect(app.provider.turns()).toHaveLength(2);

    await chat.ask('RECALL', 'I see: nothing ; summary: none');
    const view = app.provider.turns().at(-1)!.view;
    expect(view).not.toContain('banana');
    expect(view).not.toContain('42');
    expect(chat.lastTurnUsers()).toEqual(['RECALL']);
  });

  it('also drops a summary made before it', async () => {
    const { chat, app } = t;
    await chat.ask('The code word is banana', 'ack: The code word is banana');
    await chat.say('/compact');
    await see.visible(chat.row('Compacted by you'));
    await chat.say('/clear');
    await see.visible(chat.row(CLEARED));
    await chat.ask('RECALL', 'I see: nothing ; summary: none');
    expect(app.provider.turns().at(-1)!.view).not.toContain('banana');
    // Compacting after a clear only covers what came after it.
    await chat.ask('only this one', 'ack: only this one');
    await chat.say('/compact');
    await see.count(chat.row('Compacted by you'), 1);
    const summaryCall = app.provider.calls.filter((c) => c.kind === 'summary').at(-1)!;
    expect(summaryCall.view).not.toContain('banana');
    expect(summaryCall.view).toContain('only this one');
  });

  it('nothing is deleted: history_search still finds the cleared messages', async () => {
    const { chat, app } = t;
    await chat.ask('The code word is banana', 'ack: The code word is banana');
    await chat.say('/clear');
    await see.visible(chat.row(CLEARED));
    // The transcript still has them.
    expect(app.engine.kanban.messages(chat.id).filter((m) => m.author === 'user')).toHaveLength(1);

    // The agent searches its own history (the real tool) and finds the message from before the clear.
    await chat.ask('SEARCH code word', /FOUND: .*#1 user: .*code word is banana/);
    // The model's view still held nothing of it before the search ran.
    expect(app.provider.turns()[1]!.view).not.toContain('is banana');
    // The search result is plain history, not a way back: asked again, the view is still clean.
    await chat.ask('RECALL', /I see: SEARCH code word/);
  });

  it('Undo brings the context back, until the next message', async () => {
    const { chat, app } = t;
    await chat.ask('The code word is banana', 'ack: The code word is banana');
    await chat.say('/clear');
    const row = chat.row(CLEARED);
    await see.visible(row);
    // The row opens with Undo in reach while the clear is undoable.
    await row.getByRole('button', { name: 'Undo clear' }).click();
    await see.absent(chat.row(CLEARED));
    await see.count(chat.page.locator('.msg'), 2); // the messages are back in the chat
    await chat.ask('RECALL', 'I see: The code word is banana');
    expect(chat.lastTurnUsers()).toEqual(['The code word is banana', 'RECALL']);

    // Clear again; once a message is sent, the clear can no longer be undone.
    await chat.say('/clear');
    await see.visible(chat.row(CLEARED));
    await chat.ask('after the clear', 'ack: after the clear');
    const again = chat.row(CLEARED);
    await chat.open(again);
    await see.visible(again.getByRole('button', { name: /Show \d+ earlier message/ }));
    await see.absent(again.getByRole('button', { name: 'Undo clear' }));
    const clears = (await app.api<{ clears: { id: string; undoable: boolean }[] }>('GET', `/cards/${chat.id}/timeline`)).clears;
    expect(clears.map((c) => c.undoable)).toEqual([false]);
    const r = await fetch(`${app.url}/api/clears/${clears[0]!.id}/undo`, { method: 'POST' });
    expect(r.status).toBe(409);
  });

  it('a second /clear folds everything before it; nothing to clear twice in a row', async () => {
    const { chat, app } = t;
    await chat.ask('one', 'ack: one');
    await chat.say('/clear');
    await see.count(chat.row(CLEARED), 1);
    await chat.ask('two', 'ack: two');
    await chat.say('/clear');
    // Only the latest marker shows, and everything before it is folded.
    await see.count(chat.row(CLEARED), 1);
    await see.count(chat.page.locator('.msg'), 0);
    await chat.say('/clear'); // right after a clear
    await see.visible(chat.page.getByText(/nothing to clear/i));
    app.errors.length = 0; // the browser logs the 409 as a console error: expected here
  });

  it('survives a reload of the page', async () => {
    const { chat, app } = t;
    await chat.ask('The code word is banana', 'ack: The code word is banana');
    await chat.say('/clear');
    await see.visible(chat.row(CLEARED));
    await chat.page.reload();
    await see.visible(chat.row(CLEARED));
    await see.count(chat.page.locator('.msg'), 0);
    await chat.ask('RECALL', 'I see: nothing');
    expect(app.provider.turns().at(-1)!.view).not.toContain('banana');
  });
});
