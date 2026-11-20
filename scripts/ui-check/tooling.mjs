// What ui-check, landed.mjs, the e2e config and the screenshot scripts share to run inside an agent's sandbox (#314, #298):
// a headless browser that needs no LaunchServices and no window (Playwright's chrome-headless-shell, started with
// --no-sandbox: the agent sandbox is its boundary), and a throwaway engine on a seeded database in $TMPDIR instead of
// the running app (the sandbox denies the live engine's port and database).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const CACHE = process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright';

/** Where Playwright keeps its browsers: PLAYWRIGHT_BROWSERS_PATH, $HOME's cache (the workspace inside the sandbox, where an install lands), the real home's. */
const cacheDirs = (env) => [...new Set([env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), CACHE), join(userInfo().homedir, CACHE)].filter(Boolean))];

/** The newest chrome-headless-shell installed by Playwright, or null. */
function installedShell(env) {
  for (const dir of cacheDirs(env)) {
    if (!existsSync(dir)) continue;
    const revs = readdirSync(dir)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const rev of revs) {
      const inner = readdirSync(join(dir, rev)).find((d) => d.startsWith('chrome-headless-shell-'));
      const bin = inner && join(dir, rev, inner, 'chrome-headless-shell');
      if (bin && existsSync(bin)) return bin;
    }
  }
  return null;
}

/**
 * The browser binary: ATLAS_CHROME if set (a missing one is an error, never a fallback), else Playwright's
 * chrome-headless-shell, installed with `playwright install chromium-headless-shell` when it is missing
 * (`install: false`: only look, for a config that must not download).
 */
export function findBrowser({ env = process.env, install = true } = {}) {
  if (env.ATLAS_CHROME) {
    if (existsSync(env.ATLAS_CHROME)) return env.ATLAS_CHROME;
    throw new Error(`ATLAS_CHROME is set to ${env.ATLAS_CHROME}, which does not exist`);
  }
  const found = installedShell(env);
  if (found || !install) return found;
  console.error('chrome-headless-shell is not installed: installing it with Playwright (once)…');
  const local = join(ROOT, 'e2e', 'node_modules', '.bin', 'playwright');
  const [cmd, args] = existsSync(local) ? [local, []] : ['npx', ['--yes', 'playwright']];
  const r = spawnSync(cmd, [...args, 'install', 'chromium-headless-shell'], { cwd: ROOT, stdio: 'inherit', env });
  const after = installedShell(env);
  if (r.status !== 0 || !after) throw new Error('could not install chrome-headless-shell (`npx playwright install chromium-headless-shell`); install it, or set ATLAS_CHROME to a Chrome binary');
  return after;
}

/** Arguments for a browser with a debugging port. A real Chrome (ATLAS_CHROME) also gets --headless=new; the headless shell is headless already. */
export function browserArgs(binary, { port, profile }) {
  const shell = /chrome-headless-shell$/.test(binary);
  return [...(shell ? [] : ['--headless=new']), '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'];
}

/**
 * A throwaway engine (scripts/ui-check/engine.ts) on a seeded database in $TMPDIR, serving the built UI at `ui`
 * (default packages/ui/dist). Resolves with its address and a stop(); it stops itself when this process ends.
 */
export async function startThrowawayEngine({ ui } = {}) {
  const dist = ui ?? join(ROOT, 'packages', 'ui', 'dist');
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`No built UI in ${dist}: run \`npm run build\` first.`);
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'ui-check', 'engine.ts'), '--ui', dist], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let log = '';
  const base = await new Promise((ok, ko) => {
    const fail = (why) => ko(new Error(`The throwaway engine did not start (${why}):\n${log.trim().split('\n').slice(-12).join('\n')}`));
    child.stdout.on('data', (d) => {
      log += d;
      const m = /^PORT (\d+)$/m.exec(log);
      if (m) ok(`http://127.0.0.1:${m[1]}`);
    });
    child.stderr.on('data', (d) => (log += d));
    child.on('error', (e) => fail(e.message));
    child.on('exit', (code, signal) => fail(`exit ${code ?? signal}`));
    setTimeout(() => fail('no answer in 90 s'), 90_000).unref();
  });
  const stop = () => child.kill('SIGTERM');
  process.on('exit', stop);
  return { base, stop };
}
