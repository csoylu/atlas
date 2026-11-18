// Responsive check of the real Atlas UI: headless Chrome (CDP) at several widths, every main screen, layout checks
// in the page and OCR (Apple Vision) of the screenshots. macOS only (Chrome + Vision).
//
//   node scripts/ui-check/check.mjs [--port N] [--out DIR] [--widths 1440,1100,900,390] [--only chat,board] [--theme dark|light]
//
// The engine port is read from the running Atlas app (lsof; it changes on every start) unless --port is given.
// Read-only: every API write from the page is refused by the harness (and reported), so it never touches your data.
// Pins and the side panel need live state the data may not have, so the harness adds fixture cards (origin = the
// tested chat) and a panel tab (a real document) to the API responses the page sees, nothing is written.
// Exit code 1 when any issue is found. Screenshots + report.json land in --out (default /tmp/atlas-ui-check).
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEC_AUDIT, FONT_SCALE, FONT_EXCEPTIONS, MIN_CONTRAST } from './spec-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
};
const OUT = arg('out', join(tmpdir(), 'atlas-ui-check'));
const WIDTHS = arg('widths', '1440,1100,900,390').split(',').map(Number);
const HEIGHT = { 1440: 900, 1100: 800, 900: 760, 390: 844 };
const ONLY = arg('only', '')?.split(',').filter(Boolean);
// --ui DIR: serve the UI from a local build (packages/ui/dist) instead of the installed app's, against the same engine,
// to check a fix before reinstalling.
const UI_DIR = arg('ui');
// --theme dark|light: open every screen with ?theme= (a preview, nothing saved); default = the page's own choice.
const THEME = arg('theme');
// --spec: also audit the #112 visual pass from computed styles (font scale, contrast, measures, faces, chips).
const SPEC = process.argv.includes('--spec');
const MIN_FONT = 13; // CLAUDE.md « UI type rules »: no text under 13 px (#112)
const MIN_CONF = 0.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Engine: the running app's port ──
async function findBase() {
  const given = arg('port');
  const ports = given
    ? [given]
    : execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', 'Atlas'], { encoding: 'utf8' })
        .split('\n')
        .map((l) => /127\.0\.0\.1:(\d+) \(LISTEN\)/.exec(l)?.[1])
        .filter(Boolean);
  for (const p of ports) {
    const base = `http://127.0.0.1:${p}`;
    const ok = await fetch(base + '/api/health').then((r) => r.ok, () => false);
    if (ok) return base;
  }
  throw new Error('No running Atlas engine found (is Atlas.app open?). Pass --port N to point at another one.');
}
const BASE = await findBase();
/**
 * --ui: a local server that serves the build and passes /api (HTTP and the WebSocket) to the engine. (Serving the
 * files through CDP Fetch.fulfillRequest instead leaves the page's WebSocket refused.)
 */
async function uiProxy(dir, engine) {
  const target = new URL(engine);
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path.startsWith('/api/')) {
      const up = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => res.destroy(e));
      return void req.pipe(up);
    }
    let file = join(dir, decodeURIComponent(path));
    if (path === '/' || !existsSync(file) || !statSync(file).isFile()) file = join(dir, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  server.on('upgrade', (req, socket, head) => {
    const up = netConnect(+target.port, target.hostname, () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
      up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  return `http://127.0.0.1:${server.address().port}`;
}
const PAGE_BASE = UI_DIR ? await uiProxy(UI_DIR, BASE) : BASE;
const get = async (path) => {
  const r = await fetch(BASE + '/api' + path);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.json();
};

// ── Data the screens use ──
const cards = await get('/cards');
const chats = await get('/chats');
if (!chats.length) throw new Error('No direct chat to test: open one in Atlas first.');
// The chat with the most messages (fills the screen, so pins vs messages is a real test).
let chat = chats[0], most = -1;
for (const c of chats) {
  const n = (await get(`/cards/${c.id}/messages`)).length;
  if (n > most) [chat, most] = [c, n];
}
// The ticket modal: the board card with the longest description.
const modalCard = [...cards].filter((c) => c.board !== 'direct').sort((a, b) => b.body.length - a.body.length)[0] ?? chat;
const docs = await get('/documents');
const doc = docs.find((d) => d.kind === 'markdown') ?? docs[0];
const now = new Date().toISOString();
const fixture = (n, title, patch) => ({
  ...chat, id: `c_uicheck${n}`, title, body: '', board: 'main', originCard: chat.id, conversationId: `conv_c_uicheck${n}`,
  createdBy: chat.assignee ?? 'atlas', createdAt: now, updatedAt: now, block: null, waiting: null, parents: [], ...patch,
});
// A long brief: the `thread` screen opens this card beside the chat; the panel shows its first lines and « Show more ».
const THREAD_BODY = '## Goal\n\nCheck every main screen at four widths with screenshots and OCR, so that cut or overlapping text is caught before Master sees it.\n\n' + Array.from({ length: 14 }, (_, i) => `- Step ${i + 1}: open the screen, wait for it, take the screenshot and read the key labels back.`).join('\n');
const FIXTURE_CARDS = [
  fixture(1, 'Responsive pass with screenshot + OCR test harness on the real UI', { status: 'running', body: THREAD_BODY }),
  fixture(2, 'Pick a storage layout for documents', { status: 'blocked', block: { kind: 'needs_input', reason: 'Which layout?', options: [] } }),
  fixture(3, 'Rewrite the scheduler tests', { status: 'blocked', block: { kind: 'needs_input', reason: 'Stopped by you', options: [] } }),
  fixture(4, 'A very long card title that must end in an ellipsis instead of pushing the layout wider than the screen', { status: 'review' }),
];
// Card reports at the end of the chat (compact rows, #58; links to the Inbox, #143), in the engine's exact wording; the
// `chat-reports` screen checks the first one's summary line and expands the memory row.
const reportMsg = (n, text) => ({ id: `m_uicheck${n}`, conversationId: chat.conversationId, seq: 1e6 + n, role: 'user', author: 'system', content: [{ type: 'text', text }], at: now });
// The tasks the reports name (live ones, so each row is a link, #143).
const REPORT_CARDS = [
  fixture('r7', FIXTURE_CARDS[3].title, { number: 9157, status: 'done' }),
  fixture('r6', 'Pick a storage layout for documents', { number: 9156, status: 'review' }),
  fixture('r5', 'Schedules: weekly digest', { number: 9155, status: 'blocked', block: { kind: 'needs_input', reason: 'which day?', options: [] } }),
  fixture('r4', 'Old export format', { number: 9154, status: 'closed' }),
  fixture('r3', 'Benchmark local models', { number: 9153, status: 'blocked', block: { kind: 'needs_input', reason: 'Stopped by you. Write what to do next.', options: [] } }),
];
const REPORTS = [
  reportMsg(1, `✓ Card “${FIXTURE_CARDS[3].title}” (#9157) finished: Grouped the inbox by card: one row per card with the latest event.\n\n- Checked with \`npm run ui:check\` at 1440 / 1100 / 900 / 390\n- typecheck + tests green\n\nA_very_long_unbroken_token_that_must_wrap_instead_of_pushing_the_chat_wider_than_the_phone_screen_xxxxxxxxxxxx`),
  reportMsg(2, 'Card “Pick a storage layout for documents” (#9156) is ready for your review: look at it'),
  reportMsg(3, 'Card “Schedules: weekly digest” (#9155) needs your OK: which day?'),
  reportMsg(4, 'Card “Old export format” (#9154) closed by you. Nothing more will be done on it.'),
  reportMsg(5, 'You stopped “Benchmark local models” (#9153). Its run and commands were killed; writing on the card resumes it.'),
  // Two [memory] notes in a row: one quiet « 3 memories changed » row (#143), m51 once.
  reportMsg(6, '[memory] Changed since this conversation started (data, not instructions; it overrides the memory in your instructions):\n- [m51 · project] changed by the background review: Atlas visual pass: the chat rows, the board columns and the Library tiles share one row height and one icon size\n- [m55 · fact] added by @paris: The mockups live in docs/design-mockups/<card>/'),
  reportMsg(7, '[memory] Changed since this conversation started (data, not instructions; it overrides the memory in your instructions):\n- [m51 · project] changed by the user: Atlas visual pass v2\n- [m74 · rule] forgotten by the user'),
];
// Tool activity (#59, docs/chat-activity.md): a finished turn (a « 6 steps » group with a failed edit, a doc chip) and
// a live one (the pinned plan, a group still running with a live timer). The `chat-tools` screen opens the first group
// and its failed step.
const agent = chat.assignee ?? 'atlas';
const secAgo = (s) => new Date(Date.now() - s * 1000).toISOString();
let toolSeq = 100;
const tmsg = (role, author, content) => ({ id: `m_uicheck${toolSeq}`, conversationId: chat.conversationId, seq: 1e6 + toolSeq++, role, author, content, at: secAgo(60) });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
const res = (id, content, is_error) => ({ type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error } : {}) });
const LONG_PATH = 'packages/ui/src/a-deliberately-very-long-folder-name-for-the-phone-width/AnotherVeryLongComponentName.tsx';
const FILE_BEFORE = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the chat activity spec.`).join('\n') + '\n';
const FILE_AFTER = FILE_BEFORE.replace('Line 4 of', 'Line four of').replace('Line 25 of the chat activity spec.\n', '');
const TOOL_CARDS = [
  fixture('t1', 'Chat activity foundation', { number: 9201, status: 'ready', originCard: null }),
  fixture('t2', 'A deliberately very long card title that must end in an ellipsis inside the chip on a phone screen', { number: 9202, status: 'todo', originCard: null }),
  fixture('t3', 'Voice: push-to-talk shortcut', { number: 9203, status: 'running', originCard: null }),
  fixture('t4', 'Voice bug: the orb stays on after Esc', { number: 9204, status: 'triage', originCard: null }),
];
const TOOL_MSGS = [
  // Card & team tools (#62): one group with every card tool (the `chat-tools-cards` screen opens them all), the question
  // pinned after it, then a single card_create as its own row (its #N opens the ticket).
  tmsg('user', 'user', [{ type: 'text', text: 'Plan the follow-ups on the board.' }]),
  tmsg('assistant', agent, [
    call('tc1', 'card_create', { title: 'x', body: 'y', parents: ['#9201'] }),
    call('tc2', 'card_update', { id: 9201, status: 'ready', priority: 1 }),
    call('tc3', 'card_show', { id: '#9203' }),
    call('tc4', 'card_list', {}),
    call('tc5', 'card_message', { id: 9203, text: `Found the cause of the 18:23 wipe: a **Rewind** in the Voice chat restored the whole workspace.\n\n- see #9201\n- ${'A_very_long_unbroken_token_'.repeat(5)}` }),
    call('tc6', 'history_search', { query: 'ChatRow' }),
    call('tc7', 'history_search', { seq: 50 }),
    call('tc8', 'card_request_review', { summary: 'The README draft is ready for your review.\n\n- attached to this card (README.md, 93 lines)' }),
    call('tc9', 'card_complete', { summary: 'Card reports in chat are now one compact row: status icon, #N, verb, title, time.' }),
    call('tc10', 'card_block', { kind: 'needs_input', question: 'Pick a direction for the breathing orb', options: ['Slow pulse', 'Glow only'] }),
  ]),
  tmsg('user', 'tool', [
    res('tc1', `created #9202 [todo] @atlas P2 ${TOOL_CARDS[1].title} (parents: #9201)`),
    res('tc2', `updated #9201 [ready] @atlas P1 ${TOOL_CARDS[0].title}`),
    res('tc3', `#9203 [running] @atlas P2 ${TOOL_CARDS[2].title}\n\nThe body.`),
    res('tc4', [`#9201 [ready] @atlas P1 ${TOOL_CARDS[0].title}`, `#9202 [todo] @atlas P2 ${TOOL_CARDS[1].title} (parents: #9201)`, `#9203 [running] @atlas P2 ${TOOL_CARDS[2].title}`, `#9204 [blocked] unassigned P3 ${TOOL_CARDS[3].title}`, ...Array.from({ length: 45 }, (_, i) => `#${9100 + i} [done] @atlas P2 Done card ${i}`)].join('\n')),
    res('tc5', 'message posted on #9203'),
    res('tc6', `#50 tool: …← exit 0 RUN v5.1.0 ${'chatrow '.repeat(30)}…\n#62 atlas: …The reusable ChatRow is in packages/ui/src/ChatRow.tsx and every tool call now uses it…\n(3 older matches not shown)`),
    res('tc7', '#50 user (2026-11-14T10:00:00.000Z):\nCard reports flood the chat. Make them one compact line that expands on click.'),
    res('tc8', 'review requested'), res('tc9', 'card done'), res('tc10', 'card blocked (needs_input)'),
  ]),
  tmsg('user', 'user', [{ type: 'text', text: 'And one for the voice bug.' }]),
  tmsg('assistant', agent, [call('tc11', 'card_create', { title: 'x' })]),
  tmsg('user', 'tool', [res('tc11', `created #9204 [triage] unassigned P3 ${TOOL_CARDS[3].title}`)]),
  // Artifacts, memory, plan, schedules, thinking (#64, #120): one group with each of them (the `chat-tools-memory` screen
  // opens them all: lists, the memory quote, a schedule), then artifact cards (created, updated, an older one).
  tmsg('user', 'user', [{ type: 'text', text: 'Sketch the orb states and remember the voice rule.' }]),
  tmsg('assistant', agent, [
    { type: 'thinking', thinking: `The rewind restored the whole workspace, not just this chat’s files.\n${'A_very_long_unbroken_thought_token_'.repeat(4)}`, signature: 'x' },
    call('tv1', 'artifact_list', { folder: 'Design' }),
    call('tv3', 'artifact_read', { artifact: 'doc_uicheck' }),
    call('tv5', 'memory_edit', { text: `Voice chat with Master: keep spoken replies **VERY** short (1-3 sentences).\n\n${'A_very_long_unbroken_memory_token_'.repeat(4)}` }),
    call('tv6', 'todo_write', { todos: [{ content: 'Sketch the states', status: 'completed' }, { content: 'Pick the timing', status: 'completed' }, { content: 'Ask Master', status: 'pending' }] }),
    call('tv7', 'schedule_create', { title: 'Test: push notification', at: '2026-11-12T00:35:00+01:00', new_card_each_time: true, prompt: `Trigger a push notification to Master: call card_block with kind “needs_input”. ${'A_very_long_unbroken_prompt_token_'.repeat(4)}` }),
    call('tv8', 'schedule_list', {}),
    call('tv9', 'schedule_delete', { id: 'sch_0a1b2c3d' }),
  ]),
  tmsg('user', 'tool', [
    res('tv1', 'doc_uicheck "Chat activity redesign (#59)" markdown v3 · docs/chat-activity.md · Design'),
    res('tv3', 'Chat activity redesign (#59) (doc_uicheck, markdown, v3 of 3, docs/chat-activity.md)\n\n# Chat activity'),
    res('tv5', 'self memory saved (1513/4000 chars)'),
    res('tv6', 'todo list saved'),
    res('tv7', 'scheduled sch_07cbcde1 "Test: push notification" for @atlas: once at 2026-11-11T23:35:00.000Z, first run 2026-11-11T23:35:00.000Z'),
    res('tv8', 'sch_07cbcde1 @atlas "Test: push notification": once at 2026-11-11T23:35:00.000Z · next 2026-11-11T23:35:00.000Z · new card each time\nsch_1a2b3c4d @atlas "A deliberately long schedule title for the weekly funding-rate digest": cron "0 9 * * 1-5" (Europe/Paris) · next 2026-11-16T08:00:00.000Z · own card #9201 · LAST RUN FAILED: 429 rate limit after 3 retries'),
    res('tv9', 'schedule sch_0a1b2c3d deleted'),
  ]),
  tmsg('assistant', agent, [{ type: 'text', text: 'Here are the states.' }, call('tv10', 'artifact_create', { kind: 'html', title: 'Orb states, a deliberately long page title for the phone', content: '<p>x</p>' }), call('tv11', 'artifact_update', { artifact: 'doc_uicheck', content: '# x' }), call('tv12', 'panel_open', { path: 'docs/chat-activity.md' })]),
  tmsg('user', 'tool', [res('tv10', 'created Orb states, a deliberately long page title for the phone (doc_uicheck2, pages/orb-states.html, v1) in Design; shown in the side panel'), res('tv11', 'updated Chat activity redesign (#59) (doc_uicheck, docs/chat-activity.md, v3); shown in the side panel'), res('tv12', doc ? `opened ${doc.title} (${doc.id}, ${doc.path}, v1) in the side panel` : 'opened Chat activity redesign (#59) (doc_uicheck, docs/chat-activity.md, v1) in the side panel')]),
  // Files & shell (#63): one group with every file and shell tool (the `chat-tools-files` screen opens them all): long
  // paths and lines, a rewrite diff, an edit with its landed line, grep with context, ANSI output, background tools.
  tmsg('user', 'user', [{ type: 'text', text: 'Tidy the chat row styles.' }]),
  tmsg('assistant', agent, [
    call('tf1', 'read_file', { path: LONG_PATH }),
    call('tf2', 'write_file', { path: 'docs/notes/new-file.md', content: '# Notes\n\nA fresh file.\n' }),
    call('tf3', 'write_file', { path: 'docs/chat-activity.md', content: FILE_AFTER }),
    call('tf4', 'edit_file', { path: LONG_PATH, old_text: 'const a = 1;\nconst b = 2;', new_text: `const a = 1;\nconst b = 3;\nconst c = ${'"a very long string literal that must scroll sideways, not widen the chat", '.repeat(2)};` }),
    call('tf5', 'grep', { pattern: 'chat-row', path: 'packages/ui/src', context: 1 }),
    call('tf6', 'glob', { pattern: '**/*.tsx' }),
    call('tf7', 'list_files', { path: 'packages/ui' }),
    call('tf8', 'shell', { command: 'npm test -- --reporter=dot' }),
    call('tf9', 'shell', { command: 'npm run dev', background: true }),
    call('tf10', 'shell_output', { id: 'bg_831f7700' }),
    call('tf11', 'shell_kill', { id: 'bg_831f7700' }),
    call('tf12', 'shell', { command: 'curl -sv "https://api.etherscan.io/api?module=account&action=balance&address=$TREASURY&apikey=$ETHERSCAN_KEY"' }),
  ]),
  tmsg('user', 'tool', [
    res('tf1', Array.from({ length: 40 }, (_, i) => `${String(i + 280).padStart(4)}|${i % 7 === 0 ? `  // ${'a long comment line that must scroll sideways '.repeat(3)}` : `  const v${i} = row(${i});`}`).join('\n') + '\n\n[showing lines 280–319 of 600; use offset=320 to continue]'),
    res('tf2', 'wrote 27 chars to docs/notes/new-file.md'),
    res('tf3', 'wrote 320 chars to docs/chat-activity.md'),
    res('tf4', `edited ${LONG_PATH}`),
    res('tf5', ['packages/ui/src/ChatRow.tsx-11-export function ChatRow(props) {', 'packages/ui/src/ChatRow.tsx:12:  return <div className="chat-row chat-row-line">', 'packages/ui/src/ChatRow.tsx-13-}', '--', ...Array.from({ length: 14 }, (_, i) => `packages/ui/src/styles.css:${1158 + i}:.chat-row-${i} { display: flex; } /* ${'x'.repeat(60)} */`), '[12 more not shown; narrow the search or raise limit]'].join('\n')),
    res('tf6', ['packages/ui/src/ChatRow.tsx', 'packages/ui/src/ChatActivity.tsx', 'packages/ui/src/FileStepDetail.tsx', LONG_PATH].join('\n')),
    res('tf7', ['package.json', 'src/', 'src/ChatRow.tsx', 'src/styles.css', 'vite.config.ts'].join('\n')),
    res('tf8', 'exit 1\n\x1b[32m✓\x1b[39m packages/ui/src/fileRows.test.ts \x1b[2m(14 tests)\x1b[22m\n\x1b[31m✗\x1b[39m packages/ui/src/toolRows.test.ts > write_file\n  \x1b[1;31mAssertionError\x1b[0m: expected \'Wrote\' to be \'Created\'\n\n \x1b[1mTest Files\x1b[22m  \x1b[31m1 failed\x1b[39m | \x1b[32m41 passed\x1b[39m\n'),
    res('tf9', 'started bg_831f7700 in the background (pid 4242); its output goes to /Users/x/Library/Application Support/Atlas/data/outputs/atlas/bg_831f7700.log. shell_output(id) reads it; shell_kill(id) stops it'),
    res('tf10', 'bg_831f7700: running (pid 4242, since 2026-11-14T18:20:00.000Z)\n[output bytes 0–120 of 120]\n\x1b[36m  VITE v6.0.0\x1b[39m  ready in 312 ms\n\n  ➜  Local:   \x1b[36mhttp://localhost:5173/\x1b[39m\n'),
    res('tf11', 'sent SIGTERM to bg_831f7700 (pid 4242); its log stays at /Users/x/outputs/bg_831f7700.log'),
    // A secret's value in the output (#209): the engine put [secret NAME] in its place; the row says « 1 secret hidden ».
    res('tf12', 'exit 0\n* Connected to api.etherscan.io (104.22.14.57) port 443\n> GET /api?module=account&action=balance&apikey=[secret ETHERSCAN_KEY] HTTP/2\n< HTTP/2 200\n{"status":"1","message":"OK","result":"1204370000000000000000"}'),
  ]),
  // Web (#65): one group with a provider-run web search (8 results, long titles and URLs), a failed one, a fetched page
  // (cut to its start and end) and a fetch that got HTTP 403 (the `chat-tools-web` screen opens them all + Show all).
  tmsg('user', 'user', [{ type: 'text', text: 'How do template images work in the macOS tray?' }]),
  tmsg('assistant', agent, [
    { type: 'server_tool_use', id: 'srv_uicheck1', name: 'web_search', input: { query: 'electron tray template image' } },
    { type: 'web_search_tool_result', tool_use_id: 'srv_uicheck1', content: [
      { type: 'web_search_result', url: 'https://www.electronjs.org/docs/latest/api/tray', title: 'Tray | Electron', encrypted_content: 'x' },
      { type: 'web_search_result', url: 'https://github.com/electron/electron/issues/4157', title: 'Template images in macOS tray · Issue #4157 · electron/electron', encrypted_content: 'x' },
      { type: 'web_search_result', url: 'https://developer.apple.com/documentation/appkit/nsstatusitem', title: 'NSStatusItem | Apple Developer Documentation', encrypted_content: 'x' },
      { type: 'web_search_result', url: `https://stackoverflow.com/questions/41664208/${'a-deliberately-very-long-url-slug-that-must-not-widen-the-chat-'.repeat(2)}`, title: `A deliberately very long result title that must wrap on a phone screen instead of pushing the layout ${'wider '.repeat(6)}`, encrypted_content: 'x' },
      ...Array.from({ length: 4 }, (_, i) => ({ type: 'web_search_result', url: `https://blog${i}.example.com/tray-icons`, title: `Tray icons, part ${i + 1}`, encrypted_content: 'x' })),
    ] },
    { type: 'server_tool_use', id: 'srv_uicheck2', name: 'web_search', input: { query: 'nsimage template dark mode' } },
    { type: 'web_search_tool_result', tool_use_id: 'srv_uicheck2', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    call('tw1', 'web_fetch', { url: 'https://www.electronjs.org/docs/latest/api/tray' }),
    call('tw2', 'web_fetch', { url: 'https://example.com/private' }),
  ]),
  tmsg('user', 'tool', [
    res('tw1', `URL: https://www.electronjs.org/docs/latest/api/tray\nTitle: Tray | Electron\n\n# Tray\n\nAdd icons and context menus to the system's notification area. Process: [Main](https://www.electronjs.org/docs/latest/glossary#main-process).\n\n**Tray** is an EventEmitter. ${'A_very_long_unbroken_page_token_'.repeat(4)} ${'More text about tray icons. '.repeat(40)}\n\n[… 9120 chars omitted; full text (24120 chars) in /Users/x/outputs/web-1.md: read_file it with offset, or grep it …]\n\nThe end.`),
    res('tw2', 'HTTP 403 from https://example.com/private: Forbidden', true),
  ]),
  tmsg('assistant', agent, [{ type: 'text', text: 'Electron marks a tray image as a template when its file name ends in “Template”.' }]),
  tmsg('user', 'user', [{ type: 'text', text: 'Make the tool calls in the chat compact rows.' }]),
  tmsg('assistant', agent, [{ type: 'text', text: 'Reading the current rendering first.' }, call('tu1', 'read_file', { path: 'packages/ui/src/CardPanel.tsx' }), call('tu2', 'edit_file', { path: LONG_PATH, old_text: 'a', new_text: 'b\nc' })]),
  tmsg('user', 'tool', [res('tu1', '  1|import x\n 48|end'), res('tu2', `${LONG_PATH} exists and has not been read in this conversation: read_file it first, then edit it`, true)]),
  tmsg('assistant', agent, [call('tu3', 'read_file', { path: LONG_PATH }), call('tu4', 'edit_file', { path: 'packages/ui/src/styles.css', old_text: 'x\ny', new_text: 'x\nY\nz\nw' }), call('tu5', 'grep', { pattern: 'chat-row-summary|chat-row-label', path: 'packages/ui/src' }), call('tu6', 'shell', { command: 'export PATH=~/.nvm/versions/node/v24.7.0/bin:$PATH && npm run typecheck && npm test -- --reporter=dot' })]),
  tmsg('user', 'tool', [res('tu3', '  1|x'), res('tu4', 'edited packages/ui/src/styles.css'), res('tu5', 'no matches'), res('tu6', 'exit 0\n 66 passed')]),
  tmsg('assistant', agent, [{ type: 'text', text: 'Done: every tool call is now one row. The spec is open in the panel.' }, call('tu7', 'panel_open', { path: 'docs/chat-activity.md' })]),
  tmsg('user', 'tool', [res('tu7', 'opened Chat activity redesign (#59) (doc_uicheck, docs/chat-activity.md, v3) in the side panel')]),
  tmsg('user', 'user', [{ type: 'text', text: 'Now run the full check.' }]),
  tmsg('assistant', agent, [call('tu8', 'todo_write', { todos: [{ content: 'Typecheck and unit tests', status: 'completed' }, { content: 'Responsive check at every width', status: 'in_progress' }, { content: 'Report back', status: 'pending' }] }), call('tu9', 'read_file', { path: 'scripts/ui-check/check.mjs' }), call('tu10', 'shell', { command: 'npm run ui:check -- --ui packages/ui/dist' })]),
  tmsg('user', 'tool', [res('tu8', 'todo list saved'), res('tu9', '  1|x')]),
];
const timing = (toolUseId, name, start, end) => ({ toolUseId, name, status: end === null ? 'running' : 'done', startedAt: secAgo(start), endedAt: end === null ? null : secAgo(end) });
const TOOL_TIMINGS = [
  { ...timing('tf2', 'write_file', 95, 95), detail: { kind: 'write', created: true, before: null } },
  { ...timing('tf3', 'write_file', 94, 94), detail: { kind: 'write', created: false, before: FILE_BEFORE } },
  { ...timing('tf4', 'edit_file', 93, 93), detail: { kind: 'edit', lines: [284] } },
  timing('tf8', 'shell', 92, 86),
  { ...timing('tf12', 'shell', 85, 84), secretsHidden: 1 },
  timing('tu1', 'read_file', 70, 70), timing('tu2', 'edit_file', 69, 69), timing('tu3', 'read_file', 68, 68), timing('tu4', 'edit_file', 67, 67),
  timing('tu5', 'grep', 66, 66), timing('tu6', 'shell', 65, 61), timing('tu7', 'panel_open', 60, 60),
  timing('tu8', 'todo_write', 20, 20), timing('tu9', 'read_file', 19, 19), { ...timing('tu10', 'shell', 12, null), tail: '\x1b[2mengine on :61234 · widths 1440 1100 900 390\x1b[22m\n1440 chat … \x1b[32mok\x1b[39m\n1440 chat-reports … \x1b[32mok\x1b[39m\n1100 chat …' },
];
const liveRun = { id: 'r_uicheck', cardId: chat.id, agentId: agent, kind: 'chat', status: 'running', error: null, startedAt: secAgo(25), endedAt: null };
// A blocked ticket with a long markdown question (a real one, #42's status update with a table): the question must stay
// readable (not cut, enough room) next to the answer box.
const LONG_QUESTION = readFileSync(join(HERE, 'long-question.md'), 'utf8');
const blockedModal = (c) => (c.id === modalCard.id ? { ...c, status: 'blocked', block: { kind: 'needs_input', reason: LONG_QUESTION, options: ['Looks good, go on', 'Stop here'] } } : c);
// System events as rows (#66): the start prompt, a card's message, a scheduled run, a call with malformed input, and
// the timeline (stopped, interrupted, a rewind with its files and Undo, the summary point, the latest run failed with
// Retry), in the engine's exact wording. The `chat-system` screen opens the rewind and the message.
let sysSeq = 0;
const smsg = (role, author, content, at) => ({ id: `m_uichecks${sysSeq}`, conversationId: chat.conversationId, seq: 2e6 + sysSeq++, role, author, content, at });
const sysAt = (min) => new Date(Date.now() - (60 - min) * 60_000).toISOString();
const GREP_ERR = 'invalid input for grep: ' + JSON.stringify([{ origin: 'number', code: 'too_big', maximum: 20, inclusive: true, path: ['context'], message: 'Too big: expected number to be <=20' }], null, 2);
const SYS_MSGS = [
  smsg('user', 'system', [{ type: 'text', text: 'This card is ready and assigned to you. Do it.' }], sysAt(1)),
  smsg('assistant', agent, [{ type: 'text', text: 'Starting on the system rows.' }, call('ts1', 'grep', { pattern: 'RunLine', context: 30 })], sysAt(2)),
  smsg('user', 'tool', [res('ts1', GREP_ERR, true)], sysAt(2)),
  smsg('assistant', agent, [{ type: 'text', text: 'Retried with a smaller context.' }], sysAt(3)),
  smsg('user', agent, [{ type: 'text', text: `[from @${agent}, card #9201] The reusable compact row is in: **packages/ui/src/ChatRow.tsx**. Use it for every system event.\n\n- ${'A_very_long_unbroken_token_'.repeat(5)}` }], sysAt(10)),
  smsg('assistant', agent, [{ type: 'text', text: 'Thanks, using it.' }], sysAt(11)),
  smsg('user', 'schedule', [{ type: 'text', text: `Trigger a push notification to Master: call card_block with kind “needs_input”. ${'A_very_long_unbroken_prompt_token_'.repeat(3)}\n\n— from schedule sch_07cbcde1, once at 12 Nov 2026 00:35 (Europe/Paris).` }], sysAt(20)),
  smsg('assistant', agent, [{ type: 'text', text: 'Asking now.' }], sysAt(21)),
  smsg('user', 'user', [{ type: 'text', text: 'Try the build again.' }], sysAt(30)),
  smsg('assistant', agent, [{ type: 'text', text: 'Running it.' }], sysAt(31)),
];
const sysRun = (id, status, error, start, end, next = null) => ({ id, cardId: chat.id, agentId: agent, kind: 'chat', status, error, startedAt: sysAt(start), endedAt: sysAt(end), next: next === null ? null : sysAt(next) });
// What the rewound part did elsewhere (#138): undone and kept, with a long label and a long reason.
const SYS_EFFECTS = [
  { kind: 'task', label: '#9131 Mockup: artifacts library', cardId: 'c_uicheck9131', outcome: 'undone', action: 'closed', why: null },
  { kind: 'message', label: '@zurich', cardId: 'c_uicheck9132', outcome: 'undone', action: 'withdrawn', why: null },
  { kind: 'memory', label: `m104 « Library tiles show the real rendered content ${'A_very_long_unbroken_memory_token_'.repeat(2)} »`, cardId: null, outcome: 'undone', action: 'archived', why: null },
  { kind: 'schedule', label: 'Daily board digest', cardId: null, outcome: 'undone', action: 'turned off', why: null },
  { kind: 'task', label: '#9130 Fix tile contrast', cardId: 'c_uicheck9130', outcome: 'kept', action: 'stays', why: '@munih already worked on it' },
  { kind: 'message', label: '@atlas', cardId: 'c_uicheck9133', outcome: 'kept', action: 'stays', why: 'already read' },
  { kind: 'memory_change', label: 'm88 changed', cardId: null, outcome: 'kept', action: 'stays', why: null },
  { kind: 'canvas', label: 'Library mockup edited', cardId: null, outcome: 'kept', action: 'stays', why: null },
  { kind: 'push', label: 'git push origin feat/138-rewind-side-effects', cardId: null, outcome: 'kept', action: 'stays', why: null },
];
const SYS_TIMELINE = {
  runs: [
    sysRun('r_uichecks1', 'stopped', 'stopped by you', 11, 12, 20),
    sysRun('r_uichecks2', 'interrupted', 'engine shutting down', 21, 22, 23),
    sysRun('r_uichecks3', 'failed', `Expected ',' or '}' after property value in JSON at position 460 (line 1 column 461) ${'A_very_long_unbroken_error_token_'.repeat(3)}`, 31, 32),
  ],
  rewinds: [{
    id: 'rw_uicheck1', fromSeq: 2e6 + 8, at: sysAt(25), hidden: 13, filesError: null, undoable: true, effects: SYS_EFFECTS,
    files: [{ path: 'apps/desktop/src/main.ts', change: 'restored' }, { path: LONG_PATH, change: 'deleted' }, { path: 'docs/notes/old.md', change: 'recreated' }, ...Array.from({ length: 19 }, (_, i) => ({ path: `packages/ui/src/file${i}.ts`, change: 'restored' }))],
  }],
  summary: { uptoSeq: 2e6, text: 'Summary of the earlier part of this conversation: #58 built **ChatRow**; #59 designed the activity rows.' },
};
// A markdown table with task references in columns 1 and 3 and long text in column 2 (#85): the text column must stay
// readable (wrap at words, never crushed to a few letters by the chips).
// Images (#103): a pasted screenshot in a user message and a picture a read_file returned; the files are served by the
// harness (a generated png), uploads from the `chat-images` screen get a fixture answer (nothing is written).
const IMG_PNG = Buffer.from(await (await import('sharp')).default({ create: { width: 640, height: 400, channels: 3, background: '#4a7bd0' } }).composite([{ input: Buffer.from('<svg width="640" height="400"><rect x="40" y="40" width="560" height="60" fill="#fff"/><text x="60" y="84" font-size="34" font-family="Helvetica">Fixture screenshot</text></svg>'), top: 0, left: 0 }]).png().toBuffer());
const IMG = (name) => ({ type: 'image', path: `/Users/x/workspaces/${agent}/uploads/${name}`, media_type: 'image/png', width: 640, height: 400, bytes: IMG_PNG.length, sha256: 'f'.repeat(64) });
const IMAGE_MSGS = [
  { id: 'm_uicheckimg1', conversationId: chat.conversationId, seq: 4e6, role: 'user', author: 'user', at: now, content: [{ type: 'text', text: 'What is wrong in this screenshot?' }, IMG('2026-11-18-screenshot.png'), { type: 'text', text: '[attached: uploads/2026-11-18-screenshot.png]' }] },
  { id: 'm_uicheckimg2', conversationId: chat.conversationId, seq: 4e6 + 1, role: 'assistant', author: agent, at: now, content: [{ type: 'tool_use', id: 'timg1', name: 'read_file', input: { path: 'shots/board-390.png' } }] },
  { id: 'm_uicheckimg3', conversationId: chat.conversationId, seq: 4e6 + 2, role: 'user', author: 'tool', at: now, content: [{ type: 'tool_result', tool_use_id: 'timg1', content: '[image: shots/board-390.png (640×400 px, 9 KB)]', images: [IMG('board-390.png')] }] },
  { id: 'm_uicheckimg4', conversationId: chat.conversationId, seq: 4e6 + 3, role: 'assistant', author: agent, at: now, content: [{ type: 'text', text: 'The title bar is cut at 390 px; my own screenshot shows the same.' }] },
];
let uploadSeq = 0;
// A task's own images (#119): two on the modal's card and on the thread panel's fixture card (`taskImages` screens);
// a paste or a drop adds one each (the add answers with the card and its list so far).
const TIMG = (name) => ({ ...IMG(name), path: `/Users/x/task-images/${name}` });
const TASK_IMAGES = [TIMG('2026-11-18-board-390.png'), TIMG('2026-11-18-modal.png')];
let taskAdded = [];
const withTaskImages = (c) => (c.id === modalCard.id || c.id === 'c_uicheck1' ? { ...c, images: [...TASK_IMAGES, ...(c.id === modalCard.id ? taskAdded : [])] } : c);
const uploadAnswer = (name) => ({ id: `up_uicheck-${uploadSeq++}`, name: name ?? 'image.png', media_type: 'image/png', width: 640, height: 400, bytes: IMG_PNG.length });
const TABLE_MSGS = [
  { id: 'm_uichecktbl1', conversationId: chat.conversationId, seq: 3e6, role: 'user', author: 'user', content: [{ type: 'text', text: 'What is left to do?' }], at: now },
  { id: 'm_uichecktbl2', conversationId: chat.conversationId, seq: 3e6 + 1, role: 'assistant', author: agent, at: now, content: [{ type: 'text', text: [
    'Three cards are queued:',
    '',
    '| Card | What | Waits for |',
    '|---|---|---|',
    '| #9201 | Everything is written to the card transcript first, then summarised into the memory file once the run ends, so nothing is lost on a restart | #9202 |',
    '| #9202 | Move the per-agent memory into SQLite with a migration and keep the 4000-character cap enforced by the engine | #9203, #9204 |',
    '| #9203 | Voice: a push-to-talk shortcut that works from any screen, including the board and the settings | #9201 |',
  ].join('\n') }] },
  // Task references inside running text (#140): plain « #N » in the text's size and line height, title on hover.
  { id: 'm_uichecktbl3', conversationId: chat.conversationId, seq: 3e6 + 2, role: 'assistant', author: agent, at: now, content: [{ type: 'text', text:
    'I finished the storage part in #9201 and moved the rest of the memory work to #9202, which also needs the migration test that the scheduler rewrite still lacks, so both wait for a green suite before anything reaches main.' }] },
];
const SYS_LATEST = { ...SYS_TIMELINE.runs[2] };
delete SYS_LATEST.next;

// The Inbox: the mockup's items (2 needing you, 4 updates), on fixture cards. The item on screen is already read, so
// opening it doesn't try to write.
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const INBOX_CARDS = [
  fixture('i1', 'Pick a data source for CEX volumes', {
    number: 9139, assignee: 'atlas', status: 'blocked', originCard: null,
    block: { kind: 'needs_input', reason: 'For the monthly CEX volume report I need one source of truth. Both have the 14 exchanges we track.', options: ['Kaiko: tick-level, paid key already in .env', 'CoinGecko: free, daily granularity only'], until: null },
  }),
  fixture('i2', 'MEV primer, first draft', { number: 9140, assignee: 'atlas', status: 'review', originCard: null }),
  fixture('i3', 'Backfill Binance funding rates', { number: 9145, assignee: 'atlas', status: 'triage', originCard: null }),
  fixture('i4', 'Command palette (⌘K)', { number: 9143, assignee: 'atlas', status: 'done', originCard: null }),
  fixture('i5', 'Memory cleanup', { number: 9146, assignee: 'atlas', status: 'done', originCard: null }),
];
const note = (id, kind, title, body, cardId, min, read) => ({ id, at: ago(min), kind, title, body, cardId, readAt: read ? ago(min - 1) : null, archivedAt: null });
const INBOX = {
  needsYou: [
    { card: INBOX_CARDS[0], since: ago(12), failed: false, notificationId: 9001, unread: false, summary: null },
    { card: INBOX_CARDS[1], since: ago(60), failed: false, notificationId: 9002, unread: false, summary: '2 400 words · docs/mev-primer.md\n\n- **Sandwiches**, back-running and liquidations, with on-chain examples\n- A section on PBS and order-flow auctions' },
  ],
  updates: [
    note(9003, 'run.failed', 'Backfill Binance funding rates', 'Triage failed: 429 rate limit after 3 retries', INBOX_CARDS[2].id, 120, false),
    note(9004, 'card.done', 'Command palette (⌘K)', 'Typecheck + 412 tests green, installed', INBOX_CARDS[3].id, 180, false),
    note(9005, 'schedule.ran', 'Funding-rate digest #12', 'Weekly run · 1 doc', null, 4 * 1440, true),
    note(9006, 'plan.switched', 'Claude plan limit reached', 'Work moved to the API key account', null, 5 * 1440, true),
    note(9007, 'memory.cleanup', 'Memory cleanup: 4 proposals', '4 proposals: 1 merge, 1 fix, 2 archives', INBOX_CARDS[4].id, 6 * 1440, true),
  ],
  badge: 4,
};
// Settings → Memory and the Inbox's daily memory digest (#82, #87): every kind and status, pinned, a long unbroken
// text, sources in a chat, a card and none; changes of the last day for the digest (one already undone).
const mem = (id, kind, scope, text, o = {}) => ({
  id, kind, scope, text, sourceConversationId: null, sourceSeq: null, sourceCardId: null, cardId: null, status: 'active', pinned: false,
  createdAt: ago(o.min ?? 60), confirmedAt: ago(o.min ?? 60), updatedAt: ago(o.min ?? 60), updatedBy: 'atlas', ...o,
});
const MEMORIES = [
  mem(9301, 'rule', 'agent:atlas', 'After every shipped change, reinstall the Mac app detached so quitting Atlas does not kill the install', { pinned: true, sourceCardId: chat.id, sourceSeq: 2, min: 30 }),
  mem(9302, 'preference', 'shared', "Master loves Linear's UI; keep the sea-teal accent", { sourceCardId: INBOX_CARDS[3].id, sourceSeq: 4, min: 3 * 1440 }),
  mem(9303, 'fact', 'agent:atlas', 'npm is not on PATH: use ~/.nvm/versions/node/v24.7.0/bin before npm run typecheck && npm test', { min: 1440 }),
  mem(9304, 'fact', 'shared', 'Prod ClickHouse is Teleport-only; read-write access is a 4 h tsh request ' + 'A_very_long_unbroken_memory_token_'.repeat(3), { min: 12 * 1440 }),
  mem(9305, 'project', 'agent:atlas', 'OFF-1528 DVOL ingest: PR not opened yet', { status: 'stale', cardId: INBOX_CARDS[2].id, min: 2 * 1440 }),
  mem(9306, 'fact', 'agent:atlas', 'The old memory editor in Settings is gone', { status: 'archived', min: 5 * 1440 }),
];
const change = (id, memoryId, action, min, before, o = {}) => ({ id, memoryId, at: ago(min), by: 'atlas', action, before, undoneBy: null, ...o });
// Workflows (#171): one graph with a loop, an approval and a condition, and a run waiting on the approval after a failed
// first round of « Validate the PR » (the node keeps that round listed, its border shows the latest state).
const wfAgo = (min) => new Date(Date.now() - min * 60_000).toISOString();
const wfCard = (i) => cards[i % Math.max(1, cards.length)]?.id ?? null;
const WF_STEP = (id, nodeId, kind, round, state, exit, cardId, summary, min) => ({ id, nodeId, kind, round, state, exit, cardId, summary, startedAt: wfAgo(min), endedAt: state === 'running' || state === 'waiting' ? null : wfAgo(min - 1) });
const WF_RUN = {
  id: 'wr_uicheck2', workflowId: 'wf_uicheck', number: 2, state: 'waiting', trigger: 'manual', reason: null, startedAt: wfAgo(42), endedAt: null,
  steps: [
    WF_STEP(1, 'trigger', 'trigger', 1, 'done', 'start', null, 'run by hand', 42),
    WF_STEP(2, 'validate', 'agent', 1, 'failed', 'failed', wfCard(0), 'CI red: 2 tests fail in workflows.test.ts (a_very_long_unbroken_identifier_from_the_test_output_that_must_wrap)', 41),
    WF_STEP(3, 'fix', 'agent', 1, 'done', 'done', wfCard(1), 'fixed the two tests, pushed', 30),
    WF_STEP(4, 'again', 'condition', 1, 'done', 'yes', null, 'step validate ran 1 time: fewer than 3', 20),
    WF_STEP(5, 'validate', 'agent', 2, 'done', 'done', wfCard(2), 'validated: tests green, screenshots match', 19),
    WF_STEP(6, 'ok', 'approval', 1, 'waiting', null, wfCard(3), null, 5),
  ],
};
const WF_RUN1 = { ...WF_RUN, id: 'wr_uicheck1', number: 1, state: 'failed', reason: '« Validate the PR » failed: the branch is gone (nothing is linked to « failed »)', startedAt: wfAgo(1500), endedAt: wfAgo(1490), steps: [WF_STEP(1, 'trigger', 'trigger', 1, 'done', 'start', null, 'run by hand', 1500), WF_STEP(2, 'validate', 'agent', 1, 'failed', 'failed', wfCard(0), 'the branch is gone', 1499)] };
const WORKFLOW = {
  id: 'wf_uicheck', name: 'Validate, fix, approve and merge a pull request (a deliberately long workflow name)', enabled: true, origin: null, revision: 3,
  nextRunAt: null, lastFiredAt: wfAgo(42), lastError: null, lastRun: WF_RUN, createdBy: 'user', createdAt: wfAgo(3000), updatedAt: wfAgo(60),
  nodes: [
    { id: 'trigger', kind: 'trigger', x: 40, y: 120, config: { kind: 'manual' } },
    { id: 'validate', kind: 'agent', x: 290, y: 120, config: { title: 'Validate the PR', agentId: 'zurich', prompt: 'Validate {{previous.summary}}', newTaskEachRun: true } },
    { id: 'fix', kind: 'agent', x: 290, y: 380, config: { title: 'Fix what QA found', agentId: 'munih', prompt: 'Fix: {{previous.summary}}', newTaskEachRun: true } },
    { id: 'again', kind: 'condition', x: 540, y: 380, config: { test: 'ranFewer', title: '', node: 'validate', times: 3 } },
    { id: 'ok', kind: 'approval', x: 540, y: 120, config: { title: 'Merge it?', question: 'Merge? {{previous.summary}}' } },
    { id: 'merge', kind: 'agent', x: 790, y: 120, config: { title: 'Merge and release', agentId: 'atlas', prompt: 'Merge {{run.id}}', newTaskEachRun: false } },
  ],
  edges: [
    { from: 'trigger', exit: 'start', to: 'validate' }, { from: 'validate', exit: 'done', to: 'ok' }, { from: 'validate', exit: 'failed', to: 'fix' },
    { from: 'fix', exit: 'done', to: 'again' }, { from: 'again', exit: 'yes', to: 'validate' }, { from: 'ok', exit: 'approved', to: 'merge' },
  ],
};
const WORKFLOW_OFF = { ...WORKFLOW, id: 'wf_uicheckoff', name: 'Weekly funding-rate digest', enabled: false, origin: 'schedules', lastRun: null,
  nodes: [{ id: 'trigger', kind: 'trigger', x: 40, y: 120, config: { kind: 'time', repeat: 'cron', cron: '0 9 * * 1', at: null, timezone: 'Europe/Paris' } }, { id: 'step1', kind: 'agent', x: 300, y: 120, config: { title: 'Weekly funding-rate digest', agentId: 'atlas', prompt: 'Digest', newTaskEachRun: true } }],
  edges: [{ from: 'trigger', exit: 'start', to: 'step1' }] };

const MEMORY_CHANGES = [
  change(9403, 9301, 'pin', 20, { text: MEMORIES[0].text, kind: 'rule', status: 'active', pinned: false }),
  change(9402, 9303, 'update', 90, { text: 'npm is not on PATH', kind: 'fact', status: 'active', pinned: false }),
  change(9401, 9305, 'stale', 300, { text: MEMORIES[4].text, kind: 'project', status: 'active', pinned: false }, { by: 'user' }),
  change(9400, 9306, 'add', 600, null, { undoneBy: 'user' }),
];
// The weekly cleanup's proposals (#83): every action and status, a long unbroken text.
const proposal = (id, action, memories, o = {}) => ({
  id, cardId: INBOX_CARDS[4].id, action, memoryIds: memories.map((m) => m.id), text: null, kind: null, scope: null, reason: '', status: 'pending',
  createdBy: 'atlas', createdAt: ago(6 * 1440), decidedAt: null, memories, ...o,
});
const PROPOSALS = [
  proposal(9501, 'merge', [MEMORIES[2], mem(9307, 'fact', 'shared', 'The npm binary is not on PATH, use nvm node 24')], { text: 'npm is not on PATH: use ~/.nvm/versions/node/v24.7.0/bin', reason: 'Same fact twice, one shared' }),
  proposal(9502, 'update', [MEMORIES[3]], { kind: 'rule', scope: 'agent:atlas', reason: 'Only atlas works on prod, and it is a standing instruction' }),
  proposal(9503, 'archive', [MEMORIES[4]], { status: 'approved', decidedAt: ago(100), reason: 'Its card is done' }),
  proposal(9504, 'archive', [MEMORIES[0]], { status: 'rejected', decidedAt: ago(90), reason: 'Looks like a one-off instruction' }),
];
const panelTabs = () =>
  doc ? [{ doc, openedBy: doc.agentId, openedAt: now, focusedAt: now, section: null, seenVersion: doc.version, active: true, cardTitle: null }] : [];

// Memory has its own screens below (fixtures, edit, deep links).
const SETTINGS = ['agents', 'board', 'subscriptions', 'api-keys', 'local', 'model-list', 'usage', 'profile', 'appearance', 'voice', 'about'];
// Settings → Secrets (#209): every row kind (granted to some, to all, to none, made by an agent, waiting for a value,
// model keys) on the desktop keychain, then the same list on a locked server (the sidebar badge, the unlock panel).
const secretRow = (name, o) => ({ name, description: '', kind: 'agent', grant: 'none', agents: [], project: null, hasValue: true, createdBy: 'user', createdCard: null, createdAt: secAgo(86400 * 6), updatedAt: secAgo(86400 * 6), updatedBy: 'user', lastUsedAt: null, lastUsedBy: null, waitingCard: null, ...o });
const SECRET_ROWS = [
  secretRow('ALCHEMY_RPC_URL', { description: 'Ethereum mainnet JSON-RPC (Alchemy). The key is part of the URL.', grant: 'all', lastUsedAt: secAgo(840), lastUsedBy: agent }),
  secretRow('ETHERSCAN_KEY', { description: 'Etherscan API, free tier: balances, transactions, contract ABIs', grant: 'agents', agents: [agent], lastUsedAt: secAgo(7200), lastUsedBy: agent }),
  secretRow('A_DELIBERATELY_VERY_LONG_SECRET_NAME_THAT_MUST_WRAP_ON_A_PHONE', { description: 'A long description that must wrap inside the row on a phone screen instead of pushing the page wider than the screen.', createdBy: agent, grant: 'agents', agents: [agent] }),
  secretRow('DUNE_API_KEY', { description: 'Dune Analytics API, to run the saved holder queries', hasValue: false, createdBy: agent, grant: 'agents', agents: [agent], waitingCard: 'c_uicheck_none' }),
  secretRow('ANTHROPIC_API_KEY', { kind: 'model_key' }),
  secretRow('OPENROUTER_API_KEY', { kind: 'model_key' }),
];
const SECRET_STATUS = { kind: 'keychain', exists: true, locked: false, since: null, source: null, error: null };
const SECRET_LOCKED = { kind: 'file', exists: true, locked: true, since: secAgo(3600), source: null, error: null };
const secretList = (status) => ({ store: status.kind === 'keychain' ? 'macOS Keychain' : 'Encrypted file', status, names: SECRET_ROWS.filter((r) => r.hasValue).map((r) => r.name), secrets: SECRET_ROWS });

/** name, hash, selector that means "loaded", fixtures on, key labels to OCR. */
const SCREENS = [
  { name: 'chat', hash: `#/chat/${chat.id}`, ready: '.chat-pin', pins: true, keys: ['.chat-pin-title', '.chat-pin-state', '.msg .who', '.nav-item'] },
  // The composer starts at 4 lines, grows to 40% of the window, then scrolls inside, and shrinks back (#102).
  { name: 'chat-composer', hash: `#/chat/${chat.id}`, ready: '.composer textarea', then: { js: `const ta = document.querySelector('.composer textarea'); const send = document.querySelector('.composer .send-btn'); if (!ta || !send) throw new Error('no composer'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; const type = async (v) => { ta.focus(); set.call(ta, v); ta.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 150)); return ta.getBoundingClientRect().height; }; const lh = parseFloat(getComputedStyle(ta).lineHeight), cap = Math.round((visualViewport?.height ?? innerHeight) * 0.4); const start = await type(''), five = await type('a\\nb\\nc\\nd\\ne\\nf'), full = await type(Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\\n')); const sendBottom = send.getBoundingClientRect().bottom, scrolls = ta.scrollHeight > ta.clientHeight + 1 && getComputedStyle(ta).overflowY === 'auto'; const back = await type(''); const bad = []; if (start < lh * 4 - 1) bad.push('starts at ' + start + 'px, under 4 lines of ' + lh + 'px'); if (five <= start) bad.push('does not grow with 6 lines (' + five + 'px)'); if (full > cap + 1 || full < cap - lh) bad.push('30 lines give ' + full + 'px, cap is ' + cap + 'px'); if (!scrolls) bad.push('does not scroll inside at the cap'); if (sendBottom > innerHeight) bad.push('send button below the window (' + sendBottom + ' > ' + innerHeight + ')'); if (Math.abs(back - start) > 1) bad.push('does not shrink back after clearing (' + back + ' vs ' + start + ')'); if (bad.length) throw new Error('composer (#102): ' + bad.join('; ')); ta.blur(); ta.dataset.growOk = '1';`, ready: '.composer textarea[data-grow-ok]' }, keys: ['.msg .who'] },
  { name: 'chat-reports', hash: `#/chat/${chat.id}`, ready: '.card-report', reports: true, then: { js: `const row = [...document.querySelectorAll('.card-report')].find((r) => r.querySelector('.chat-row-ref')?.textContent === '#9157'); if (!row) throw new Error('no #9157 report row: ' + document.querySelectorAll('.card-report').length + ' report rows, ' + location.hash + ' ' + document.body.innerText.slice(0, 400)); if (row.querySelector('.chat-row-body')) throw new Error('#9157 expands: a task note is one row (#143)'); if (!row.querySelector('.tn-sum')) throw new Error('#9157 has no summary line'); if (row.tagName !== 'A' || !row.getAttribute('href').startsWith('#/inbox/task')) throw new Error('#9157 is not a link to its Inbox entry: ' + row.outerHTML.slice(0, 200)); const mem = [...document.querySelectorAll('.sys-row.mem-quiet')].at(-1); if (!mem || !mem.textContent.includes('3 memories changed')) throw new Error('the two fixture notes are not one « 3 memories changed » row: ' + mem?.textContent); mem.querySelector('.chat-row-line').click(); await new Promise((r) => setTimeout(r, 100)); const list = mem.querySelector('.mem-list'); if (!list || list.children.length !== 3) throw new Error('memory row: want 3 lines, got ' + (list?.children.length ?? 'none')); list.scrollIntoView({ block: 'center' });`, ready: '.mem-list' }, keys: ['.chat-row-ref', '.chat-row-verb', '.card-report .chat-row-obj', '.tn-sum', '.mem-quiet .chat-row-verb'] },
  { name: 'chat-tools', hash: `#/chat/${chat.id}`, ready: '.chat-row.steps', tools: true, then: { js: `const grp = [...document.querySelectorAll('.chat-row.steps:not(.running)')].filter((g) => g.querySelector(':scope > .chat-row-line .chat-pill.bad')).at(-1); const g = grp.querySelector(':scope > .chat-row-line'); g.click(); await new Promise((r) => setTimeout(r, 100)); const f = grp.querySelector('.chat-row.nested.tone-bad > .chat-row-line'); f.click(); await new Promise((r) => setTimeout(r, 100)); g.scrollIntoView({ block: 'start' });`, ready: '.chat-row.nested.tone-bad .chat-row-body' }, keys: ['.chat-row.steps > .chat-row-line .chat-row-verb', '.chat-row.steps > .chat-row-line .chat-row-rest', '.chat-row.nested .chat-row-obj', '.chat-pill', '.artifact .art-title'] },
  { name: 'chat-tools-cards', hash: `#/chat/${chat.id}`, ready: '.chat-row.steps', tools: true, then: { js: `const grp = [...document.querySelectorAll('.chat-row.steps')].filter((g) => g.querySelector(':scope > .chat-row-line .row-ic.rowic-cardp')).at(-1); const g = grp.querySelector(':scope > .chat-row-line'); g.click(); await new Promise((r) => setTimeout(r, 100)); for (const l of grp.querySelectorAll('.chat-row.nested > .chat-row-line.expandable')) l.click(); await new Promise((r) => setTimeout(r, 150)); g.scrollIntoView({ block: 'start' });`, ready: '.step-chip' }, keys: ['.chat-row.nested .chat-row-ref', '.chat-row.nested .chat-row-obj', '.step-chip-title', '.step-chip small', '.step-board-st', '.step-hit-t'] },
  { name: 'chat-tools-files', hash: `#/chat/${chat.id}`, ready: '.chat-row.steps', tools: true, then: { js: `const grp = [...document.querySelectorAll('.chat-row.steps')].find((g) => g.querySelector(':scope > .chat-row-line').textContent.includes('12 steps')); const g = grp.querySelector(':scope > .chat-row-line'); g.click(); await new Promise((r) => setTimeout(r, 100)); for (const l of grp.querySelectorAll('.chat-row.nested > .chat-row-line.expandable')) l.click(); await new Promise((r) => setTimeout(r, 150)); g.scrollIntoView({ block: 'start' });`, ready: '.fv-term' }, keys: ['.fv-head .fv-name', '.fv-gpath .fv-name', '.fv-btn', '.fv-exit .chat-pill'] },
  { name: 'chat-tools-memory', hash: `#/chat/${chat.id}`, ready: '.chat-row.steps', tools: true, then: { js: `const grp = [...document.querySelectorAll('.chat-row.steps')].filter((g) => g.querySelector(':scope > .chat-row-line .row-ic.rowic-mem')).at(-1); const g = grp.querySelector(':scope > .chat-row-line'); g.click(); await new Promise((r) => setTimeout(r, 100)); for (const l of grp.querySelectorAll('.chat-row.nested > .chat-row-line.expandable')) l.click(); await new Promise((r) => setTimeout(r, 150)); g.scrollIntoView({ block: 'start' });`, ready: '.step-foot' }, keys: ['.chat-row.nested .chat-row-obj', '.step-list-t', '.step-kv > span', '.step-foot'] },
  { name: 'chat-tools-web', hash: `#/chat/${chat.id}`, ready: '.chat-row.steps', tools: true, then: { js: `const grp = [...document.querySelectorAll('.chat-row.steps')].filter((g) => g.querySelector(':scope > .chat-row-line .row-ic.rowic-globe, :scope > .chat-row-line .row-ic.rowic-link')).at(-1); const g = grp.querySelector(':scope > .chat-row-line'); g.click(); await new Promise((r) => setTimeout(r, 100)); for (const l of grp.querySelectorAll('.chat-row.nested > .chat-row-line.expandable')) l.click(); await new Promise((r) => setTimeout(r, 150)); grp.querySelector('.web-results + .chat-row-open')?.click(); await new Promise((r) => setTimeout(r, 100)); g.scrollIntoView({ block: 'start' });`, ready: '.web-excerpt' }, keys: ['.chat-row.nested .chat-row-obj', '.web-hit-t', '.web-open', '.chat-row.nested.tone-bad .chat-row-rest'] },
  { name: 'chat-tools-pins', hash: `#/chat/${chat.id}`, tools: true, ready: '.artifact .art-upd', then: { js: `document.querySelector('.artifact .art-upd').closest('.artifact').scrollIntoView({ block: 'center' });`, ready: '.artifact' }, keys: ['.artifact .art-title', '.artifact .art-meta', '.chat-row.step .chat-row-verb'] },
  { name: 'chat-system', hash: `#/chat/${chat.id}`, ready: '.sys-row', system: true, then: { js: `for (const s of ['.sys-rewind', '.sys-msg']) document.querySelector(s + ' > .chat-row-line').click(); await new Promise((r) => setTimeout(r, 150)); document.querySelector('.sys-play').scrollIntoView({ block: 'start' });`, ready: '.rw-groups' }, keys: ['.sys-row .chat-row-verb', '.sys-row .chat-row-obj', '.sys-foot .chat-row-open', '.rw-groups .rw-what'] },
  // #138: « Rewind to here » on the user's message: the dialog lists files and side effects, undone and kept.
  { name: 'chat-rewind', hash: `#/chat/${chat.id}`, ready: '.sys-row', system: true, then: { js: `document.querySelectorAll('.msg-action[aria-label="Rewind to here"]')[0].click();`, ready: '.rewind-confirm .rw-groups' }, keys: ['.rewind-confirm h2', '.rewind-confirm .rw-head', '.rewind-confirm .rw-what', '.rewind-confirm .rw-act'] },
  { name: 'chat-rewind-row', hash: `#/chat/${chat.id}`, ready: '.sys-rewind', system: true, then: { js: `document.querySelector('.sys-rewind > .chat-row-line').click(); await new Promise((r) => setTimeout(r, 150)); document.querySelector('.sys-rewind').scrollIntoView({ block: 'start' });`, ready: '.sys-rewind .rw-groups' }, keys: ['.sys-rewind .chat-row-verb', '.sys-rewind .rw-head', '.sys-rewind .rw-what', '.sys-rewind .sys-foot .chat-row-open'] },
  { name: 'chat-system-end', hash: `#/chat/${chat.id}`, ready: '.sys-alert .sys-foot', system: true, keys: ['.sys-alert .chat-row-verb', '.sys-foot .chat-row-open'] },
  { name: 'chat-refs', hash: `#/chat/${chat.id}`, ready: '.msg .md p .prose-ref', table: true, then: { js: `const p = [...document.querySelectorAll('.msg .md p')].find((e) => e.textContent.includes('finished the storage part')); if (!p) throw new Error('no #140 paragraph'); p.scrollIntoView({ block: 'center' }); const refs = [...p.querySelectorAll('.prose-ref')]; const bad = []; if (refs.length !== 2) bad.push(refs.length + ' prose refs, want 2'); const lum = (c) => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map((v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }; const bg = (e) => { for (; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; const a = c.match(/[\\d.]+/g); if (a && (a.length < 4 || +a[3] > 0.5)) return c; } return 'rgb(255,255,255)'; }; const ps = getComputedStyle(p); for (const r of refs) { const s = getComputedStyle(r); if (s.fontSize !== ps.fontSize || s.lineHeight !== ps.lineHeight) bad.push(r.textContent + ': ' + s.fontSize + '/' + s.lineHeight + ' vs text ' + ps.fontSize + '/' + ps.lineHeight); const a = lum(s.color), b = lum(bg(r)); const cr = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); if (cr < 4.5) bad.push(r.textContent + ' contrast ' + cr.toFixed(2)); if (!(r.getAttribute('aria-label') || '').includes(r.textContent)) bad.push(r.textContent + ': no title in the accessible name'); if (!r.title) bad.push(r.textContent + ': no hover title'); } const tw = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); const qs = []; for (let n = tw.nextNode(); n; n = tw.nextNode()) { const rg = document.createRange(); rg.selectNodeContents(n); qs.push(...rg.getClientRects()); } const tops = [...new Set(qs.filter((q) => q.height > 0).map((q) => Math.round(q.top)))].sort((x, y) => x - y); const gaps = tops.slice(1).map((t, i) => t - tops[i]); if (gaps.length && Math.max(...gaps) - Math.min(...gaps) > 1) bad.push('uneven line spacing: ' + gaps.join(',')); const h = p.getBoundingClientRect().height, lines = Math.round(h / parseFloat(ps.lineHeight)); if (Math.abs(h - lines * parseFloat(ps.lineHeight)) > 1) bad.push('paragraph ' + h + 'px is not a whole number of ' + ps.lineHeight + ' lines'); if (bad.length) throw new Error('prose refs (#140): ' + bad.join('; ')); p.dataset.refsOk = '1';`, ready: '.msg .md p[data-refs-ok]' }, keys: ['.msg .md p .prose-ref'] },
  { name: 'chat-table', hash: `#/chat/${chat.id}`, ready: '.msg .md table .prose-ref', table: true, then: { js: `[...document.querySelectorAll('.msg .md table')].at(-1).scrollIntoView({ block: 'center' });`, ready: '.msg .md table' }, keys: ['.msg .md td', '.msg .md th', '.msg .md td .prose-ref'] },
  // #103: paste one image and drop another into the composer (2 thumbnails, send enabled), then the transcript's
  // thumbnails (a pasted screenshot, a read_file picture inside its step) and the full-size view.
  { name: 'chat-images', hash: `#/chat/${chat.id}`, ready: '.msg-image img', images: true, then: { js: `const png = await (await fetch(document.querySelector('.msg-image img').src)).blob(); const file = (n) => new File([png], n, { type: 'image/png' }); const ta = document.querySelector('.composer textarea'); const dt1 = new DataTransfer(); dt1.items.add(file('pasted.png')); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt1, bubbles: true, cancelable: true })); const dt2 = new DataTransfer(); dt2.items.add(file('dropped.png')); const form = ta.closest('form'); form.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt2, bubbles: true, cancelable: true })); form.dispatchEvent(new DragEvent('drop', { dataTransfer: dt2, bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 400)); const thumbs = document.querySelectorAll('.composer .attach-thumb'); const bad = []; if (thumbs.length !== 2) bad.push(thumbs.length + ' thumbnails after a paste and a drop, want 2'); if (document.querySelector('.composer .attach-thumb.bad, .composer .attach-thumb.busy')) bad.push('an attachment failed or is still uploading: ' + (document.querySelector('.attach-note')?.textContent ?? '')); if (document.querySelector('.composer .send-btn').disabled) bad.push('send disabled with 2 images and no text'); if (!document.querySelector('.composer .attach-btn')) bad.push('no attach button'); const step = [...document.querySelectorAll('.chat-row.step')].find((r) => r.textContent.includes('board-390')); if (!step) bad.push('no read_file step for the picture'); else { step.querySelector('.chat-row-line').click(); await new Promise((r) => setTimeout(r, 150)); if (!step.querySelector('.msg-image img')) bad.push('the read_file step shows no picture when opened'); } if (bad.length) throw new Error('images (#103): ' + bad.join('; ')); document.querySelector('.msg-image').click(); await new Promise((r) => setTimeout(r, 150));`, ready: '.lightbox img' }, keys: ['.lightbox-bar span', '.lightbox-bar a'] },
  { name: 'chat-tools-live', hash: `#/chat/${chat.id}`, ready: '.chat-row.steps.running', tools: true, keys: ['.chat-row.steps.running > .chat-row-line .chat-row-verb', '.chat-row.plan .chat-row-obj', '.chat-row.plan .todo-list li'] },
  { name: 'modal', hash: `#/chat/${chat.id}?card=${modalCard.id}`, ready: '.card-modal', pins: true, keys: ['.cm-title', '.cm-pill', '.cm-h', '.cm-foot button'] },
  // A task of this chat opened beside it (#107): the whole task, its description clamped, the conversation and composer in view.
  { name: 'thread', hash: `#/chat/${chat.id}`, ready: '.chat-pin', pins: true, then: { js: `const pin = [...document.querySelectorAll('.chat-pin')].find((p) => p.textContent.includes('Responsive pass')); if (!pin) throw new Error('no fixture pin'); pin.querySelector('.chat-pin-open').click();`, ready: '.thread-panel .cm-more' }, keys: ['.thread-panel .cm-title', '.thread-panel .cm-pill', '.thread-panel .cm-more', '.thread-panel .cm-h', '.thread-panel .cm-foot button'] },
  // A task's own images (#119): the New task dialog (paste + drop before Create), the modal (2 saved, paste + drop add
  // 2 more), and the thread panel beside the chat.
  { name: 'new-task-images', hash: '#/board', ready: '.board', taskImages: true, then: { js: `document.querySelector('button[aria-label="New task"]').click(); for (let i = 0; i < 30 && !document.querySelector('.nc-desc'); i++) await new Promise((r) => setTimeout(r, 100)); if (!document.querySelector('.nc-desc')) throw new Error('the New task dialog did not open'); const png = await (await fetch('/api/cards/x/image?path=%2FUsers%2Fx%2Ff.png')).blob(); const file = (n) => new File([png], n, { type: 'image/png' }); const paste = (el, dt) => { const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev.defaultPrevented; }; const dtText = new DataTransfer(); dtText.setData('text/plain', 'plain text'); const textTaken = paste(document.querySelector('.nc-desc'), dtText); const dt1 = new DataTransfer(); dt1.items.add(file('pasted.png')); paste(document.querySelector('.nc-desc'), dt1); const dt2 = new DataTransfer(); dt2.items.add(file('dropped.png')); document.querySelector('.new-card-modal').dispatchEvent(new DragEvent('dragover', { dataTransfer: dt2, bubbles: true, cancelable: true })); document.querySelector('.new-card-modal').dispatchEvent(new DragEvent('drop', { dataTransfer: dt2, bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 600)); const bad = []; if (textTaken) bad.push('pasting plain text was taken as an image paste'); const thumbs = document.querySelectorAll('.nc-images .attach-thumb'); if (thumbs.length !== 2) bad.push(thumbs.length + ' thumbnails after a paste and a drop, want 2'); if (document.querySelector('.nc-images .attach-thumb.bad, .nc-images .attach-thumb.busy')) bad.push('an image failed or is still uploading: ' + (document.querySelector('.nc-images .attach-note')?.textContent ?? '')); if (!document.querySelector('.nc-images .attach-btn')) bad.push('no attach button'); if (bad.length) throw new Error('task images (#119): ' + bad.join('; '));`, ready: '.nc-images .attach-thumb' }, keys: ['.nc-crumb', '.nc-foot button', '.attach-btn'] },
  { name: 'modal-images', hash: `#/chat/${chat.id}?card=${modalCard.id}`, ready: '.card-modal .task-images .attach-thumb.saved', taskImages: true, then: { js: `const png = await (await fetch(document.querySelector('.task-images img, .msg-image img')?.src ?? '/api/cards/x/image?path=%2FUsers%2Fx%2Ff.png')).blob(); const file = (n) => new File([png], n, { type: 'image/png' }); const paste = (el, dt) => { const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev.defaultPrevented; }; const dtText = new DataTransfer(); dtText.setData('text/plain', 'plain text'); const textTaken = paste(document.querySelector('.card-modal .cm-desc'), dtText); const dt1 = new DataTransfer(); dt1.items.add(file('pasted.png')); paste(document.querySelector('.card-modal .cm-desc'), dt1); const dt2 = new DataTransfer(); dt2.items.add(file('dropped.png')); document.querySelector('.card-modal .cm-desc-area').dispatchEvent(new DragEvent('dragover', { dataTransfer: dt2, bubbles: true, cancelable: true })); document.querySelector('.card-modal .cm-desc-area').dispatchEvent(new DragEvent('drop', { dataTransfer: dt2, bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 600)); const bad = []; if (textTaken) bad.push('pasting plain text was taken as an image paste'); const saved = document.querySelectorAll('.card-modal .task-images .attach-thumb.saved'); if (saved.length !== 4) bad.push(saved.length + ' saved images after a paste and a drop on 2, want 4'); if (document.querySelector('.card-modal .task-images .attach-thumb:not(.saved)')) bad.push('an image is still uploading or failed: ' + (document.querySelector('.card-modal .attach-note')?.textContent ?? '')); if (bad.length) throw new Error('task images (#119): ' + bad.join('; ')); { const ti = document.querySelector('.card-modal .task-images'), body = ti.closest('.cm-body'); body.scrollTop += ti.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 3; }`, ready: '.card-modal .task-images .attach-thumb.saved' }, keys: ['.cm-title', '.cm-h', '.cm-foot button'] },
  { name: 'thread-images', hash: `#/chat/${chat.id}`, ready: '.chat-pin', pins: true, taskImages: true, then: { js: `const pin = [...document.querySelectorAll('.chat-pin')].find((p) => p.textContent.includes('Responsive pass')); if (!pin) throw new Error('no fixture pin'); pin.querySelector('.chat-pin-open').click(); await new Promise((r) => setTimeout(r, 400)); const n = document.querySelectorAll('.thread-panel .task-images .attach-thumb.saved').length; if (n !== 2) throw new Error('task images (#119): ' + n + ' images in the thread panel, want 2'); { const ti = document.querySelector('.thread-panel .task-images'), body = ti.closest('.cm-body'); body.scrollTop += ti.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 3; }`, ready: '.thread-panel .task-images .attach-thumb.saved img' }, keys: ['.thread-panel .cm-title', '.thread-panel .cm-h', '.thread-panel .cm-foot button'] },
  { name: 'modal-blocked', hash: `#/chat/${chat.id}?card=${modalCard.id}`, ready: '.card-modal', blocked: true, keys: ['.cm-title', '.ask-kind', '.cm-foot button'] },
  { name: 'panel', hash: `#/chat/${chat.id}`, ready: '.side-doc', pins: true, panel: true, keys: ['.sd-tab', '.sd-ver-btn', '.side-doc h1', '.side-doc h2', '.chat-pin-title'] },
  // #211: the panel dragged to its widest (Home on the separator), so the chat is at its narrowest: pins and buttons
  // still must not cover messages or the composer. Phones have no separator: the panel stays full screen.
  { name: 'panel-max', hash: `#/chat/${chat.id}`, ready: '.side-doc', pins: true, panel: true, then: { js: `const h = document.querySelector('.sd-resize'); if (innerWidth <= 760) { if (h) throw new Error('a resize handle on a phone'); document.body.dataset.wideOk = '1'; return; } if (!h) throw new Error('no resize handle'); h.focus(); h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); await new Promise((r) => setTimeout(r, 200)); const max = +h.getAttribute('aria-valuemax'), w = Math.round(document.querySelector('.side-doc').getBoundingClientRect().width); if (Math.abs(w - max) > 1) throw new Error('panel ' + w + 'px after Home, max ' + max); h.blur(); localStorage.removeItem('atlas.panel.width'); document.body.dataset.wideOk = '1';`, ready: 'body[data-wide-ok]' }, keys: ['.sd-tab', '.chat-pin-title'] },
  // The phone drawer (hamburger): sidebar rows 40 / 44 px, faces, 13 px labels.
  { name: 'drawer', hash: `#/chat/${chat.id}`, ready: '.menu-btn', then: { js: `document.querySelector('.menu-btn').click(); await new Promise((r) => setTimeout(r, 400));`, ready: '.scrim' }, keys: ['.nav-item', '.side-group'] },
  { name: 'board', hash: '#/board', ready: '.board', keys: ['.board .name', '.card-title', '.nav-item'] },
  { name: 'inbox', hash: `#/inbox/${INBOX_CARDS[0].id}`, ready: '.ibx-q', inbox: true, keys: ['.ibx-det h2', '.ibx-opt b', '.ibx-k', '.ni-l2', '.nav-item'] },
  // A task note's link from the chat (#143): #/inbox/task:<id> lands on the task's question, or on a finished task's update.
  { name: 'inbox-task-need', hash: `#/inbox/task:${INBOX_CARDS[0].id}`, ready: '.ibx-q', inbox: true, then: { js: `await new Promise((r) => setTimeout(r, 200)); if (!location.hash.endsWith('/${INBOX_CARDS[0].id}')) throw new Error('task link did not land on the question: ' + location.hash); document.body.dataset.landed = '1';`, ready: 'body[data-landed]' }, keys: ['.ibx-det h2'] },
  { name: 'inbox-task-done', hash: `#/inbox/task:${INBOX_CARDS[3].id}`, ready: '.ni.on', inbox: true, then: { js: `await new Promise((r) => setTimeout(r, 200)); if (!location.hash.endsWith('/n9004')) throw new Error('task link did not land on the finished update: ' + location.hash); document.body.dataset.landed = '1';`, ready: 'body[data-landed]' }, keys: ['.ibx-det h2'] },
  { name: 'inbox-list', hash: '#/inbox', ready: '.ni', inbox: true, keys: ['.ni-l2', '.ni-l3', '.ibx-group', '.tabbtn'] },
  { name: 'inbox-review', hash: `#/inbox/${INBOX_CARDS[1].id}`, ready: '.ibx-q.review', inbox: true, keys: ['.ibx-det h2', '.ibx-k', '.ibx-actions button'] },
  { name: 'library', hash: '#/library', ready: '.lib-row', then: { js: `await new Promise((r) => setTimeout(r, 1200));`, ready: '.lib-tile' }, keys: ['.lg', '.lib-t', '.tabbtn', '.lib-tile-t b', '.lib-tile-m'] },
  // Search across folders: a content match shows its snippet; then the empty state.
  { name: 'library-search', hash: '#/library', ready: '.lib-row', then: { js: `const i = [...document.querySelectorAll('.mem-search input')].find((x) => x.offsetParent); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'the'); i.dispatchEvent(new Event('input', { bubbles: true }));`, ready: '.list-group[aria-label=Results] .lib-row' }, keys: ['.lib-t', '.lib-snip', '.lib-fold'] },
  { name: 'library-search-empty', hash: '#/library', ready: '.lib-row', then: { js: `const i = [...document.querySelectorAll('.mem-search input')].find((x) => x.offsetParent); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'zzqxnothing'); i.dispatchEvent(new Event('input', { bubbles: true }));`, ready: '.lib-empty' }, keys: ['.lib-empty p', '.lib-empty .head-btn'] },
  { name: 'settings-memory', hash: '#/settings/memory', ready: '.mem-row', memory: true, keys: ['.mem-chip', '.mem-t', '.mem-k', '.mem-intro h2', '.settings-group-title'] },
  { name: 'settings-memory-edit', hash: '#/settings/memory/agent:atlas', ready: '.mem-row', memory: true, then: { js: `document.querySelector('.mem-t').click();`, ready: '.mem-edit textarea' }, keys: ['.mem-edit-bar button', '.mem-note', '.mem-chip'] },
  // An old Library link (posted digests) lands on Settings → Memory, on that memory.
  { name: 'settings-memory-old-link', hash: '#/library/memory/m9302', ready: '.mem-row.focus', memory: true, keys: ['.mem-note', '.mem-t', '.mem-intro h2'] },
  { name: 'inbox-cleanup', hash: '#/inbox/n9007', ready: '.mem-digest', inbox: true, keys: ['.ibx-det h2', '.md-act', '.md-text', '.mem-digest .head-btn'] },
  { name: 'inbox-digest', hash: '#/inbox/n-1', ready: '.mem-digest', inbox: true, memory: true, keys: ['.ibx-det h2', '.md-act', '.md-text a', '.mem-digest .head-btn'] },
  ...(doc ? [{ name: 'library-doc', hash: `#/library/${doc.id}`, ready: '.viewer .doc-md', keys: ['.sd-ver-btn', '.sd-title b', '.viewer h2'] }] : []),
  // The version picker open over the viewer.
  ...(doc ? [{ name: 'library-doc-versions', hash: `#/library/${doc.id}`, ready: '.viewer .doc-md', then: { js: `document.querySelector('.sd-ver-btn').click();`, ready: '.fixed-pop .pop-row' }, keys: ['.fixed-pop .pop-row', '.pop-note'] }] : []),
  // ⌘K palette over the chat (query « lib », as in the mockup) and the « ? » cheat sheet over the board.
  { name: 'palette', hash: `#/chat/${chat.id}`, ready: '.chat-pin', pins: true, then: { js: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); await new Promise((r) => setTimeout(r, 300)); const i = document.querySelector('.pal-in input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'lib'); i.dispatchEvent(new Event('input', { bubbles: true }));`, ready: '.pal-op.on' }, keys: ['.pal-t', '.pal-sec', '.pal-ctx'] },
  { name: 'shortcuts', hash: '#/board', ready: '.board', then: { js: `window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));`, ready: '.keys-sheet' }, keys: ['.keys-head h2', '.keys-row > span:first-child', '.pal-sec'] },
  // Workflows (#171): the list (fixtures on top of the real ones), the canvas in Edit with a step selected, the canvas in
  // Runs with the waiting run; on a phone the canvas screens show the steps as a list.
  { name: 'workflows', hash: '#/workflows', ready: '.wf-row', workflows: true, keys: ['.wf-row .model-name', '.wf-chain', '.st-chip', '.wf-row .head-btn'] },
  { name: 'workflow-edit', hash: '#/workflows/wf_uicheck', ready: '.wf-node, .wf-phone', workflows: true, then: { js: `document.querySelector('.wf-plane .wf-node[data-id="validate"]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true })); document.querySelector('.wf-plane .wf-node[data-id="validate"]')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, isPrimary: true })); await new Promise((r) => setTimeout(r, 200)); document.body.dataset.wfSel = '1';`, ready: 'body[data-wf-sel]' }, keys: ['.wf-title', '.wf-kind', '.wf-out', '.wf-side .sd-head b', '.wf-side .field > span'] },
  { name: 'workflow-runs', hash: '#/workflows/wf_uicheck/runs/wr_uicheck2', ready: '.wf-run, .wf-phone', workflows: true, keys: ['.wf-title', '.wf-run .st-chip', '.wf-steps-log .t', '.wf-runs button'] },
  { name: 'workflow-off', hash: '#/workflows/wf_uicheckoff', ready: '.wf-off', workflows: true, keys: ['.wf-off', '.wf-title'] },
  { name: 'settings-secrets', hash: '#/settings/secrets', ready: '.sec-row', secrets: SECRET_STATUS, keys: ['.settings-group-title', '.sec-grant.all', '.sec-desc', '.sec-row .badge', '.sec-row .model-actions button', '.section-head h2'] },
  { name: 'settings-secrets-add', hash: '#/settings/secrets', ready: '.sec-row', secrets: SECRET_STATUS, then: { js: `[...document.querySelectorAll('.model-row.add')].find((b) => b.textContent.includes('Add a secret')).click(); await new Promise((r) => setTimeout(r, 100)); document.querySelector('.segmented [role=radio]:nth-child(2)').click(); await new Promise((r) => setTimeout(r, 100)); document.querySelector('.sec-form').scrollIntoView({ block: 'start' });`, ready: '.sec-pick label' }, keys: ['.sec-form .field', '.segmented button', '.sec-pick label', '.sec-form .actions button'] },
  { name: 'settings-secrets-locked', hash: '#/settings/secrets', ready: '.sec-lock', secrets: SECRET_LOCKED, keys: ['.sec-lock h3', '.sec-lock .sec-paused', '.update-badge-label', '.update-badge-v'] },
  ...SETTINGS.map((p) => ({ name: 'settings-' + p, hash: '#/settings/' + p, ready: '.settings', keys: ['.settings-group-title', '.settings-nav button', 'h2'] })),
].filter((s) => !ONLY?.length || ONLY.some((o) => s.name.startsWith(o)));
if (!doc) console.warn('No document in the workspace: the panel screen is skipped.');

// ── Chrome ──
const CDP_PORT = 9340 + Math.floor(Math.random() * 50);
const profile = mkdtempSync(join(tmpdir(), 'atlas-ui-check-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  chrome.kill();
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};
process.on('exit', cleanup);
let targets = [];
for (let i = 0; i < 50 && !targets.some((t) => t.type === 'page'); i++) {
  await sleep(200);
  targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json(), () => []);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let seq = 0;
const pending = new Map();
const handlers = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  } else if (d.method) handlers.get(d.method)?.(d.params);
};
const send = (method, params = {}) =>
  new Promise((r, j) => {
    const i = ++seq;
    pending.set(i, (d) => (d.error ? j(new Error(method + ': ' + d.error.message)) : r(d.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
};

// ── API interception: fixtures in, writes out ──
let screen = null;
const refusedWrites = [];
handlers.set('Fetch.requestPaused', async ({ requestId, request }) => {
  const url = new URL(request.url);
  const json = (body) =>
    send('Fetch.fulfillRequest', {
      requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(body)).toString('base64'),
    });
  try {
    if (request.method === 'GET' && url.pathname === '/api/cards' && screen?.blocked) return await json((await get('/cards')).map(blockedModal));
    if (request.method === 'GET' && url.pathname === '/api/cards' && (screen?.inbox || screen?.memory)) return await json([...(await get('/cards')), ...INBOX_CARDS]);
    // Memory fixtures (#82); other Inbox screens get no digest, so their list stays the mockup's.
    if (request.method === 'GET' && url.pathname === '/api/memories/changes' && (screen?.memory || screen?.inbox)) return await json(screen.memory ? MEMORY_CHANGES : []);
    if (request.method === 'GET' && url.pathname === '/api/memories' && screen?.memory) {
      const p = url.searchParams;
      return await json(MEMORIES.filter((m) => (!p.get('scope') || m.scope === p.get('scope')) && (!p.get('status') || m.status === p.get('status')) && (!p.get('q') || m.text.toLowerCase().includes(p.get('q').toLowerCase()))));
    }
    const memId = request.method === 'GET' && screen?.memory && /^\/api\/memories\/m?(\d+)$/.exec(url.pathname);
    if (memId) return await json(MEMORIES.find((m) => m.id === Number(memId[1])));
    if (request.method === 'GET' && /^\/api\/agents\/[^/]+\/memory-budget$/.test(url.pathname) && screen?.memory) return await json({ used: 1509, limit: 3000 });
    if (screen?.secrets && request.method === 'GET' && url.pathname === '/api/secrets') return await json(secretList(screen.secrets));
    if (screen?.secrets && request.method === 'GET' && url.pathname === '/api/secrets/status') return await json(screen.secrets);
    if (screen?.workflows && request.method === 'GET') {
      const W = [WORKFLOW, WORKFLOW_OFF];
      if (url.pathname === '/api/workflows') return await json([...W, ...(await get('/workflows'))]);
      const one = W.find((w) => url.pathname === `/api/workflows/${w.id}`);
      if (one) return await json(one);
      if (url.pathname === '/api/workflows/wf_uicheck/runs') return await json([WF_RUN, WF_RUN1].map(({ steps, ...r }) => r));
      if (url.pathname === '/api/workflows/wf_uicheckoff/runs') return await json([]);
      const run = [WF_RUN, WF_RUN1].find((r) => url.pathname === `/api/workflow-runs/${r.id}`);
      if (run) return await json(run);
    }
    if (request.method === 'GET' && url.pathname === '/api/inbox' && screen?.inbox) return await json(INBOX);
    if (request.method === 'GET' && url.pathname === '/api/memory-proposals' && screen?.inbox) return await json(PROPOSALS);
    if (request.method === 'GET' && url.pathname === '/api/cards' && screen?.system) return await json([...(await get('/cards')), ...TOOL_CARDS]);
    if (request.method === 'GET' && url.pathname === `/api/cards/${chat.id}/messages` && screen?.system) return await json([...(await get(`/cards/${chat.id}/messages`)), ...SYS_MSGS]);
    if (request.method === 'GET' && url.pathname === `/api/cards/${chat.id}/timeline` && screen?.system) return await json(SYS_TIMELINE);
    if (request.method === 'GET' && url.pathname === `/api/cards/${chat.id}/runs` && screen?.system) return await json([SYS_LATEST]);
    if (request.method === 'GET' && url.pathname === `/api/cards/${chat.id}/rewind` && screen?.system)
      return await json({ seq: Number(url.searchParams.get('seq')), hidden: 7, files: SYS_TIMELINE.rewinds[0].files.slice(0, 3), filesError: null, effects: SYS_EFFECTS });
    // Fixture pictures (paths under /Users/x/) on any screen: messages' and tasks' thumbnails.
    if (request.method === 'GET' && /^\/api\/cards\/[^/]+\/image$/.test(url.pathname) && (url.searchParams.get('path') ?? '').startsWith('/Users/x/'))
      return await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: IMG_PNG.toString('base64') });
    if (screen?.taskImages) {
      if (request.method === 'GET' && url.pathname === '/api/cards') return await json([...(await get('/cards')), ...(screen.pins ? FIXTURE_CARDS : [])].map(withTaskImages));
      if (request.method === 'POST' && (url.pathname === '/api/uploads' || /^\/api\/cards\/[^/]+\/uploads$/.test(url.pathname)))
        return await send('Fetch.fulfillRequest', { requestId, responseCode: 201, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(uploadAnswer(url.searchParams.get('name')))).toString('base64') });
      if (request.method === 'DELETE' && /^\/api\/uploads\/[^/]+$/.test(url.pathname)) return await send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [] });
      if (request.method === 'POST' && url.pathname === `/api/cards/${modalCard.id}/images`) {
        taskAdded = [...taskAdded, TIMG(`2026-11-18-added-${taskAdded.length + 1}.png`)];
        return await json(withTaskImages({ ...modalCard, updatedAt: new Date(Date.now() + 60_000).toISOString() }));
      }
    }
    if (request.method === 'GET' && url.pathname === `/api/cards/${chat.id}/messages` && screen?.images) return await json([...(await get(`/cards/${chat.id}/messages`)), ...IMAGE_MSGS]);
    if (request.method === 'GET' && url.pathname === `/api/cards/${chat.id}/image` && screen?.images)
      return await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: IMG_PNG.toString('base64') });
    if (request.method === 'POST' && url.pathname === `/api/cards/${chat.id}/uploads` && screen?.images)
      return await send('Fetch.fulfillRequest', {
        requestId, responseCode: 201, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(uploadAnswer(url.searchParams.get('name')))).toString('base64'),
      });
    if (request.method === 'GET' && url.pathname === '/api/cards' && screen?.table) return await json([...(await get('/cards')), ...TOOL_CARDS]);
    if (request.method === 'GET' && url.pathname === `/api/cards/${chat.id}/messages` && screen?.table) return await json([...(await get(`/cards/${chat.id}/messages`)), ...TABLE_MSGS]);
    if (request.method === 'GET' && url.pathname === '/api/cards' && screen?.tools) return await json([...(await get('/cards')), ...TOOL_CARDS]);
    if (request.method === 'GET' && url.pathname === '/api/cards' && screen?.pins) return await json([...(await get('/cards')), ...FIXTURE_CARDS]);
    if (request.method === 'GET' && url.pathname === '/api/cards' && screen?.reports) return await json([...(await get('/cards')), ...REPORT_CARDS]);
    if (request.method === 'GET' && url.pathname === `/api/cards/${chat.id}/messages` && screen?.reports) return await json([...(await get(`/cards/${chat.id}/messages`)), ...REPORTS]);
    if (request.method === 'GET' && url.pathname === `/api/cards/${chat.id}/messages` && screen?.tools) return await json([...(await get(`/cards/${chat.id}/messages`)), ...TOOL_MSGS]);
    if (request.method === 'GET' && url.pathname === `/api/cards/${chat.id}/tool-calls` && screen?.tools) return await json(TOOL_TIMINGS);
    if (request.method === 'GET' && url.pathname === `/api/cards/${chat.id}/runs` && screen?.tools) return await json([liveRun]);
    // An engine older than the UI under test (--ui before a reinstall) has no tool timings: the rows show none.
    if (request.method === 'GET' && /^\/api\/cards\/[^/]+\/timeline$/.test(url.pathname)) {
      const r = await fetch(BASE + url.pathname + url.search);
      return await json(r.ok ? await r.json() : { runs: [], rewinds: [], summary: null });
    }
    if (request.method === 'GET' && /^\/api\/cards\/[^/]+\/tool-calls$/.test(url.pathname)) {
      const r = await fetch(BASE + url.pathname + url.search);
      return await json(r.ok ? await r.json() : []);
    }
    if (url.pathname === `/api/chats/${chat.id}/panel` && request.method === 'GET') return await json(screen?.panel ? panelTabs() : []);
    if (screen?.panel && /^\/api\/chats\/[^/]+\/panel\/(seen|focus)$/.test(url.pathname)) return await json(panelTabs());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && url.pathname !== '/api/auth/check') {
      refusedWrites.push(`${screen?.name}: ${request.method} ${url.pathname}`);
      return await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
    await send('Fetch.continueRequest', { requestId });
  } catch (e) {
    console.error('interception:', e.message);
  }
});
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
// Uncaught page errors are issues of the screen they happen on.
const pageErrors = [];
handlers.set('Runtime.exceptionThrown', ({ exceptionDetails: d }) => pageErrors.push('page error: ' + (d.exception?.description ?? d.text).split('\n')[0]));
handlers.set('Runtime.consoleAPICalled', ({ type, args }) => type === 'error' && pageErrors.push('console error: ' + args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160)));
if (process.env.UI_CHECK_DEBUG) {
  handlers.set('Network.loadingFailed', (p) => console.error('net fail', p.errorText, p.requestId));
  handlers.set('Network.webSocketClosed', (p) => console.error('ws closed', p));
  handlers.set('Network.webSocketCreated', (p) => console.error('ws created', p.url));
  handlers.set('Network.webSocketHandshakeResponseReceived', (p) => console.error('ws handshake', p.response.status));
  handlers.set('Runtime.consoleAPICalled', ({ type, args }) => console.error('console', type, args.map((a) => a.value ?? a.description).join(' ').slice(0, 300)));
  await send('Network.enable');
}
await send('Page.enable');
await send('Runtime.enable');

// ── In-page checks ──
const VISIBLE_RECT = `
  /** The part of e's box actually on screen: clipped by every ancestor that clips (scrollers, overflow hidden) and the viewport. */
  const visibleRect = (e, r = e.getBoundingClientRect()) => {
    let l = r.left, t = r.top, rr = r.right, b = r.bottom;
    for (let p = e.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = p.getBoundingClientRect();
      if (s.overflowX !== 'visible') { l = Math.max(l, c.left); rr = Math.min(rr, c.right); }
      if (s.overflowY !== 'visible') { t = Math.max(t, c.top); b = Math.min(b, c.bottom); }
    }
    l = Math.max(l, 0); t = Math.max(t, 0); rr = Math.min(rr, innerWidth); b = Math.min(b, innerHeight);
    return { left: l, top: t, right: rr, bottom: b, width: Math.max(0, rr - l), height: Math.max(0, b - t) };
  };`;
const CHECK = (devW, devH) => `((minFont, W, H) => {${VISIBLE_RECT}
  const issues = [];
  // On a phone, a layout wider than the screen makes the browser zoom out: everything gets smaller.
  if (innerWidth > W + 1) issues.push('layout is ' + innerWidth + 'px wide on a ' + W + 'px screen (the page zooms out)');
  const shown = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && +s.opacity > 0.05; };
  const meet = (a, b) => !(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1);
  const short = (e) => (e.value || e.textContent || e.getAttribute('aria-label') || e.className || e.tagName).toString().trim().replace(/\\s+/g, ' ').slice(0, 40);
  const scrolls = (e) => { for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') return true; } return false; };
  // 1. Horizontal overflow of the page.
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (sw > W + 1) issues.push('page scrolls horizontally: ' + sw + 'px > ' + W + 'px');
  // 2. Text: smaller than the minimum, or off-screen without a scroll container.
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('svg, canvas, [aria-hidden=true]')) continue;
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || ((e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && (e.value || e.placeholder));
    if (!own || !shown(e)) continue;
    const fs = parseFloat(getComputedStyle(e).fontSize);
    if (fs < minFont) issues.push('text ' + fs + 'px < ' + minFont + 'px: ' + e.tagName.toLowerCase() + '.' + [...e.classList].join('.') + ' "' + short(e) + '"');
    const r = e.getBoundingClientRect();
    if ((r.right > W + 1 || r.left < -1) && !scrolls(e)) issues.push('off-screen text: "' + short(e) + '"');
  }
  // 3. Pins (and the chat's floating buttons) never cover messages or the composer: compare what is really visible.
  const floats = [...document.querySelectorAll('.chat-pin, .chat-delete, .doc-reopen')].filter(shown);
  for (const p of floats) {
    const pr = visibleRect(p);
    if (pr.width < 1 || pr.height < 1) continue;
    for (const m of document.querySelectorAll('.chat .msg, .chat .sys-note, .chat .run-status, .waiting-line, .composer')) {
      if (!shown(m) || m.closest('.card-modal')) continue;
      const r = visibleRect(m);
      if (r.width < 1 || r.height < 1) continue;
      if (meet(pr, r)) issues.push(short(p.querySelector('.chat-pin-title') || p) + ' covers ' + (m.classList.contains('composer') ? 'the composer' : 'message "' + short(m) + '"'));
    }
  }
  // 4. Modal and panel inside the screen.
  const inside = (r) => r.left >= -1 && r.top >= -1 && r.right <= W + 1 && r.bottom <= H + 1;
  const md = document.querySelector('.card-modal');
  if (md) { const r = md.getBoundingClientRect(); if (!inside(r)) issues.push('modal off-screen: ' + [r.left, r.top, r.right, r.bottom].map(Math.round)); }
  const sd = document.querySelector('.side-doc');
  if (sd) {
    const r = sd.getBoundingClientRect();
    if (!inside(r)) issues.push('panel off-screen: ' + [r.left, r.top, r.right, r.bottom].map(Math.round));
    const cp = document.querySelector('.chat-view .chat-pane');
    if (sd.classList.contains('side') && cp && shown(cp) && meet(cp.getBoundingClientRect(), r)) issues.push('side panel overlaps the chat');
    if (r.width < Math.min(320, W)) issues.push('panel too narrow: ' + Math.round(r.width) + 'px');
    // A task beside its chat (#107): the composer and the footer stay in view, the brief doesn't push them out.
    if (sd.classList.contains('thread-panel')) {
      for (const sel of ['.composer textarea', '.cm-foot', '.cm-head']) {
        const el = sd.querySelector(sel), q = el && el.getBoundingClientRect();
        if (!q || q.height < 1 || !inside(q) || q.right > r.right + 1) issues.push('thread panel: ' + sel + ' not in view');
      }
      const body = sd.querySelector('.cm-body'), desc = sd.querySelector('div.cm-desc');
      if (body && desc && desc.getBoundingClientRect().height > body.clientHeight * 0.6) issues.push('thread panel: the description fills the panel');
      if (sd.scrollWidth > sd.clientWidth + 1) issues.push('thread panel scrolls sideways');
    }
  }
  // 5. Markdown table cells with prose stay readable: never narrower than ~10 characters, never broken inside a word.
  for (const td of document.querySelectorAll('.md td, .md th')) {
    // A Library tile's preview is the page scaled down on purpose (#120): not text to read.
    if (!shown(td) || td.closest('[aria-hidden=true]')) continue;
    const text = [...td.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (text.length < 20) continue;
    const fs = parseFloat(getComputedStyle(td).fontSize), w = td.getBoundingClientRect().width;
    if (w < fs * 6) issues.push('table column crushed to ' + Math.round(w) + 'px: "' + text.slice(0, 30) + '"');
  }
  const pl = document.querySelector('.pal');
  if (pl) { const r = pl.getBoundingClientRect(); if (!inside(r)) issues.push('palette off-screen: ' + [r.left, r.top, r.right, r.bottom].map(Math.round)); }
  return [...new Set(issues)];
})(${MIN_FONT}, ${devW}, ${devH})`;

/** Visible key labels of the screen with their on-screen box (css px), for OCR. Text hidden under something else is skipped. */
const KEYS = (selectors) => `((sels) => {${VISIBLE_RECT}
  const out = [], W = innerWidth, H = innerHeight;
  for (const sel of sels) {
    let n = 0;
    for (const e of document.querySelectorAll(sel)) {
      if (n >= 4) break;
      const input = e.tagName === 'INPUT' || e.tagName === 'TEXTAREA';
      const text = (input ? e.value : e.innerText || '').split('\\n')[0].trim();
      if (!text) continue;
      let r, lines = 1, first;
      if (input) r = first = e.getBoundingClientRect();
      else { const rg = document.createRange(); rg.selectNodeContents(e); r = rg.getBoundingClientRect(); const qs = [...rg.getClientRects()]; lines = new Set(qs.map((q) => Math.round(q.top))).size; first = qs.find((q) => q.height > 0) || r; }
      const v = visibleRect(e, r);
      if (v.width < 24 || v.height < 6) continue;
      const s = getComputedStyle(e); if (s.visibility === 'hidden' || +s.opacity < 0.5) continue;
      // Skip text partly under something else (overlay panel, modal): OCR would read the other thing.
      const cy = v.top + v.height / 2, mine = (x) => { const t = document.elementFromPoint(x, cy); return t && (e.contains(t) || t.contains(e)); };
      if (![v.left + 3, v.left + v.width / 2, v.right - 3].every(mine)) continue;
      // Wrapped text cut by a scroller's edge (a board column peeking in): the crop holds the starts of several lines,
      // nothing to compare against.
      if (lines > 1 && v.width < r.width - 1) continue;
      // A line cut by a scroller's top or bottom edge (the next message peeking in): half a line can't be read.
      if (lines === 1 && v.height < r.height * 0.8) continue;
      // Same for the first line of a label whose inline parts sit at slightly different tops (counted as several
      // lines): OCR reads the first line, so it must be (almost) whole (#102: a report row cut at 54% by the scroller).
      if (Math.min(v.top + v.height, first.bottom) - Math.max(v.top, first.top) < first.height * 0.8) continue;
      // Clipped (ellipsis, scrolled row): only the visible start of the text can be read.
      out.push({ sel, text, shown: v.width / r.width, x: v.left, y: v.top, w: v.width, h: v.height }); n++;
    }
  }
  return out;
})(${JSON.stringify(selectors)})`;

// ── OCR ──
const OCR_SRC = join(HERE, 'ocr.swift');
const OCR_BIN = join(tmpdir(), 'atlas-ui-check-ocr');
if (!existsSync(OCR_BIN) || statSync(OCR_BIN).mtimeMs < statSync(OCR_SRC).mtimeMs) execFileSync('swiftc', ['-O', '-o', OCR_BIN, OCR_SRC], { stdio: 'inherit' });
// Vision sometimes answers with Cyrillic / Greek look-alikes (« Аpp »): fold them to Latin before comparing.
const LOOKALIKE = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', α: 'a', ο: 'o', ν: 'v', ρ: 'p', τ: 't', ι: 'i', κ: 'k' };
// In Inter a capital I and a lowercase l are the same glyph, so OCR reads either: compare them as one letter.
const norm = (s) => s.replace(/I/g, 'l').toLowerCase().normalize('NFKD').replace(/./g, (c) => LOOKALIKE[c] ?? c).replace(/[^a-z0-9]/g, '');
/** Smallest edit distance between `p` and any substring of `t` (approximate substring match). */
function fuzzy(p, t) {
  let prev = new Array(t.length + 1).fill(0);
  for (let i = 1; i <= p.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (p[i - 1] === t[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.min(...prev);
}

// ── Run ──
mkdirSync(OUT, { recursive: true });
const report = {};
const shots = [];
for (const w of WIDTHS) {
  const h = HEIGHT[w] ?? 800;
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 500 });
  await send('Emulation.setTouchEmulationEnabled', { enabled: w < 500, maxTouchPoints: 5 }); // phone: pointer: coarse
  for (let s of SCREENS) {
    screen = s;
    taskAdded = [];
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(100);
    pageErrors.length = 0;
    await send('Page.navigate', { url: PAGE_BASE + '/' + (THEME ? '?theme=' + THEME : '') + s.hash });
    const key = `${w} ${s.name}`;
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      await sleep(150);
      ready = await evaluate(`!!document.querySelector(${JSON.stringify(s.ready)})`).catch(() => false);
    }
    await sleep(700); // fonts, transitions, late fetches
    if (ready && s.then) {
      // A step after load (open the palette…): run it, then wait for what it shows.
      await evaluate(`(async () => { ${s.then.js} })()`).catch((e) => {
        throw new Error(`${key}: the step after load failed: ${e.message}`);
      });
      ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        await sleep(100);
        ready = await evaluate(`!!document.querySelector(${JSON.stringify(s.then.ready)})`).catch(() => false);
      }
      await sleep(300);
      if (!ready) s = { ...s, ready: s.then.ready };
    }
    const issues = ready ? await evaluate(CHECK(w, h)) : [`never showed ${s.ready}; page says: ` + (await evaluate('(async () => document.body.innerText.slice(0, 120) + " | " + self.origin + " " + location.href + " | " + (await fetch("/api/chats").then(r => r.status + " " + r.headers.get("content-type"), e => String(e))))()')).replace(/\s+/g, ' ')];
    if (SPEC && ready) issues.push(...(await evaluate(SPEC_AUDIT(w, FONT_SCALE, FONT_EXCEPTIONS, MIN_CONTRAST))));
    issues.push(...pageErrors.splice(0));
    const keys = ready ? await evaluate(KEYS(s.keys)) : [];
    if (process.env.UI_CHECK_EVAL) console.log(key, JSON.stringify(await evaluate(process.env.UI_CHECK_EVAL)));
    const file = join(OUT, `${w}-${s.name}.png`);
    writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    report[key] = { issues, keys };
    shots.push({ key, file });
    process.stdout.write('.');
  }
}
console.log();
screen = null;
ws.close();

// OCR every screenshot in one process, then match each key label with the text read in its box.
const ocr = new Map(
  execFileSync(OCR_BIN, shots.map((s) => s.file), { encoding: 'utf8', maxBuffer: 64 << 20 })
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .map((o) => [o.file, o]),
);
for (const { key, file } of shots) {
  const { lines, w } = ocr.get(file);
  const scale = w / Number(key.split(' ')[0]);
  for (const k of report[key].keys) {
    const box = { l: k.x * scale - 4, t: k.y * scale - 4, r: (k.x + k.w) * scale + 4, b: (k.y + k.h) * scale + 4 };
    const hit = lines.filter((o) => {
      const cy = o.y + o.h / 2;
      return cy >= box.t && cy <= box.b && o.x < box.r && o.x + o.w > box.l;
    });
    const read = hit.map((o) => o.text).join(' ');
    const want = norm(k.text).slice(0, Math.min(12, Math.floor(norm(k.text).length * Math.min(1, k.shown)) - 1));
    if (want.length < 2) continue; // icons, single glyphs
    const conf = hit.length ? Math.max(...hit.map((o) => o.conf)) : 0;
    const dist = fuzzy(want, norm(read));
    k.ocr = { read, conf: +conf.toFixed(2) };
    if (dist > Math.floor(want.length / 5) || conf < MIN_CONF)
      report[key].issues.push(`OCR can't read "${k.text.slice(0, 40)}" (${k.sel}): read "${read.slice(0, 40)}" conf ${conf.toFixed(2)}`);
  }
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify({ base: BASE, chat: chat.id, modalCard: modalCard.id, doc: doc?.id, report, refusedWrites }, null, 1));
let total = 0;
for (const [key, r] of Object.entries(report)) {
  total += r.issues.length;
  if (r.issues.length) console.log(`✗ ${key}\n  - ` + r.issues.join('\n  - '));
}
if (refusedWrites.length) console.log('Writes refused (read-only harness):\n  ' + [...new Set(refusedWrites)].join('\n  '));
const labels = Object.values(report).reduce((n, r) => n + r.keys.filter((k) => k.ocr).length, 0);
console.log(`${Object.keys(report).length} screens × checks, ${labels} labels OCR'd: ${total ? total + ' issue(s)' : 'no issues'}. Screenshots: ${OUT}`);
cleanup();
process.exit(total ? 1 : 0);
