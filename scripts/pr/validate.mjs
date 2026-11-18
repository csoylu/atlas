#!/usr/bin/env node
// PR validation gate (card #141). Branch protection on main requires the status `qa/validated` on a PR's head
// commit. This script is the only way anybody should set it, so the rules below cannot be skipped by a typo:
//
//   node scripts/pr/validate.mjs <pr> --ok   --sha <head-sha> --as <who> "what was checked"   [--merge]
//   node scripts/pr/validate.mjs <pr> --fail --as <who> "why it does not pass"
//   node scripts/pr/validate.mjs --list                    open PRs of main still waiting for a validation (oldest first)
//
// --ok refuses unless: the PR is open, not a draft, based on main; its head is exactly --sha (what you reviewed;
// a commit pushed since is not validated); the CI job `test` is green on that head; the PR adds exactly one
// CHANGELOG.md entry (the release rule, checked here because CI only checks it after the push to main); and a
// `qa/*` branch is not validated by its author (zurich). A new commit on the PR has no status: validate again.
// --merge merges right after (merge commit, only if the head is still --sha). When the PR conflicts with main in
// CHANGELOG.md only (every merge moves the changelog top), --merge first rebases it by itself (rebase-changelog.mjs,
// #188): the PR's entry goes back on top, main's entries stay byte-identical, the other files are checked unchanged,
// the branch is pushed with --force-with-lease, then CI `test` must pass on the new head, which gets the validation and
// is merged. GitHub runs no CI on a conflicting head, so in that case CI that has not run on the old head is not
// required (#195); CI still running or red there is refused. Any other conflicting file: refused, the author rebases.
// Tasks (#189): Atlas reads `qa/validated` itself. A task In review whose PR gets --fail goes back to Ready for its
// builder with the description (« <who>: why ») as a note, so write the reason for the builder; --ok --merge moves it
// to Done. No « Validate PR #N » task is needed: the reviewer's run starts in the builder's task when CI is green.
// Any project's repo (#216): the gate's three settings come with the options, defaults = Atlas's (csoylu/atlas, CI
// job `test`, changelog entry required). An empty CI job means « every check run on the head is green »; with the
// changelog off there is no entry rule and no changelog-only auto-rebase (a conflict is refused). Agents do not run
// this script: the engine's `pr_validate` tool runs validate() with the settings of the task's project (Settings →
// Projects), in the reviewer's workspace for that project. The script stays for Master's terminal
// (--repo / --ci-job / --no-changelog for another project).
// Needs the GitHub CLI `gh`, logged in (it is not on the agents' PATH: /opt/homebrew/bin is tried).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPush } from '../release/changelog.mjs';
import { rebaseChangelogOnly } from './rebase-changelog.mjs';

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
// conflictOk: a conflict with the base is not a refusal (--merge then tries the changelog-only rebase).
export async function refusal(o, pr, gh, { conflictOk = false } = {}) {
  const { repo, changelog } = gateOf(o);
  if (pr.state !== 'open') return `PR #${o.pr} is ${pr.merged ? 'already merged' : pr.state}`;
  if (pr.draft) return `PR #${o.pr} is a draft`;
  if (pr.base.ref !== o.base)
    return `PR #${o.pr} is based on "${pr.base.ref}", not ${o.base}: a stacked PR merges into its parent branch, not main. Rebase it onto main (or retarget it) first`;
  if (pr.mergeable === false && !conflictOk)
    return `PR #${o.pr} conflicts with ${pr.base.ref}: rebase it, push, then validate the new head${changelog ? ' (if CHANGELOG.md is the only conflict, --merge rebases it by itself)' : ''}`;
  if (pr.mergeable == null) return `GitHub is still working out if PR #${o.pr} merges cleanly: try again in a few seconds`;
  if (!pr.head.sha.startsWith(o.sha.toLowerCase()))
    return `PR #${o.pr} head is ${pr.head.sha.slice(0, 7)}, not ${o.sha.slice(0, 7)}: a commit was pushed after your review. Review it, then validate its sha`;
  if (/^qa\//.test(pr.head.ref) && o.as === QA_AUTHOR)
    return `${pr.head.ref} is a QA PR (zurich's): someone else validates it (atlas), not its author`;
  // GitHub runs no CI on the head of a PR that conflicts with its base (#195): when --merge is going to rebase it,
  // "has not run yet" is no refusal, the rebase waits for CI on the new head. A run that did happen still counts:
  // still running or red on the old head is refused as usual.
  const ciWhy = await ciState(gh, pr.head.sha, o);
  const ciSkipped = conflictOk && pr.mergeable === false && ciWhy === ciNotRun(pr.head.sha, o);
  if (ciWhy && !ciSkipped) return ciWhy;
  if (!changelog) return null;
  // The release rule: exactly one new CHANGELOG.md entry against where the branch left main.
  const mergeBase = (await json(gh, `repos/${repo}/compare/${pr.base.ref}...${pr.head.sha}`)).merge_base_commit.sha;
  let before = null;
  try {
    before = await raw(gh, `repos/${repo}/contents/CHANGELOG.md?ref=${mergeBase}`);
  } catch {
    /* no CHANGELOG.md at the merge base */
  }
  let after;
  try {
    after = await raw(gh, `repos/${repo}/contents/CHANGELOG.md?ref=${pr.head.sha}`);
  } catch {
    return 'the PR has no CHANGELOG.md: one merged PR = one entry = one release';
  }
  const bad = checkPush(before, after);
  if (bad) return `CHANGELOG.md: ${bad.replace(/^this push/, 'this PR')}`;
  return null;
}

const ciName = (o) => {
  const { ciJob } = gateOf(o);
  return ciJob ? `CI job "${ciJob}"` : 'CI';
};
const ciNotRun = (sha, o) => `${ciName(o)} has not run on ${sha.slice(0, 7)} yet: wait for it`;
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
  if (!checks.length) return ciNotRun(sha, o);
  const what = (r) => (ciJob ? ciName(o) : `CI check "${r.name}"`);
  const running = checks.find((r) => r.status !== 'completed');
  const red = checks.find((r) => r.status === 'completed' && !(ciJob ? r.conclusion === 'success' : GREEN.has(r.conclusion)));
  if (red) return `${what(red)} is ${red.conclusion} on ${sha.slice(0, 7)}: fix it first`;
  if (running) return `${what(running)} is still running on ${sha.slice(0, 7)}: wait for it`;
  return null;
}

/** Wait for CI on `sha` to finish (it starts after a push); returns ciState's answer once it is final. */
export async function waitForCi(gh, sha, { sleep = sleepAsync, timeoutMs = 45 * 60e3, everyMs = 20e3, now = Date.now, log = () => {}, gate = {} } = {}) {
  const until = now() + timeoutMs;
  for (;;) {
    const why = await ciState(gh, sha, gate);
    if (!why || !/wait for it$/.test(why)) return why;
    if (now() >= until) return `${ciName(gate)} did not finish on ${sha.slice(0, 7)} within ${Math.round(timeoutMs / 60e3)} min`;
    log(`${why.replace(/: wait for it$/, '')}: waiting…`);
    await sleep(everyMs);
  }
}

export const sleepAsync = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s); // GitHub's status description limit

/**
 * Run the validation; returns the lines to print. Throws an Error with the reason when refused.
 * deps (tests): rebase (the changelog-only rebase, rebaseChangelogOnly's signature), wait (waitForCi's options), log.
 */
export async function validate(o, gh = realGh, deps = {}) {
  const { repo, changelog } = gateOf(o);
  const pr = await json(gh, `repos/${repo}/pulls/${o.pr}`);
  const out = [];
  const log = deps.log ?? ((line) => console.error(line));
  const setStatus = (sha, state, text) =>
    gh(['api', `repos/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${CONTEXT}`, '-f', `description=${clip(`${o.as}: ${text}`)}`]);
  // The changelog-only rebase is for projects whose PRs all add a changelog entry (they all conflict there).
  const autoRebase = changelog && o.verdict === 'success' && o.merge && pr.mergeable === false;
  if (o.verdict === 'success') {
    const why = await refusal(o, pr, gh, { conflictOk: o.merge && changelog });
    if (why) throw new Error(`refused: ${why}`);
  } else if (pr.state !== 'open') throw new Error(`refused: PR #${o.pr} is ${pr.merged ? 'already merged' : pr.state}`);
  let sha = pr.head.sha;
  let reason = o.reason;
  if (autoRebase) {
    if (pr.head.repo?.full_name && pr.head.repo.full_name !== repo) throw new Error(`refused: PR #${o.pr} comes from a fork: rebase it by hand`);
    // From a terminal: this clone for Atlas, the current folder (a clone of --repo) for another project.
    const rebase = deps.rebase ?? ((a) => rebaseChangelogOnly({ repo: repo === REPO ? join(import.meta.dirname, '..', '..') : process.cwd(), ...a }));
    const r = await rebase({ branch: pr.head.ref, sha, base: pr.base.ref });
    for (const line of r.lines) out.push(line), log(line);
    log(`waiting for ${ciName(o)} on the new head ${r.newHead.slice(0, 7)}…`);
    const ciWhy = await waitForCi(gh, r.newHead, { log, gate: o, ...deps.wait });
    if (ciWhy) {
      await setStatus(r.newHead, 'failure', `auto-rebased onto ${pr.base.ref}, ${ciWhy.replace(/: (fix it first|wait for it)$/, '')}`);
      throw new Error(`not merged: PR #${o.pr} was rebased onto ${pr.base.ref} (head ${r.oldHead.slice(0, 7)} → ${r.newHead.slice(0, 7)}), and ${ciWhy.replace(/: (fix it first|wait for it)$/, '')}; ${CONTEXT} = failure on the new head`);
    }
    sha = r.newHead;
    reason = `${o.reason} (auto-rebased from ${r.oldHead.slice(0, 7)}: changelog-only conflict)`;
  }
  await setStatus(sha, o.verdict, reason);
  out.push(`${CONTEXT} = ${o.verdict} on PR #${o.pr} @ ${sha.slice(0, 7)} (${o.as}: ${reason})`);
  if (o.merge) {
    // sha pins the merge to the validated head: a commit pushed in between makes GitHub refuse (409).
    const merged = await json(gh, `repos/${repo}/pulls/${o.pr}/merge`, '-X', 'PUT', '-f', `sha=${sha}`, '-f', 'merge_method=merge');
    out.push(`merged PR #${o.pr}: ${String(merged.sha).slice(0, 7)}${changelog ? " (one push to main = one release)" : ""}`);
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
