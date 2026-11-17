import type { Locator, Page } from 'playwright-core';
import { expect } from 'vitest';
import type { App } from './harness.ts';

/** What a user sees and does in one open chat. */
export class ChatPage {
  readonly composer: Locator;
  readonly popup: Locator;
  readonly options: Locator;
  readonly selected: Locator;
  readonly userMsgs: Locator;
  readonly agentMsgs: Locator;

  constructor(
    readonly app: App,
    readonly id: string,
  ) {
    const p = app.page;
    this.composer = p.locator('.composer textarea');
    this.popup = p.locator('.slash-pop');
    this.options = p.locator('.slash-op');
    this.selected = p.locator('.slash-op.on');
    this.userMsgs = p.locator('.msg.user');
    this.agentMsgs = p.locator('.msg.assistant');
  }

  get page(): Page {
    return this.app.page;
  }

  /** Type into the box and send with Enter (a slash command runs instead, see the popup). */
  async say(text: string): Promise<void> {
    await this.composer.fill(text);
    await this.composer.press('Enter');
  }

  /** Send a message and wait until the agent's reply has landed and the run is over. */
  async ask(text: string, reply: string | RegExp): Promise<void> {
    await this.say(text);
    await this.agentMsgs.filter({ hasText: reply }).last().waitFor();
    await this.idle();
  }

  /** The engine says nothing runs on this chat. */
  async idle(): Promise<void> {
    await expect.poll(() => this.app.engine.runner.current(this.id), { timeout: 10_000 }).toBeNull();
  }

  /** A system row of the chat by its verb (« Context cleared by you », « Compacted by you »…). */
  row(verb: string | RegExp): Locator {
    return this.page.locator('.chat-row', { has: this.page.locator('.chat-row-verb', { hasText: verb }) });
  }

  /** Open a row's body if it's closed. */
  async open(row: Locator): Promise<void> {
    const line = row.locator('.chat-row-line').first();
    if ((await line.getAttribute('aria-expanded')) !== 'true') await line.click();
  }

  /** The text of every message the chat shows, in order (user and agent). */
  async shown(): Promise<string[]> {
    return this.page.locator('.msg').evaluateAll((els) => els.map((e) => (e.querySelector('.msg-body') as HTMLElement).innerText.trim()));
  }

  /** The message text the model was last sent, minus the summary and todo lead-ins. */
  lastTurnUsers(): string[] {
    const turn = this.app.provider.turns().at(-1)!;
    return turn.req.messages.filter((m) => m.role === 'user').flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])));
  }
}

export async function openChat(app: App): Promise<ChatPage> {
  const card = await app.newChat();
  return new ChatPage(app, card.id);
}
