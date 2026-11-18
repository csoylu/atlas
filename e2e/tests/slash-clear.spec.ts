import { test, expect, openSurface, SURFACES } from '../harness/fixtures.ts';
import { SUMMARY_LEAD, TODO_LEAD } from '../../packages/engine/src/context.ts';

/** Step 3: /clear. */
for (const surface of SURFACES) {
  test.describe(`/clear · ${surface}`, () => {
    test('« Context cleared by you · N earlier messages », the earlier messages are folded and « Show N earlier messages » expands them', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic', 'beta topic');
      await expect(c.msg('alpha topic')).toBeVisible();
      const visible = (await atlas.messages(c.id)).filter((m) => m.author !== 'tool').length;

      expect(await c.command('/clear')).toBe(200);
      const row = c.clearRow;
      await expect(row).toBeVisible();
      await expect(row).toContainText(`${visible} earlier messages`);
      expect((await atlas.clears(c.id))[0]).toMatchObject({ hidden: visible, undoable: true });

      // Folded.
      await expect(c.msg('alpha topic')).toHaveCount(0);
      await expect(c.msg('beta topic')).toHaveCount(0);
      await expect(c.msg(/Reply \d+ to: alpha topic/)).toHaveCount(0);
      // A task that is waiting for the user keeps showing its open question (the card's block), which here is the last reply.
      if (surface === 'direct chat') await expect(c.msg(/Reply \d+ to: beta topic/)).toHaveCount(0);
      // Nothing deleted.
      expect((await atlas.messages(c.id)).filter((m) => m.author !== 'tool')).toHaveLength(visible);

      // Show / hide.
      await c.open(row);
      await row.getByRole('button', { name: `Show ${visible} earlier messages` }).click();
      await expect(c.msg('alpha topic')).toBeVisible();
      await expect(c.msg('beta topic')).toBeVisible();
      await expect(c.msg(/Reply \d+ to: alpha topic/)).toBeVisible();
      await row.getByRole('button', { name: 'Hide earlier messages' }).click();
      await expect(c.msg('alpha topic')).toHaveCount(0);
    });

    test('the next agent call has none of the old messages, the summary or the todos; the new message is answered', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic', 'beta topic');
      expect(await c.command('/compact')).toBe(200); // a summary exists...
      await expect(c.compactRow).toBeVisible();
      atlas.engine.kanban.setTodos(c.id, [{ content: 'old todo item', status: 'pending' }]); // ...and a todo list
      await atlas.converse(c.id, 'gamma topic');
      const before = atlas.model.lastMain.text; // sanity: the harness can see them
      expect(before).toContain(SUMMARY_LEAD);
      expect(before).toContain(TODO_LEAD);
      expect(before).toContain('old todo item');

      expect(await c.command('/clear')).toBe(200);
      await expect(c.clearRow).toBeVisible();
      await c.send('fresh start');
      await expect(c.msg(/Reply \d+ to: fresh start/)).toBeVisible();
      await atlas.idle(c.id);

      const view = atlas.model.lastMain.text;
      expect(view).toContain('fresh start');
      for (const gone of ['alpha topic', 'beta topic', 'gamma topic', 'SUMMARY1', SUMMARY_LEAD, TODO_LEAD, 'old todo item']) expect(view, gone).not.toContain(gone);
      // The summarizer isn't called again for it either.
      expect(atlas.model.of('summary')).toHaveLength(1);
    });

    test('Undo clear brings everything back: the messages, the summary and the todos', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic', 'beta topic');
      expect(await c.command('/compact')).toBe(200);
      atlas.engine.kanban.setTodos(c.id, [{ content: 'old todo item', status: 'pending' }]);

      expect(await c.command('/clear')).toBe(200);
      await expect(c.msg('alpha topic')).toHaveCount(0);
      await c.open(c.clearRow); // it opens by itself while Undo is in reach; this is a no-op then
      await c.clearRow.getByRole('button', { name: 'Undo clear' }).click();
      await expect(c.clearRow).toHaveCount(0);
      await expect(c.msg('alpha topic')).toBeVisible();
      expect(await atlas.clears(c.id)).toEqual([]);
      // The summary row is back too.
      await expect(c.compactRow).toBeVisible();

      await atlas.converse(c.id, 'gamma topic');
      const view = atlas.model.lastMain.text;
      expect(view).toContain(SUMMARY_LEAD);
      expect(view).toContain('SUMMARY1');
      expect(view).toContain('old todo item');
      expect(view).toContain('gamma topic');

      // And it can be cleared again.
      expect(await c.command('/clear')).toBe(200);
      await expect(c.clearRow).toBeVisible();
    });

    test('Undo clear is there until the next message is sent, then gone (UI and API)', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      expect(await c.command('/clear')).toBe(200);
      await c.open(c.clearRow);
      await expect(c.clearRow.getByRole('button', { name: 'Undo clear' })).toBeVisible();
      const [clear] = await atlas.clears(c.id);

      await c.send('next message');
      await expect(c.msg(/Reply \d+ to: next message/)).toBeVisible();
      await c.open(c.clearRow);
      await expect(c.clearRow.getByRole('button', { name: /Show \d+ earlier messages/ })).toBeVisible();
      await expect(c.clearRow.getByRole('button', { name: 'Undo clear' })).toHaveCount(0);
      expect((await atlas.clears(c.id))[0]).toMatchObject({ undoable: false });
      const r = await fetch(`${atlas.url}/api/clears/${clear!.id}/undo`, { method: 'POST' });
      expect(r.status).toBe(409);
    });

    test('a second /clear folds again from the new point; the first row stays, and the view only has what follows', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      expect(await c.command('/clear')).toBe(200);
      await atlas.converse(c.id, 'beta topic');
      expect(await c.command('/clear')).toBe(200);
      // Only the latest clear's row stays in view; the earlier one is folded with what it hid.
      await expect(c.clearRow).toHaveCount(1);
      await expect(c.msg('beta topic')).toHaveCount(0);
      await c.open(c.clearRow);
      await c.clearRow.getByRole('button', { name: /Show \d+ earlier messages/ }).click();
      await expect(c.clearRow).toHaveCount(2);
      await expect(c.msg('alpha topic')).toBeVisible();
      await c.clearRow.last().getByRole('button', { name: 'Hide earlier messages' }).click();
      await atlas.converse(c.id, 'gamma topic');
      const view = atlas.model.lastMain.text;
      expect(view).toContain('gamma topic');
      expect(view).not.toContain('alpha topic');
      expect(view).not.toContain('beta topic');
    });

    test('a summary written before the clear is dropped too, and a compact after it only covers what came after', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      expect(await c.command('/compact')).toBe(200);
      expect(await c.command('/clear')).toBe(200);
      await atlas.converse(c.id, 'fresh start');
      expect(atlas.model.lastMain.text).not.toContain('SUMMARY1');
      expect(atlas.model.lastMain.text).not.toContain('alpha topic');
      expect(await c.command('/compact')).toBe(200);
      const last = atlas.model.of('summary').at(-1)!;
      expect(last.text).toContain('fresh start');
      expect(last.text).not.toContain('alpha topic');
      expect(last.text).not.toContain('SUMMARY1');
    });

    test('history_search still finds the cleared messages (append-only transcript) — and only through the tool', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      expect(await c.command('/clear')).toBe(200);
      atlas.model.next([{ type: 'tool_use', id: 'hs1', name: 'history_search', input: { query: 'alpha topic' } }], [{ type: 'text', text: 'searched' }]);
      await c.send('look it up');
      await expect(c.msg('searched')).toBeVisible();
      const [asked, answered] = atlas.model.of('main').slice(-2);
      expect(asked!.text).not.toContain('alpha topic'); // the agent starts blind...
      const result = answered!.req.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
      expect(JSON.stringify(result)).toContain('alpha topic'); // ...but can read it back on purpose
    });
  });
}
