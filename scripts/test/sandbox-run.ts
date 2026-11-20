// Run a command the way an agent's shell does under the sandbox (#298, #314), to check a how-to or a script before the
// sandbox is switched on for everyone: the real Seatbelt / bwrap profile, HOME = the workspace, a private TMPDIR, git over
// https with $GH_TOKEN, nothing else of your login.
//
//   node --import tsx scripts/test/sandbox-run.ts [--net on|hosts|off] [--keep] [--data DIR] <clone> -- <command>
//
// `<clone>` is copied (without node_modules) into <data>/workspaces/agent/<its name>; the command runs there. The data
// dir is made under $SANDBOX_DATA (default: next to the clone), never in /tmp, so the profile's rules are the real
// ones (a data dir is denied, the workspace inside it re-allowed). GH_TOKEN (and any other variable named in
// SANDBOX_RUN_ENV, comma-separated) is passed through from your own environment. Exit code: the command's.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Sandbox, spawnAgentCommand } from '../../packages/engine/src/sandbox.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return undefined;
  return argv.splice(i, 2)[1];
};
const keep = (() => {
  const i = argv.indexOf('--keep');
  return i >= 0 && !!argv.splice(i, 1);
})();
const net = flag('net') ?? 'on';
const dataArg = flag('data');
const sep = argv.indexOf('--');
if (sep !== 1 || !argv[2]) {
  console.error('usage: sandbox-run.ts [--net on|hosts|off] [--keep] [--data DIR] <clone> -- <command>');
  process.exit(2);
}
if (net !== 'on') {
  console.error(`--net ${net}: only On is wired here (the levels have their own matrix test, sandbox.network.test.ts)`);
  process.exit(2);
}
const clone = resolve(argv[0]);
const command = argv.slice(2).join(' ');

const base = resolve(dataArg ?? join(process.env.SANDBOX_DATA ?? dirname(clone)));
mkdirSync(base, { recursive: true });
const dataDir = mkdtempSync(join(base, 'sandbox-run-'));
const workspace = join(dataDir, 'workspaces', 'agent');
const cwd = join(workspace, basename(clone));
mkdirSync(workspace, { recursive: true });
cpSync(clone, cwd, { recursive: true, filter: (p) => !p.split('/').includes('node_modules') });
const cleanup = () => keep || rmSync(dataDir, { recursive: true, force: true });

const sandbox = new Sandbox({ enabled: true, dataDir, enginePort: () => null });
const st = await sandbox.probe();
if (!st.ok) {
  console.error(`Sandbox unavailable: ${st.reason}`);
  cleanup();
  process.exit(3);
}
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'en_US.UTF-8' };
for (const k of ['GH_TOKEN', ...(process.env.SANDBOX_RUN_ENV?.split(',') ?? [])]) if (k && process.env[k]) env[k] = process.env[k];
const child = spawnAgentCommand({ cwd, env, sandbox: { sandbox, projectId: 'p', projectName: 'Atlas', agentId: 'agent', workspace } }, command, { bash: true });
child.stdout!.pipe(process.stdout);
child.stderr!.pipe(process.stderr);
child.on('exit', (code, signal) => {
  try {
    process.kill(-child.pid!); // the command's own process group: nothing it started stays behind
  } catch {
    /* already gone */
  }
  cleanup();
  console.error(`[sandbox-run] exit ${code ?? signal}${keep ? `; kept ${dataDir}` : ''}`);
  process.exit(code ?? 1);
});
