import { test, expect, openSurface, SURFACES } from '../harness/fixtures.ts';
import { shell } from '../harness/scripted.ts';
import { execFileSync } from 'node:child_process';
import type { Conv } from '../harness/conv.ts';

/** Step 4: either command first stops a running agent, as Stop does (not a rewind), then acts. */

const alive = (marker: string): boolean => {
  try {
    return execFileSync('pgrep', ['-f', marker]).toString().trim().length > 0;
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
};

/** The agent is in the middle of a long shell command (a sleep with a unique duration, to find it again). */
async function startLongJob(c: Conv): Promise<string> {
  const marker = `sleep 3${Math.floor(Math.random() * 1e6)}`;
  c.atlas.model.next(shell(marker));
  await c.send('long job');
  await expect.poll(() => c.atlas.db("SELECT COUNT(*) AS n FROM tool_calls WHERE status = 'running'"), { timeout: 10_000 }).toEqual([{ n: 1 }]);
  await expect(c.scope.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect.poll(() => alive(marker)).toBe(true);
  return marker;
}

for (const surface of SURFACES) {
  test.describe(`while the agent is running · ${surface}`, () => {
    test('/clear stops the run (stopped, « stopped by you », not a rewind), kills the command, then clears', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      const marker = await startLongJob(c);

      expect(await c.command('/clear')).toBe(200);
      await expect(c.clearRow).toBeVisible();
      expect(atlas.engine.runner.current(c.id)).toBeNull();
      expect(atlas.run(c.id)).toMatchObject({ status: 'stopped', error: 'stopped by you' });
      await expect.poll(() => alive(marker)).toBe(false); // the shell command died with the run
      // Not a rewind: no rewind event, the message that started the run is still in the transcript.
      expect((await atlas.timeline(c.id)).rewinds).toEqual([]);
      expect((await atlas.messages(c.id)).some((m) => m.author === 'user' && JSON.stringify(m).includes('long job'))).toBe(true);
      // The clear covers everything up to and including the stopped turn.
      await c.open(c.clearRow);
      await c.clearRow.getByRole('button', { name: /Show \d+ earlier messages/ }).click();
      await expect(c.msg('long job')).toBeVisible();
      await expect(c.scope.getByText('Stopped by you').first()).toBeVisible();
      await expect(c.scope.getByText(/rewound|Rewind undone/i)).toHaveCount(0);

      // The chat is usable afterwards, and the agent has forgotten the job (its dangling tool call included).
      await c.send('fresh start');
      await expect(c.msg(/Reply \d+ to: fresh start/)).toBeVisible();
      const view = atlas.model.lastMain.text;
      expect(view).not.toContain('long job');
      expect(view).not.toContain(marker);
    });

    test('/compact stops the run the same way, then summarizes (the stopped turn included)', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      const marker = await startLongJob(c);

      expect(await c.command('/compact')).toBe(200);
      await expect(c.compactRow).toBeVisible();
      expect(atlas.engine.runner.runs(c.id).find((r) => r.status === 'stopped')).toMatchObject({ status: 'stopped', error: 'stopped by you' });
      await expect.poll(() => alive(marker)).toBe(false);
      expect((await atlas.timeline(c.id)).rewinds).toEqual([]);
      // The stop is on screen and the summarizer saw the interrupted job.
      await expect(c.scope.getByText('Stopped by you').first()).toBeVisible();
      await expect(c.msg('long job')).toBeVisible();
      const [sum] = atlas.model.of('summary');
      expect(sum!.text).toContain('long job');

      // Afterwards the agent answers from the summary: the scripted model echoes the message it was sent, which now opens with it.
      await c.send('what now');
      await expect(c.msg(/Reply \d+ to: Summary of the earlier part/)).toBeVisible();
      expect(atlas.model.lastMain.text).toContain('what now');
      expect(atlas.model.lastMain.text).toContain('SUMMARY1');
    });

    // Found by this suite (#105, F1): Runner.compactNow ended with wake(), and the stopped request counted as owed, so a few
    // ms after /compact the agent started a NEW run on it: the stop was undone. Fixed in 7ed9267; this keeps it fixed.
    test('the agent does not resume by itself after /compact stopped it', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      await startLongJob(c);
      const mains = atlas.model.of('main').length;
      expect(await c.command('/compact')).toBe(200);
      await expect(c.compactRow).toBeVisible();
      await page.waitForTimeout(1500);
      expect(atlas.model.of('main')).toHaveLength(mains); // no new agent turn
      expect(atlas.run(c.id)).toMatchObject({ status: 'stopped', error: 'stopped by you' }); // the latest run is still the stopped one
    });

    test('a refused /clear (nothing new) reports why and leaves no run behind', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      expect(await c.command('/clear')).toBe(200);
      // Nothing new since the clear: the command is refused and no run is running to stop.
      expect(await c.command('/clear')).toBe(409);
      await expect(c.toast).toContainText('nothing to clear');
      expect(atlas.run(c.id)?.status).not.toBe('running');
    });
  });
}
