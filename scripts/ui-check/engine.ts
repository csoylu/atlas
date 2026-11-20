// A throwaway Atlas for `ui:check` (#314): a real engine (dispatch off, no model, no GitHub) on a seeded database in
// $TMPDIR, serving the built UI. It prints `PORT <n>` once it is up and removes its data when it is stopped.
//
//   node --import tsx scripts/ui-check/engine.ts [--ui packages/ui/dist]
//
// Why not the running app: agent commands run in a sandbox (#298) that cannot reach the live engine, its database or
// the shared /tmp. The seed stands in for live data: four agents, one chat with a long mixed history, tasks in
// every board column with short and very long titles and one long brief, documents of every kind, memories, a second
// folder. What it cannot stand in for: the live volume (hundreds of tasks, long real titles and messages), real model
// names and plan accounts, other projects, schedules, a real chat history; ui-check's own fixtures (pins, reports,
// tool rows, the Datinel project, workflows, secrets) are added on top in both cases. Compare a run with live data
// by running ui-check against it on Master's Mac (`--port N`, outside the sandbox); this file says what differs.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startEngine } from '../../packages/engine/src/index.ts';
import { FakeProvider } from '../../packages/engine/src/providers/fake.ts';
import type { ContentBlock } from '@atlas/shared';

const arg = (name: string) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const uiDir = resolve(arg('ui') ?? join(import.meta.dirname, '..', '..', 'packages', 'ui', 'dist'));
const dataDir = mkdtempSync(join(tmpdir(), 'atlas-ui-check-data-'));
mkdirSync(join(dataDir, 'workspaces', 'atlas'), { recursive: true });
const noGitHub = async () => {
  throw new Error('no GitHub in ui-check');
};
const engine = await startEngine({
  dbFile: join(dataDir, 'atlas.db'),
  dataDir,
  port: 0,
  uiDir,
  providers: () => new FakeProvider([]),
  manageLocal: false,
  memoryReview: false,
  dispatch: false, // no runs, no schedules
  env: {},
  prs: { read: noGitHub, intervalMs: false },
  projects: { clone: noGitHub },
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await engine.stop().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(s, stop);
// The parent holds our stdin: when it dies (even killed), the pipe closes and the data dir goes with us.
process.stdin.on('end', stop).on('error', stop).resume();

const api = engine.url + '/api';
const json = { 'content-type': 'application/json' };
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(api + path, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`seed ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : ((await r.json()) as any);
};
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

// Past the first-run welcome sheet (it would cover the UI).
await call('PATCH', '/settings', { userName: 'Master', userAbout: 'Software engineer at a crypto data company.' });
for (const [id, role] of [
  ['munih', 'You are munih, a product engineer. You build features end to end, small and tested.'],
  ['paris', 'You are paris, a product designer. You make mockups and check the built UI with screenshots.'],
  ['zurich', 'You are zurich, the QA lead. You review pull requests, run the checks and report what you see.'],
]) await call('POST', '/agents', { id, rolePrompt: role, modelId: 'sonnet' });

// The one chat the screens test: a long history of mixed content (prose, a list, a table, code, a long unbroken word).
const chat = await call('POST', '/agents/atlas/chats');
const LONG_WORD = 'a_very_long_unbroken_identifier_that_must_wrap_or_scroll_instead_of_widening_the_page_'.repeat(2);
const turns: [string, string][] = [
  ['Can you give me the status of the release work?', 'Three tasks are in review, two are blocked on a question, and the rest are ready. The blocked ones need a decision from you.'],
  ['What is blocking the updater?', '## Updater\n\nThe installer needs a signed build. Steps left:\n\n- Sign the dmg\n- Upload it to the release\n- Check the update badge in Settings → About\n\nOnce signed, the badge appears within a minute.'],
  ['Show me the open tasks by owner.', '| Owner | Open | Blocked |\n| --- | --- | --- |\n| atlas | 4 | 1 |\n| munih | 7 | 0 |\n| paris | 3 | 1 |\n| zurich | 2 | 0 |\n\nmunih has the most open work.'],
  ['Which command runs the checks?', 'Run it from the clone:\n\n```sh\nnpm ci\nnpm run typecheck && npm test\nnpm run build && npm run ui:check\n```\n\nThe last step takes about 75 seconds.'],
  ['The log shows a long identifier, how does it look?', `The identifier is \`${LONG_WORD}\` and it has to stay inside the message.`],
  ...Array.from({ length: 10 }, (_, i): [string, string] => [`Question ${i + 1}: what changed in step ${i + 1}?`, `Step ${i + 1} changed the ${['board', 'inbox', 'library', 'settings', 'chat'][i % 5]} layout and its tests. Nothing else moved, and the check at four widths passed.`]),
];
for (const [q, a] of turns) {
  engine.kanban.appendMessage(chat.id, 'user', 'user', text(q));
  engine.kanban.appendMessage(chat.id, 'assistant', 'atlas', text(a));
}
await call('POST', '/agents/zurich/chats').then((c) => {
  engine.kanban.appendMessage(c.id, 'user', 'user', text('Review the latest PR.'));
  engine.kanban.appendMessage(c.id, 'assistant', 'zurich', text('Reviewed: CI green, the change list matches the task. One question on the changelog line.'));
});

// Tasks in every column; the longest brief is the one the side panel and the modal show.
const BRIEF = '## Goal\n\n' + Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: describe what the screen shows, what the user does, and what must not happen at 390 px.`).join('\n\n') + '\n\n## Done when\n\n' + Array.from({ length: 8 }, (_, i) => `- Check ${i + 1} passes at four widths`).join('\n');
const tasks: [string, string, string, string][] = [
  ['Triage the incoming bug reports', 'triage', '', ''],
  ['Write the release notes', 'todo', 'Short brief.', ''],
  ['Pick a storage layout for documents', 'ready', BRIEF, 'atlas'],
  ['Fix the sidebar scroll on phones', 'ready', 'The sidebar jumps when the keyboard opens.', 'munih'],
  ['Mockup for the Workspaces settings page', 'ready', 'Three states: sandbox ok, unavailable, change pending.', 'paris'],
  ['Review the pull request for the network levels', 'ready', 'Check the matrix on Mac.', 'zurich'],
  ['A very long task title that must end in an ellipsis instead of pushing the layout wider than the screen it is shown on', 'ready', 'Long title, short brief.', 'atlas'],
  ['Old export format', 'closed', 'Dropped.', ''],
  ['Ship the dark theme', 'done', 'Done and released.', 'paris'],
];
for (const [title, status, body, assignee] of tasks) await call('POST', '/cards', { title, status, body, ...(assignee ? { assignee } : {}) });

// Documents of every kind (the Library lists, the panel opens them).
const docs: [string, 'markdown' | 'html' | 'diagram' | 'url', string][] = [
  ['Release plan', 'markdown', '# Release plan\n\n## One\n\nText with a [link](https://example.com).\n\n## Two\n\n- a\n- b\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'],
  ['Spec: sandbox', 'markdown', '# Spec\n\n' + Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a longer document, so it scrolls.`).join('\n\n')],
  ['Mockup', 'html', '<!doctype html><title>Mockup</title><body style="font-family:sans-serif"><h1>Mockup</h1><p>A page.</p></body>'],
  ['Diagram', 'diagram', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#eef"/><circle cx="100" cy="50" r="30" fill="#66c"/></svg>'],
];
docs.push(['Atlas repository', 'url', 'https://github.com/csoylu/atlas']);
for (const [title, kind, content] of docs) engine.documents.create('atlas', { kind, title, content, ...(title.startsWith('Spec') ? { folder: 'Specs' } : {}) }, 'atlas');

// Memory: a few of each kind.
for (const [kind, scope, t] of [
  ['rule', 'global', 'Always answer in the language Master writes in.'],
  ['preference', 'global', 'Master prefers short answers with the result first.'],
  ['fact', 'shared', 'The repository is github.com/csoylu/atlas, default branch main.'],
  ['rule', 'agent:atlas', 'Triage every new report into a task before answering.'],
] as const) await call('POST', '/memories', { kind, scope, text: t });

console.log('PORT', new URL(engine.url).port);
