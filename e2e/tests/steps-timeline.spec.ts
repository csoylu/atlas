import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { TestAtlas } from '../harness/engine.ts';

/**
 * #145: in an expanded « N steps » group, the vertical timeline line runs through the centre of every row icon
 * (thought, terminal, read, search, card, running spinner), never under an icon, and has no tail above the first icon
 * or below the last one (even when the last row is open, as a live shell is).
 */
const THEMES = ['dark', 'light'] as const;
const SIZES = [[1440, 900], [390, 844]] as const;

interface Box { left: number; right: number; top: number; bottom: number }
interface Seg { x: number; top: number; bottom: number; from: string }

/** The icon boxes of the nested rows, and every drawn line segment (::before/::after of the timeline and its rows). */
async function measure(page: Page) {
  return page.locator('.steps-tl').first().evaluate((tl) => {
    const segs: Seg[] = [];
    const add = (el: Element, pseudo: '::before' | '::after', from: string) => {
      const cs = getComputedStyle(el, pseudo);
      if (cs.content === 'none' || cs.display === 'none' || parseFloat(cs.height) <= 0 || parseFloat(cs.width) <= 0) return;
      const r = el.getBoundingClientRect();
      const top = r.top + parseFloat(cs.top);
      segs.push({ x: r.left + parseFloat(cs.left) + parseFloat(cs.width) / 2, top, bottom: top + parseFloat(cs.height), from });
    };
    add(tl, '::before', 'tl::before');
    add(tl, '::after', 'tl::after');
    const rows = [...tl.querySelectorAll(':scope > .chat-row.nested')];
    rows.forEach((row, i) => {
      add(row, '::before', `row ${i}::before`);
      add(row, '::after', `row ${i}::after`);
    });
    const icons = rows.map((row) => {
      const ic = row.querySelector(':scope > .chat-row-line > .chat-row-icon')!;
      const r = ic.getBoundingClientRect();
      const what = ic.querySelector('svg')?.getAttribute('class') ?? (ic.querySelector('.step-sq') ? 'spinner' : '?');
      return { what, box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } as Box };
    });
    return { segs, icons };
  });
}

function check(m: Awaited<ReturnType<typeof measure>>, label: string) {
  const { segs, icons } = m;
  expect(segs.length, `${label}: a line is drawn`).toBeGreaterThan(0);
  const first = icons[0]!.box;
  const last = icons.at(-1)!.box;
  for (const { what, box } of icons) {
    const cx = (box.left + box.right) / 2;
    for (const s of segs) {
      expect(Math.abs(s.x - cx), `${label}: ${s.from} centred on the ${what} icon (line ${s.x}, icon ${cx})`).toBeLessThanOrEqual(0.5);
      // the line never runs under an icon (so it can't show through a thin one)
      const overlap = Math.min(s.bottom, box.bottom) - Math.max(s.top, box.top);
      expect(overlap, `${label}: ${s.from} stays off the ${what} icon`).toBeLessThanOrEqual(0.5);
    }
  }
  // no tail: nothing above the first icon or below the last one
  expect(Math.min(...segs.map((s) => s.top)), `${label}: starts at the first icon`).toBeGreaterThanOrEqual(first.top - 0.5);
  expect(Math.max(...segs.map((s) => s.bottom)), `${label}: ends at the last icon`).toBeLessThanOrEqual(last.bottom + 0.5);
  // no hole: every gap between two icons is covered
  for (let i = 0; i + 1 < icons.length; i++) {
    let y = icons[i]!.box.bottom;
    const end = icons[i + 1]!.box.top;
    for (const s of [...segs].sort((a, b) => a.top - b.top)) if (s.top <= y + 0.5 && s.bottom > y) y = s.bottom;
    expect(y, `${label}: line links icon ${i} (${icons[i]!.what}) to icon ${i + 1} (${icons[i + 1]!.what})`).toBeGreaterThanOrEqual(end - 0.5);
  }
}

test.describe('steps timeline', () => {
  for (const theme of THEMES) {
    for (const [width, height] of SIZES) {
      test(`line runs through the centre of every icon · ${theme} ${width}px`, async ({ browser }) => {
        const atlas = await TestAtlas.start();
        const sleep = 'sleep 5' + Math.floor(1e5 + Math.random() * 9e5); // not 3…: ui-134 kills its own « sleep 3NNNN » runs
        try {
          const page = await (await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 3 })).newPage(); // x3: zoomed shots
          await fetch(atlas.url + '/api/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Timeline', body: 'x', status: 'triage' }) });
          const chat = await atlas.chat();
          atlas.model.next(
            [
              { type: 'thinking', thinking: 'Look at the files first.', signature: 's' }, // thought
              { type: 'tool_use', id: 'a', name: 'shell', input: { command: 'echo hi' } }, // terminal
              { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'nope.md' } }, // read (fails: tinted row)
              { type: 'tool_use', id: 'c', name: 'grep', input: { pattern: 'x' } }, // search
            ],
            [
              { type: 'tool_use', id: 'd', name: 'task_show', input: { id: '#1' } }, // card
              { type: 'tool_use', id: 'e', name: 'shell', input: { command: sleep } }, // running spinner, open (live shell)
            ],
          );
          void atlas.converse(chat.id, 'go').catch(() => {});
          await expect.poll(() => atlas.db("SELECT COUNT(*) AS n FROM tool_calls WHERE status = 'running'"), { timeout: 15_000 }).toEqual([{ n: 1 }]);
          await page.goto(`${atlas.url}/?theme=${theme}#/chat/${chat.id}`);
          const group = page.locator('.chat-row.steps').first();
          // the group may open by itself while the run streams in (under load after our check): open it, then recheck
          await expect(async () => {
            if (!(await group.evaluate((e) => e.classList.contains('open')))) await group.locator('> .chat-row-line').click();
            await expect(page.locator('.steps-tl .chat-row.nested')).toHaveCount(6, { timeout: 2000 });
          }).toPass({ timeout: 15_000 });
          await expect(page.locator('.steps-tl .chat-row-icon > .step-sq').first()).toBeVisible();
          await page.waitForTimeout(300); // rows settle (expand transitions)
          check(await measure(page), `${theme} ${width} running`);
          await page.locator('.chat-row.steps').first().screenshot({ path: test.info().outputPath('running.png') }); // zoomed (x3), for the report

          // finished (a second chat with the same steps, the last shell done), every row closed, then a middle row opened
          const done = await atlas.chat();
          atlas.model.next(
            [
              { type: 'thinking', thinking: 'Look at the files first.', signature: 's' },
              { type: 'tool_use', id: 'f', name: 'shell', input: { command: 'echo hi' } },
              { type: 'tool_use', id: 'g', name: 'read_file', input: { path: 'nope.md' } },
              { type: 'tool_use', id: 'h', name: 'grep', input: { pattern: 'x' } },
            ],
            [
              { type: 'tool_use', id: 'i', name: 'task_show', input: { id: '#1' } },
              { type: 'tool_use', id: 'j', name: 'shell', input: { command: 'echo bye' } },
            ],
          );
          await atlas.converse(done.id, 'go');
          await page.goto(`${atlas.url}/?theme=${theme}#/chat/${done.id}`);
          const g = page.locator('.chat-row.steps').first();
          if (!(await g.evaluate((e) => e.classList.contains('open')))) await g.locator('> .chat-row-line').click();
          await expect(page.locator('.steps-tl .chat-row.nested')).toHaveCount(6);
          for (const open of await page.locator('.steps-tl .chat-row.nested.open > .chat-row-line').all()) await open.click();
          check(await measure(page), `${theme} ${width} closed`);
          await page.locator('.steps-tl .chat-row.nested > .chat-row-line.expandable').nth(1).click();
          await page.waitForTimeout(300);
          check(await measure(page), `${theme} ${width} middle row open`);
          await page.locator('.chat-row.steps').first().screenshot({ path: test.info().outputPath('done.png') }); // zoomed (x3), for the report
        } finally {
          await atlas.stop();
          try { execSync(`pkill -f '${sleep}'`); } catch { /* gone */ }
        }
      });
    }
  }
});
