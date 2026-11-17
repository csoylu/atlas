import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright-core';
import { launchBrowser, startApp, type App } from './harness.ts';
import { openChat, type ChatPage } from './chat.ts';
import { see } from './see.ts';

let browser: Browser;
let app: App;
let chat: ChatPage;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  app = await startApp(browser);
  chat = await openChat(app);
});
afterEach(async () => {
  expect(app.errors).toEqual([]);
  await app.stop();
});

describe('slash popup', () => {
  it('opens only when / is the first character', async () => {
    await see.absent(chat.popup);
    await chat.composer.fill('/');
    await see.texts(chat.options, [/\/clear/, /\/compact/]);

    // A / anywhere else does nothing: not after text, not after a space, not in a path.
    for (const text of ['hello /', 'a/b', 'see /clear', ' /', 'x\n/']) {
      await chat.composer.fill(text);
      await see.absent(chat.popup, JSON.stringify(text));
    }
    // Clearing the box closes it; typing the / again reopens it.
    await chat.composer.fill('/');
    await see.visible(chat.popup);
    await chat.composer.fill('');
    await see.absent(chat.popup);
  });

  it('filters as you type', async () => {
    await chat.composer.fill('');
    await chat.composer.pressSequentially('/c');
    await see.count(chat.options, 2); // both start with c
    await chat.composer.press('o');
    await see.texts(chat.options, [/\/compact/]);
    await chat.composer.press('Backspace');
    await see.count(chat.options, 2);
    await chat.composer.fill('/cl');
    await see.texts(chat.options, [/\/clear/]);
    await chat.composer.fill('/CL'); // not case sensitive
    await see.texts(chat.options, [/\/clear/]);
    await chat.composer.fill('/zzz'); // unknown: no popup, the text stays a message
    await see.absent(chat.popup);
    await see.value(chat.composer, '/zzz');
    // Once a space follows the name (the /compact focus), the popup is out of the way.
    await chat.composer.fill('/compact ');
    await see.absent(chat.popup);
  });

  it('↑/↓ move the highlight and wrap around', async () => {
    await chat.composer.fill('/');
    await see.texts(chat.selected, [/\/clear/]);
    await chat.composer.press('ArrowDown');
    await see.texts(chat.selected, [/\/compact/]);
    await chat.composer.press('ArrowDown');
    await see.texts(chat.selected, [/\/clear/]); // wraps
    await chat.composer.press('ArrowUp');
    await see.texts(chat.selected, [/\/compact/]); // wraps back
    await chat.composer.press('ArrowUp');
    await see.texts(chat.selected, [/\/clear/]);
    // The arrows moved the highlight, not the caret out of the box or the text.
    await see.value(chat.composer, '/');
    // The mouse moves it too.
    await chat.options.nth(1).hover();
    await see.texts(chat.selected, [/\/compact/]);
  });

  it('Esc closes it and keeps the text; typing brings it back', async () => {
    await chat.composer.fill('/co');
    await see.visible(chat.popup);
    await chat.composer.press('Escape');
    await see.absent(chat.popup);
    await see.value(chat.composer, '/co');
    await chat.composer.press('m');
    await see.texts(chat.options, [/\/compact/]);
  });

  it('Enter runs the highlighted command and sends no message', async () => {
    await chat.ask('hello', 'ack: hello');
    const before = app.provider.calls.length;
    await chat.composer.fill('/');
    await chat.composer.press('Enter'); // /clear is highlighted
    await see.visible(chat.row('Context cleared by you'));
    await see.absent(chat.popup);
    await see.value(chat.composer, '');
    expect(app.provider.calls.length).toBe(before); // nothing went to the model
    const texts = app.engine.kanban.messages(chat.id).flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])));
    expect(texts.some((t) => t.includes('/clear'))).toBe(false);
  });

  it('Enter on a command typed in full runs it too, never sends it', async () => {
    await chat.ask('hello', 'ack: hello');
    await chat.say('/clear');
    await see.visible(chat.row('Context cleared by you'));
    expect(app.provider.turns()).toHaveLength(1);
    expect(app.engine.kanban.messages(chat.id).filter((m) => m.author === 'user')).toHaveLength(1);
  });

  it('Tab runs the highlighted command', async () => {
    await chat.ask('hello', 'ack: hello');
    await chat.composer.fill('/co');
    await chat.composer.press('Tab');
    await see.visible(chat.row('Compacted by you'));
    await see.value(chat.composer, '');
    expect(app.provider.turns()).toHaveLength(1);
  });

  it('↓ then Enter runs the second command', async () => {
    await chat.ask('hello', 'ack: hello');
    await chat.composer.fill('/');
    await chat.composer.press('ArrowDown');
    await chat.composer.press('Enter');
    await see.visible(chat.row('Compacted by you'));
    await see.absent(chat.row('Context cleared by you'));
  });

  it('a click on an option runs it', async () => {
    await chat.ask('hello', 'ack: hello');
    await chat.composer.fill('/');
    await chat.options.filter({ hasText: '/clear' }).click();
    await see.visible(chat.row('Context cleared by you'));
  });

  it('an unknown or malformed command is an ordinary message', async () => {
    await chat.say('/clear now please'); // /clear takes no argument
    await chat.agentMsgs.filter({ hasText: 'ack: /clear now please' }).waitFor();
    await chat.say('/foo');
    await chat.agentMsgs.filter({ hasText: 'ack: /foo' }).waitFor();
    await see.absent(chat.row('Context cleared by you'));
  });

  it('a command that cannot run says why and keeps the text', async () => {
    await chat.say('/clear'); // nothing to clear in a new chat
    await see.visible(chat.page.getByText(/nothing to clear/i));
    await see.absent(chat.row('Context cleared by you'));
    await see.value(chat.composer, '/clear');
    app.errors.length = 0; // the failed request is logged by the browser as a console error: expected here
  });
});
