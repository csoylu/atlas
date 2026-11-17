/**
 * Dump the exact HTTP request Atlas sends to Claude for a chat's turn, without calling Anthropic.
 * Replays the turn on a copy of the database: the transcript is cut right after the user's message `seq`, the engine
 * runs the chat through the real runner + AnthropicProvider (Claude plan settings), and the fetch is captured.
 * Usage: node scripts/dump-request.ts <cardId> <seq> <out.json>
 */
import { copyFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startEngine } from '../packages/engine/src/index.ts';
import { AnthropicProvider } from '../packages/engine/src/providers/anthropic.ts';
import { CLAUDE_CODE_CLIENT_ID, CLAUDE_SUBSCRIPTION_HEADERS } from '../packages/engine/src/claude-plan.ts';

const [cardId, seqRaw, out] = process.argv.slice(2);
if (!cardId || !seqRaw || !out) throw new Error('usage: dump-request.ts <cardId> <seq> <out.json>');
const dataDir = join(homedir(), 'Library/Application Support/Atlas/data');
const copy = join(mkdtempSync(join(tmpdir(), 'atlas-dump-')), 'atlas.db');
const src = new Database(join(dataDir, 'atlas.db'), { readonly: true });
await src.backup(copy);
src.close();

const db = new Database(copy);
const { conversation_id: conv } = db.prepare('SELECT conversation_id FROM cards WHERE id = ?').get(cardId) as { conversation_id: string };
db.prepare('DELETE FROM messages WHERE conversation_id = ? AND seq > ?').run(conv, Number(seqRaw));
db.prepare("UPDATE runs SET status = 'done' WHERE status = 'running'").run();
db.close();

let captured: unknown = null;
const capture: typeof fetch = async (url, init) => {
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  if (headers['authorization']) headers['authorization'] = 'Bearer <redacted>';
  captured = { method: init?.method, url: String(url), headers, body: JSON.parse(String(init?.body)) };
  throw new Error('captured');
};
const engine = await startEngine({
  dbFile: copy,
  dataDir,
  port: 0,
  dispatch: false,
  providers: () =>
    new AnthropicProvider(null, {
      authToken: 'redacted',
      baseURL: 'https://api.anthropic.com',
      headers: CLAUDE_SUBSCRIPTION_HEADERS,
      systemPrefix: CLAUDE_CODE_CLIENT_ID ? "You are Claude Code, Anthropic's official CLI for Claude." : undefined,
      maxRetries: 0,
      fetch: capture,
    }),
});
engine.runner.wake(cardId, { kind: 'chat' });
await engine.runner.settled(cardId);
await engine.stop();
if (!captured) throw new Error('no request was made');
writeFileSync(out, JSON.stringify(captured, null, 2));
console.log('written', out);
