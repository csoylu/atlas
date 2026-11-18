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
// --merge merges right after (merge commit, only if the head is still --sha).
// Needs the GitHub CLI `gh`, logged in (it is not on the agents' PATH: /opt/homebrew/bin is tried).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkPush } from '../release/changelog.mjs';

export const REPO = 'csoylu/atlas';
export const CONTEXT = 'qa/validated';
export const CI_JOB = 'test';
export const WHO = ['zurich', 'atlas', 'munih', 'paris', 'master'];
const QA_AUTHOR = 'zurich'; // the agent whose own `qa/*` PRs need someone else

const USAGE =
  'usage: validate.mjs <pr> --ok --sha <head-sha> --as <who> "what was checked" [--merge]\n' +
  '       validate.mjs <pr> --fail --as <who> "why"\n' +
  '       validate.mjs --list\n' +
  `  <who>: ${WHO.join(' | ')}. Option: --base <branch> (default main; only to try the gate on a throwaway branch).`;

/** argv (without node and the script) → options; throws an Error whose message is the reason. */
export function parseArgs(argv) {
  const o = { pr: null, verdict: null, sha: null, as: null, reason: '', merge: false, list: false, base: 'main' };
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

/** The real GitHub client: gh(args) → stdout. */
export function realGh(args) {
  try {
    return execFileSync(ghBinary(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20e6 });
  } catch (e) {
    const err = e.stderr?.toString().trim() || e.message;
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${err}`);
  }
}

const json = (gh, path, ...extra) => JSON.parse(gh(['api', path, ...extra]));
const raw = (gh, path) => gh(['api', path, '-H', 'Accept: application/vnd.github.raw+json']);

/** Why this PR may not be validated as OK (null = it may). `gh` is injected so tests can fake GitHub. */
export function refusal(o, pr, gh) {
  if (pr.state !== 'open') return `PR #${o.pr} is ${pr.merged ? 'already merged' : pr.state}`;
  if (pr.draft) return `PR #${o.pr} is a draft`;
  if (pr.base.ref !== o.base)
    return `PR #${o.pr} is based on "${pr.base.ref}", not ${o.base}: a stacked PR merges into its parent branch, not main. Rebase it onto main (or retarget it) first`;
  if (pr.mergeable === false)
    return `PR #${o.pr} conflicts with ${pr.base.ref}: rebase it (the changelog top is the usual conflict), push, then validate the new head`;
  if (pr.mergeable == null) return `GitHub is still working out if PR #${o.pr} merges cleanly: try again in a few seconds`;
  if (!pr.head.sha.startsWith(o.sha.toLowerCase()))
    return `PR #${o.pr} head is ${pr.head.sha.slice(0, 7)}, not ${o.sha.slice(0, 7)}: a commit was pushed after your review. Review it, then validate its sha`;
  if (/^qa\//.test(pr.head.ref) && o.as === QA_AUTHOR)
    return `${pr.head.ref} is a QA PR (zurich's): someone else validates it (atlas), not its author`;
  const runs = json(gh, `repos/${REPO}/commits/${pr.head.sha}/check-runs?per_page=100`).check_runs ?? [];
  const ci = runs.filter((r) => r.name === CI_JOB).sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
  if (!ci) return `CI job "${CI_JOB}" has not run on ${pr.head.sha.slice(0, 7)} yet: wait for it`;
  if (ci.status !== 'completed') return `CI job "${CI_JOB}" is still running on ${pr.head.sha.slice(0, 7)}: wait for it`;
  if (ci.conclusion !== 'success') return `CI job "${CI_JOB}" is ${ci.conclusion} on ${pr.head.sha.slice(0, 7)}: fix it first`;
  // The release rule: exactly one new CHANGELOG.md entry against where the branch left main.
  const mergeBase = json(gh, `repos/${REPO}/compare/${pr.base.ref}...${pr.head.sha}`).merge_base_commit.sha;
  let before = null;
  try {
    before = raw(gh, `repos/${REPO}/contents/CHANGELOG.md?ref=${mergeBase}`);
  } catch {
    /* no CHANGELOG.md at the merge base */
  }
  let after;
  try {
    after = raw(gh, `repos/${REPO}/contents/CHANGELOG.md?ref=${pr.head.sha}`);
  } catch {
    return 'the PR has no CHANGELOG.md: one merged PR = one entry = one release';
  }
  const bad = checkPush(before, after);
  if (bad) return `CHANGELOG.md: ${bad.replace(/^this push/, 'this PR')}`;
  return null;
}

const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s); // GitHub's status description limit

/** Run the validation; returns the lines to print. Throws an Error with the reason when refused. */
export function validate(o, gh = realGh) {
  const pr = json(gh, `repos/${REPO}/pulls/${o.pr}`);
  const out = [];
  if (o.verdict === 'success') {
    const why = refusal(o, pr, gh);
    if (why) throw new Error(`refused: ${why}`);
  } else if (pr.state !== 'open') throw new Error(`refused: PR #${o.pr} is ${pr.merged ? 'already merged' : pr.state}`);
  const sha = pr.head.sha;
  gh([
    'api', `repos/${REPO}/statuses/${sha}`,
    '-f', `state=${o.verdict}`,
    '-f', `context=${CONTEXT}`,
    '-f', `description=${clip(`${o.as}: ${o.reason}`)}`,
  ]);
  out.push(`${CONTEXT} = ${o.verdict} on PR #${o.pr} @ ${sha.slice(0, 7)} (${o.as}: ${o.reason})`);
  if (o.merge) {
    // sha pins the merge to the validated head: a commit pushed in between makes GitHub refuse (409).
    const merged = json(gh, `repos/${REPO}/pulls/${o.pr}/merge`, '-X', 'PUT', '-f', `sha=${sha}`, '-f', 'merge_method=merge');
    out.push(`merged PR #${o.pr}: ${String(merged.sha).slice(0, 7)} (one push to main = one release)`);
  } else if (o.verdict === 'success') out.push(`not merged: merge it, or re-run with --merge`);
  return out;
}

/** Open PRs of main without a successful qa/validated on their head, oldest first. */
export function pending(gh = realGh, now = Date.now()) {
  const prs = json(gh, `repos/${REPO}/pulls?state=open&base=main&per_page=100`);
  const rows = [];
  for (const p of prs) {
    if (p.draft) continue;
    const st = json(gh, `repos/${REPO}/commits/${p.head.sha}/status`).statuses ?? [];
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.list) {
      const rows = pending();
      if (!rows.length) console.log('no PR is waiting for a validation');
      for (const r of rows)
        console.log(`#${r.pr} ${r.state.padEnd(7)} ${String(r.waitingHours).padStart(5)} h  ${r.branch}  ${r.title}${r.note ? `  [${r.note}]` : ''}`);
    } else for (const line of validate(o)) console.log(line);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
