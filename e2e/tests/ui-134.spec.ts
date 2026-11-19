import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { TestAtlas } from '../harness/engine.ts';
import { shell } from '../harness/scripted.ts';

/**
 * #134: three UI bugs paris saw, re-checked on main with #112, with the real engine and the built UI.
 *  - sidebar « Running » titles end in an ellipsis instead of being clipped at the panel edge (fixed by #112)
 *  - tool-row icons: the SVG carries the icon's name as its class (`row-ic card`, `row-ic board`, `row-ic panel`), so the
 *    board's `.card`, `.board` and `.panel` styles hit it: « Looked at #N » showed an empty grey box (fixed by #139: `rowic-<name>`)
 */
const json = { 'content-type': 'application/json' };
const THEMES = ['dark', 'light'] as const;
const SIZES = [[1440, 900], [390, 844]] as const;

test.describe('sidebar Running titles', () => {
  for (const theme of THEMES) {
    for (const [width, height] of SIZES) {
      test(`long titles end in an ellipsis · ${theme} ${width}px`, async ({ browser }) => {
        const atlas = await TestAtlas.start();
        const sleeps: string[] = []; // this test's own sleeps: a blanket pkill would kill those of the tests running in parallel
        try {
          const page = await (await browser.newContext({ viewport: { width, height }, colorScheme: theme })).newPage();
          const who = ['munih', 'paris', 'zurich'];
          for (const a of who) atlas.engine.agents.create({ id: a, modelId: atlas.engine.agents.get('atlas').modelId });
          const titles = ['Re-check three UI bugs from paris on the current build', 'Sidebar running titles are clipped at the panel edge with no ellipsis', 'Short'];
          for (const [i, t] of titles.entries()) {
            const sleep = 'sleep 3' + Math.floor(Math.random() * 1e6);
            sleeps.push(sleep);
            atlas.model.next(shell(sleep));
            await atlas.task(t, who[i]);
            await expect.poll(() => atlas.db("SELECT COUNT(*) AS n FROM tool_calls WHERE status = 'running'"), { timeout: 15_000 }).toEqual([{ n: i + 1 }]);
          }
          await page.goto(`${atlas.url}/?theme=${theme}#/board`);
          // ≤ 900 px (#264): no sidebar; the Running rows are on the More tab.
          if (width <= 900) await page.getByRole('button', { name: 'More', exact: true }).click();
          const items = page.locator('.running-item');
          await expect(items).toHaveCount(3);
          for (const [i, t] of titles.entries()) {
            const item = items.nth(i);
            // Measured against the Running section in the same frame.
            const m = await item.locator('.running-title').evaluate((e) => ({ over: e.scrollWidth > e.clientWidth, ell: getComputedStyle(e).textOverflow, out: e.getBoundingClientRect().right - e.closest('.side-running')!.getBoundingClientRect().right }));
            expect(m.ell, t).toBe('ellipsis');
            expect(m.out, `${t}: inside its section`).toBeLessThanOrEqual(0.5);
            if (t.length > 40) expect(m.over, `${t}: is cut (so the ellipsis shows)`).toBe(true);
            else expect(m.over, `${t}: fits`).toBe(false);
          }
        } finally {
          await atlas.stop();
          for (const sl of sleeps) try { execSync(`pkill -f '${sl}$'`); } catch { /* none */ }
        }
      });
    }
  }
});

test.describe('tool-row icons', () => {
  for (const theme of THEMES) {
    test(`every icon is a bare 15 px line icon, no box · ${theme}`, async ({ browser }) => {
      // #134 c, fixed by #139: the SVG class is `rowic-<name>`, so `.card`, `.board` and `.panel` no longer hit it.
      const atlas = await TestAtlas.start();
      try {
        const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })).newPage();
        await fetch(atlas.url + '/api/cards', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Visual pass: bigger text', body: 'x', status: 'triage' }) });
        const chat = await atlas.chat();
        atlas.model.next(
          [
            { type: 'tool_use', id: 'a', name: 'task_show', input: { id: '#1' } }, // icon « card »
            { type: 'tool_use', id: 'b', name: 'task_list', input: {} }, // icon « board »
            { type: 'tool_use', id: 'c', name: 'panel_close', input: {} }, // icon « panel »
          ],
          [{ type: 'text', text: 'done' }],
        );
        await atlas.converse(chat.id, 'go');
        await page.goto(`${atlas.url}/?theme=${theme}#/chat/${chat.id}`);
        // the « 3 steps » header stacks the same icons in 16 px discs (#139: `row-stack-ic card` collided too)
        const stack = page.locator('.chat-row.steps > .chat-row-line .row-stack-ic');
        await expect(stack).toHaveCount(3);
        for (let i = 0; i < 3; i++) {
          const m = await stack.nth(i).evaluate((e) => {
            const cs = getComputedStyle(e);
            const r = e.getBoundingClientRect();
            const svg = e.querySelector('svg')!.getBoundingClientRect();
            return { name: e.getAttribute('class'), w: Math.round(r.width), h: Math.round(r.height), border: cs.borderTopWidth, svg: Math.round(svg.width) };
          });
          expect(m, m.name!).toMatchObject({ w: 16, h: 16, border: '0px', svg: 15 });
        }
        await page.locator('.chat-row.steps > .chat-row-line').first().click(); // open the « 3 steps » group
        const icons = page.locator('.chat-row.nested .chat-row-icon > svg');
        await expect(icons).toHaveCount(3);
        for (let i = 0; i < 3; i++) {
          const m = await icons.nth(i).evaluate((e) => {
            const cs = getComputedStyle(e);
            const r = e.getBoundingClientRect();
            return { name: e.getAttribute('class'), w: Math.round(r.width), h: Math.round(r.height), border: cs.borderTopWidth, bg: cs.backgroundColor, pad: cs.paddingTop };
          });
          expect(m, m.name!).toMatchObject({ w: 15, h: 15, border: '0px', bg: 'rgba(0, 0, 0, 0)', pad: '0px' });
        }
      } finally {
        await atlas.stop();
      }
    });
  }
});
