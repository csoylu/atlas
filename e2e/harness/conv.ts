import { expect, type Locator, type Page } from '@playwright/test';
import type { Card } from '@atlas/shared';
import type { TestAtlas } from './engine.ts';
import type { Surface } from './fixtures.ts';

/** The conversation on screen (a direct chat, or a task's ticket modal) as the user drives it. */
export class Conv {
  readonly scope: Locator;
  readonly box: Locator;
  constructor(
    readonly page: Page,
    readonly atlas: TestAtlas,
    readonly card: Card,
    readonly surface: Surface,
  ) {
    this.scope = surface === 'task chat' ? page.getByRole('dialog', { name: 'E2E task' }) : page.locator('body');
    this.box = this.scope.getByPlaceholder(/Message @atlas/);
  }
  get id(): string {
    return this.card.id;
  }

  /** The command popup. */
  get popup(): Locator {
    return this.scope.getByRole('listbox', { name: 'Commands' });
  }
  get options(): Locator {
    return this.popup.getByRole('option');
  }
  /** Names in the popup, in order: ['/clear', '/compact']. */
  async popupNames(): Promise<string[]> {
    return this.options.locator('.slash-cmd').allTextContents();
  }
  get selected(): Locator {
    return this.popup.locator('[aria-selected=true] .slash-cmd');
  }

  /** Types into the box as a user would (key by key, so the popup reacts to each character). */
  async type(text: string): Promise<void> {
    await this.box.click();
    await this.box.fill('');
    await this.box.pressSequentially(text);
  }
  async send(text: string): Promise<void> {
    await this.type(text);
    await this.box.press('Enter');
  }
  /** Waits for the command's round trip (POST .../command) and returns its status. */
  async command(text: string, how: 'Enter' | 'Tab' = 'Enter'): Promise<number> {
    const res = this.page.waitForResponse((r) => r.url().endsWith(`/cards/${this.id}/command`) && r.request().method() === 'POST');
    await this.type(text);
    if (how === 'Tab') await this.box.press('Tab');
    else await this.box.press('Enter');
    return (await res).status();
  }

  /** A system row by its verb (« Compacted by you », « Context cleared by you »). */
  row(verb: string | RegExp): Locator {
    return this.scope.locator('.sys-row').filter({ has: this.page.locator('.chat-row-verb', { hasText: verb }) });
  }
  get clearRow(): Locator {
    return this.row('Context cleared by you');
  }
  get compactRow(): Locator {
    return this.row('Compacted by you');
  }
  /** Opens a collapsed row (click on its line) if it is not open. */
  async open(row: Locator): Promise<void> {
    const line = row.locator('.chat-row-line').first();
    if ((await line.getAttribute('aria-expanded')) !== 'true') await line.click();
    await expect(line).toHaveAttribute('aria-expanded', 'true');
  }
  /** A message's text in the chat (user or agent): a paragraph, so the chat's title in the sidebar and header doesn't match. */
  msg(text: string | RegExp): Locator {
    const re = typeof text === 'string' ? new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') : text;
    return this.scope.locator('p').filter({ hasText: re });
  }
  get toast(): Locator {
    return this.page.getByRole('alert');
  }
  /** Everything the composer says about itself being busy. */
  get busy(): Locator {
    return this.scope.locator('.slash-busy');
  }
}
