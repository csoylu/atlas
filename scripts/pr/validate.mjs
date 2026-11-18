#!/usr/bin/env node
// PR validation gate (card #141). Branch protection on main requires the status `qa/validated` on a PR's head
// commit. This script is the only way anybody should set it, so the rules below cannot be skipped by a typo:
//
//   node scripts/pr/validate.mjs <pr> --ok   --sha <head-sha> --as <who> "what was checked"   [--merge]
//   node scripts/pr/validate.mjs <pr> --fail --as <who> "why it does not pass"
//   node scripts/pr/validate.mjs --list                    open PRs of main still waiting for a validation (oldest first)
//
// --ok refuses unless: the PR is open, not a draft, based on main; its head is exactly --sha (what you reviewed;
// a commit pushed since is not validated); it does not conflict with main; the CI job `test` is green on that head;
// the PR adds exactly one entry file to changelog/ and changes no other changelog file (#223: the release rule,
// checked here because CI only checks it after the push to main); and a `qa/*` branch is not validated by its author
// (zurich). A new commit on the PR has no status: validate again. --merge merges right after (merge commit, only if
// the head is still --sha). A conflicting PR is refused: its author rebases (entries are one file per PR, so the
// changelog never conflicts).
// Tasks (#189): Atlas reads `qa/validated` itself. A task In review whose PR gets --fail goes back to Ready for its
// builder with the description (« <who>: why ») as a note, so write the reason for the builder; --ok --merge moves it
// to Done. No « Validate PR #N » task is needed: the reviewer's run starts in the builder's task when CI is green.
// Any project's repo (#216): the gate's three settings come with the options, defaults = Atlas's (csoylu/atlas, CI
// job `test`, changelog entry required). An empty CI job means « every check run on the head is green »; with the
// changelog off there is no entry rule. Agents do not run
// this script: the engine's `pr_validate` tool runs validate() with the settings of the task's project (Settings →
// Projects), in the reviewer's workspace for that project. The script stays for Master's terminal
// (--repo / --ci-job / --no-changelog for another project).
// Needs the GitHub CLI `gh`, logged in (it is not on the agents' PATH: /opt/homebrew/bin is tried).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { changelogRule, parseEntry } from '../release/changelog.mjs';

export const REPO = 'csoylu/atlas';
export const CONTEXT = 'qa/validated';
export const CI_JOB = 'test';
export const WHO = ['zurich', 'atlas', 'munih', 'paris', 'master'];
const QA_AUTHOR = 'zurich'; // the agent whose own `qa/*` PRs need someone else

const USAGE =
  'usage: validate.mjs <pr> --ok --sha <head-sha> --as <who> "what was checked" [--merge]\n' +
  '       validate.mjs <pr> --fail --as <who> "why"\n' +
  '       validate.mjs --list\n' +
  `  <who>: ${WHO.join(' | ')}. Option: --base <branch> (default main; only to try the gate on a throwaway branch).\n` +
  `  Another project: --repo owner/name, --ci-job <name> (or "any": every check green), --no-changelog. Defaults: ${REPO}, "${CI_JOB}", changelog on.`;

/** The gate's settings of a project: what `o` carries (missing ones = Atlas's). */
export const gateOf = (o) => ({ repo: o.repo ?? REPO, ciJob: o.ciJob === undefined ? CI_JOB : o.ciJob || null, changelog: o.changelog ?? true });

/** argv (without node and the script) → options; throws an Error whose message is the reason. */
export function parseArgs(argv) {
  const o = { pr: null, verdict: null, sha: null, as: null, reason: '', merge: false, list: false, base: 'main', repo: REPO, ciJob: CI_JOB, changelog: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === '--ok') o.verdict = o.verdict ? 'both' : 'success';
    else if (a === '--fail') o.verdict = o.verdict ? 'both' : 'failure';
    else if (a === '--merge') o.merge = true;
    else if (a === '--list') o.list = true;
    else if (a === '--sha') o.sha = value();
    else if (a === '--as') o.as = value();
    else if (a === '--base') o.base = value();
    else if (a === '--repo') {
      o.repo = value();
      if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error(`--repo is owner/name\n${USAGE}`);
    } else if (a === '--ci-job') o.ciJob = value() === 'any' ? null : argv[i];
    else if (a === '--no-changelog') o.changelog = false;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}\n${USAGE}`);
    else rest.push(a);
  }
  if (o.list) return o;
  if (o.verdict === 'both') throw new Error(`--ok and --fail together\n${USAGE}`);
  if (!o.verdict) throw new Error(`say --ok or --fail\n${USAGE}`);
  const pr = rest.shift();
  if (!/^\d+$/.test(pr ?? '')) throw new Error(`the first argument is the PR number\n${USAGE}`);
  o.pr = Number(pr);
  o.reason = rest.join(' ').trim();
  if (!o.as || !WHO.includes(o.as)) throw new Error(`--as <who> is required: ${WHO.join(' | ')}\n${USAGE}`);
  if (!o.reason) throw new Error(`give the reason: what you checked (--ok) or why it fails (--fail)\n${USAGE}`);
  if (o.verdict === 'success' && !/^[0-9a-f]{7,40}$/i.test(o.sha ?? ''))
    throw new Error(`--ok needs --sha <the head commit you reviewed>\n${USAGE}`);
  if (o.verdict === 'failure' && o.merge) throw new Error('--merge only goes with --ok');
  return o;
}

/** Homebrew's `gh` if it is there (agents' shells do not have /opt/homebrew/bin on PATH), else `gh` from PATH. */
export function ghBinary() {
  for (const p of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']) if (existsSync(p)) return p;
  return 'gh';
}

/** A GitHub client: gh(args) → stdout (a promise). `bin` and `env`: the engine gives the login shell's (#136). */
export function ghClient({ bin = ghBinary(), env = process.env } = {}) {
  return (args) =>
    new Promise((resolve, reject) =>
      execFile(bin, args, { encoding: 'utf8', env, maxBuffer: 20e6, timeout: 60e3 }, (e, stdout, stderr) => {
        if (!e) return resolve(stdout);
        if (e.code === 'ENOENT') return reject(new Error('gh not found on PATH (install the GitHub CLI and run gh auth login)'));
        reject(new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${String(stderr).trim() || e.message}`));
      }),
    );
}
export const realGh = ghClient();

const json = async (gh, path, ...extra) => JSON.parse(await gh(['api', path, ...extra]));
const raw = (gh, path) => gh(['api', path, '-H', 'Accept: application/vnd.github.raw+json']);

/** Why this PR may not be validated as OK (null = it may). `gh` is injected so tests can fake GitHub. */
export async function refusal(o, pr, gh) {
  const { repo, changelog } = gateOf(o);
  if (pr.state !== 'open') return `PR #${o.pr} is ${pr.merged ? 'already merged' : pr.state}`;
  if (pr.draft) return `PR #${o.pr} is a draft`;
  if (pr.base.ref !== o.base)
    return `PR #${o.pr} is based on "${pr.base.ref}", not ${o.base}: a stacked PR merges into its parent branch, not main. Rebase it onto main (or retarget it) first`;
  if (pr.mergeable === false) return `PR #${o.pr} conflicts with ${pr.base.ref}: rebase it, push, then validate the new head`;
  if (pr.mergeable == null) return `GitHub is still working out if PR #${o.pr} merges cleanly: try again in a few seconds`;
  if (!pr.head.sha.startsWith(o.sha.toLowerCase()))
    return `PR #${o.pr} head is ${pr.head.sha.slice(0, 7)}, not ${o.sha.slice(0, 7)}: a commit was pushed after your review. Review it, then validate its sha`;
  if (/^qa\//.test(pr.head.ref) && o.as === QA_AUTHOR)
    return `${pr.head.ref} is a QA PR (zurich's): someone else validates it (atlas), not its author`;
  const ciWhy = await ciState(gh, pr.head.sha, o);
  if (ciWhy) return ciWhy;
  if (!changelog) return null;
  // The release rule (#223): against where the branch left main, one new file in changelog/, no other one changed.
  const cmp = await json(gh, `repos/${repo}/compare/${pr.base.ref}...${pr.head.sha}`);
  const files = cmp.files ?? [];
  if (files.length >= 300) return `the PR changes ${files.length} files or more: GitHub lists only 300, so its changelog entry can't be checked here`;
  const changes = files.flatMap((f) =>
    f.status === 'renamed' ? [{ path: f.previous_filename, status: 'removed' }, { path: f.filename, status: 'added' }] : [{ path: f.filename, status: f.status === 'added' || f.status === 'removed' ? f.status : 'modified' }],
  );
  const r = changelogRule(changes);
  if (r.problem) return `changelog: ${r.problem}`;
  try {
    parseEntry(await raw(gh, `repos/${repo}/contents/${r.file}?ref=${pr.head.sha}`), r.file);
  } catch (e) {
    return `changelog: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
}

const ciName = (o) => {
  const { ciJob } = gateOf(o);
  return ciJob ? `CI job "${ciJob}"` : 'CI';
};
const GREEN = new Set(['success', 'neutral', 'skipped']);

/**
 * null when CI passed on `sha`, else why not (a sentence). With a CI job: its latest run passed. Without one (another
 * project, #216): the latest run of every check on the head finished green (success, neutral or skipped).
 */
export async function ciState(gh, sha, o = {}) {
  const { repo, ciJob } = gateOf(o);
  const runs = (await json(gh, `repos/${repo}/commits/${sha}/check-runs?per_page=100`)).check_runs ?? [];
  const latest = new Map();
  for (const r of [...runs].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))) latest.set(r.name, r);
  const checks = ciJob ? [latest.get(ciJob)].filter(Boolean) : [...latest.values()];
  if (!checks.length) return `${ciName(o)} has not run on ${sha.slice(0, 7)} yet: wait for it`;
  const what = (r) => (ciJob ? ciName(o) : `CI check "${r.name}"`);
  const running = checks.find((r) => r.status !== 'completed');
  const red = checks.find((r) => r.status === 'completed' && !(ciJob ? r.conclusion === 'success' : GREEN.has(r.conclusion)));
  if (red) return `${what(red)} is ${red.conclusion} on ${sha.slice(0, 7)}: fix it first`;
  if (running) return `${what(running)} is still running on ${sha.slice(0, 7)}: wait for it`;
  return null;
}

const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s); // GitHub's status description limit

/** Run the validation; returns the lines to print. Throws an Error with the reason when refused. */
export async function validate(o, gh = realGh) {
  const { repo, changelog } = gateOf(o);
  const pr = await json(gh, `repos/${repo}/pulls/${o.pr}`);
  const out = [];
  if (o.verdict === 'success') {
    const why = await refusal(o, pr, gh);
    if (why) throw new Error(`refused: ${why}`);
  } else if (pr.state !== 'open') throw new Error(`refused: PR #${o.pr} is ${pr.merged ? 'already merged' : pr.state}`);
  const sha = pr.head.sha;
  await gh(['api', `repos/${repo}/statuses/${sha}`, '-f', `state=${o.verdict}`, '-f', `context=${CONTEXT}`, '-f', `description=${clip(`${o.as}: ${o.reason}`)}`]);
  out.push(`${CONTEXT} = ${o.verdict} on PR #${o.pr} @ ${sha.slice(0, 7)} (${o.as}: ${o.reason})`);
  if (o.merge) {
    // sha pins the merge to the validated head: a commit pushed in between makes GitHub refuse (409).
    const merged = await json(gh, `repos/${repo}/pulls/${o.pr}/merge`, '-X', 'PUT', '-f', `sha=${sha}`, '-f', 'merge_method=merge');
    out.push(`merged PR #${o.pr}: ${String(merged.sha).slice(0, 7)}${changelog ? ' (one push to main = one release)' : ''}`);
  } else if (o.verdict === 'success') out.push(`not merged: merge it, or re-run with --merge`);
  return out;
}

/** Open PRs of main without a successful qa/validated on their head, oldest first. */
export async function pending(gh = realGh, now = Date.now(), o = {}) {
  const { repo } = gateOf(o);
  const prs = await json(gh, `repos/${repo}/pulls?state=open&base=main&per_page=100`);
  const rows = [];
  for (const p of prs) {
    if (p.draft) continue;
    const st = (await json(gh, `repos/${repo}/commits/${p.head.sha}/status`)).statuses ?? [];
    const mine = st.find((s) => s.context === CONTEXT);
    const state = mine?.state ?? 'waiting';
    if (state === 'success') continue;
    rows.push({
      pr: p.number,
      title: p.title,
      branch: p.head.ref,
      head: p.head.sha.slice(0, 7),
      state,
      note: mine?.description ?? '',
      waitingHours: Math.round(((now - Date.parse(p.created_at ?? p.updated_at)) / 36e5) * 10) / 10, // since the PR was opened: merge order is release order
    });
  }
  return rows.sort((a, b) => b.waitingHours - a.waitingHours);
}

// Run as a script only (bundled into the engine, #216, import.meta.url is the bundle's: never the CLI).
if (/validate\.mjs$/.test(process.argv[1] ?? '') && import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.list) {
      const rows = await pending(realGh, Date.now(), o);
      if (!rows.length) console.log('no PR is waiting for a validation');
      for (const r of rows)
        console.log(`#${r.pr} ${r.state.padEnd(7)} ${String(r.waitingHours).padStart(5)} h  ${r.branch}  ${r.title}${r.note ? `  [${r.note}]` : ''}`);
    } else for (const line of await validate(o)) console.log(line);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
