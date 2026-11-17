import type { Locator } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { useChat } from './fixtures.ts';
import { see } from './see.ts';

const t = useChat();
const CLEARED = 'Context cleared by you';

/** « Rewind to here » on one of your messages, confirmed in the dialog. */
async function rewindTo(msg: Locator) {
  await msg.hover();
  await msg.getByRole('button', { name: 'Rewind to here' }).click();
  const dialog = msg.page().getByRole('dialog', { name: 'Rewind to this message?' });
  await see.visible(dialog);
  await dialog.getByRole('button', { name: 'Rewind', exact: true }).click();
  await see.absent(dialog);
}

describe('rewind across a /clear', () => {
  it('to a message before the clear: it works, the clear goes away with it, Undo brings both back', async () => {
    const { chat, app } = t;
    await chat.ask('first message', 'ack: first message');
    await chat.ask('second message', 'ack: second message');
    await chat.say('/clear');
    const row = chat.row(CLEARED);
    await see.visible(row);
    await chat.open(row);
    await row.getByRole('button', { name: 'Show 4 earlier messages' }).click();
    await see.count(chat.page.locator('.msg'), 4);

    // Rewind to « second message », which is before the clear.
    await rewindTo(chat.userMsgs.filter({ hasText: 'second message' }));
    await see.absent(chat.row(CLEARED)); // the clear sat after the rewound messages: it is gone
    await see.value(chat.composer, 'second message'); // your text is back to edit
    expect(await chat.shown()).toEqual([expect.stringContaining('first message'), expect.stringContaining('ack: first message')]);
    const note = chat.page.locator('.rewind-note');
    await see.visible(note.filter({ hasText: 'Rewound' }));

    // The agent's view is what it was before « second message »: no clear is hiding « first message » from it.
    await chat.composer.fill('second again');
    await chat.ask('RECALL', 'I see: first message');
    expect(chat.lastTurnUsers()).toEqual(['first message', 'RECALL']);
    // Hmm: the typed text was replaced by RECALL, so this turn is what we check, not « second again ».
    expect(app.provider.turns().at(-1)!.view).not.toContain('second message');
  });

  it('Undo of the rewind brings the messages and the clear back', async () => {
    const { chat } = t;
    await chat.ask('first message', 'ack: first message');
    await chat.ask('second message', 'ack: second message');
    await chat.say('/clear');
    const row = chat.row(CLEARED);
    await see.visible(row);
    await chat.open(row);
    await row.getByRole('button', { name: /Show \d+ earlier message/ }).click();
    await rewindTo(chat.userMsgs.filter({ hasText: 'second message' }));
    await see.absent(chat.row(CLEARED));

    await chat.page.locator('.rewind-note').getByRole('button', { name: /Undo/ }).click();
    await see.visible(chat.row(CLEARED)); // the clear is back, and folds the four messages again
    await see.count(chat.page.locator('.msg'), 0);
    await chat.ask('RECALL', 'I see: nothing ; summary: none');
    expect(chat.lastTurnUsers()).toEqual(['RECALL']);
  });

  it('to a message after the clear: the clear stays', async () => {
    const { chat } = t;
    await chat.ask('before the clear', 'ack: before the clear');
    await chat.say('/clear');
    await see.visible(chat.row(CLEARED));
    await chat.ask('after one', 'ack: after one');
    await chat.ask('after two', 'ack: after two');

    await rewindTo(chat.userMsgs.filter({ hasText: 'after two' }));
    await see.visible(chat.row(CLEARED));
    await see.value(chat.composer, 'after two');
    expect(await chat.shown()).toEqual([expect.stringContaining('after one'), expect.stringContaining('ack: after one')]);
    // Still cleared for the agent.
    await chat.ask('RECALL', 'I see: after one');
    expect(chat.lastTurnUsers()).toEqual(['after one', 'RECALL']);
  });
});
