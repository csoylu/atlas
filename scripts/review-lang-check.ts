/**
 * Hand-run check (#108): does the background memory review write in the user's language?
 * Replays the real review (MemoryReview.review, its prompt and apply) of one task or chat on a copy of the live
 * database, several times, with the model answered by the Claude Code CLI (`claude -p`, its own sign-in: Atlas's
 * tokens are never touched). Optionally seeds French memories the review can see, to check it doesn't imitate them.
 * Prints each memory the review added or updated and flags the ones that look French. Exit 1 if any does.
 * Usage: npx tsx scripts/review-lang-check.ts <cardId> [--runs 3] [--upto <seq>] [--french] [--seed "<memory text>"]... [--set <id> "<text>"]... [--model sonnet]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startEngine } from '../packages/engine/src/index.ts';
import type { Provider } from '../packages/engine/src/providers/types.ts';

const args = process.argv.slice(2);
const cardId = args[0];
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i > 0 ? args[i + 1] : undefined;
};
if (!cardId || cardId.startsWith('--')) throw new Error('usage: review-lang-check.ts <cardId> [--runs 3] [--upto <seq>] [--french] [--model sonnet]');
const runs = Number(opt('runs') ?? 3);
const upto = opt('upto');
const cliModel = opt('model') ?? 'sonnet';
const claude = process.env['CLAUDE_BIN'] ?? join(homedir(), '.local/bin/claude');
const dataDir = join(homedir(), 'Library/Application Support/Atlas/data');

/** French memories of the kind that leaked on 17 Nov 2026, in the reviewed agent's scope and shared. */
const FRENCH = [
  'Dans le workspace de cet agent, le clone git est directement atlas/ : y faire git pull --rebase avant le travail, puis commit et push depuis ce clone.',
  'Pour Master, « approbation requise » veut dire « bloqué » : l’approbation est une raison de blocage, pas un statut à part.',
  'Les tests Atlas (vitest, 2 projets) : `npm test` lance seulement le projet rapide (~10 s), `npm run test:full` lance tout.',
];

/** Rough but enough here: French function words and accents. */
export function looksFrench(text: string): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const fr = new Set(['le', 'la', 'les', 'des', 'du', 'une', 'est', 'dans', 'pour', 'avec', 'pas', 'sur', 'qui', 'que', 'sont', 'faire', 'puis', 'aux', 'au', 'ou', 'et']);
  const hits = words.filter((w) => fr.has(w)).length;
  return hits >= 3 || /[éèêàçù]\p{L}*\s/u.test(text) && hits >= 2;
}

/** The review model, answered by `claude -p` with the review's own system prompt and no tools. */
const cli: Provider = {
  async complete(req) {
    const prompt = req.messages.map((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')).join('\n\n');
    const r = spawnSync(claude, ['-p', '--model', cliModel, '--system-prompt', req.system, '--tools', '', '--no-session-persistence', '--output-format', 'text'], {
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000,
    });
    if (r.status !== 0) throw new Error(`claude -p failed (${r.status}): ${r.stderr || r.stdout}`);
    return { content: [{ type: 'text', text: r.stdout }], stopReason: 'end_turn', usage: { input: 0, output: 0 } };
  },
} as Provider;

let french = 0;
let written = 0;
for (let run = 1; run <= runs; run++) {
  const copy = join(mkdtempSync(join(tmpdir(), 'atlas-review-')), 'atlas.db');
  const src = new Database(join(dataDir, 'atlas.db'), { readonly: true });
  await src.backup(copy);
  src.close();
  const db = new Database(copy);
  const card = db.prepare('SELECT conversation_id, assignee FROM cards WHERE id = ?').get(cardId) as { conversation_id: string; assignee: string } | undefined;
  if (!card) throw new Error(`no card ${cardId}`);
  if (upto) db.prepare('DELETE FROM messages WHERE conversation_id = ? AND seq > ?').run(card.conversation_id, Number(upto));
  db.prepare('UPDATE conversations SET reviewed_upto_seq = 0 WHERE id = ?').run(card.conversation_id);
  db.prepare("UPDATE runs SET status = 'done' WHERE status = 'running'").run();
  db.close();

  const engine = await startEngine({ dbFile: copy, dataDir: tmpdir(), port: 0, dispatch: false, manageLocal: false, providers: () => cli });
  try {
    if (args.includes('--french')) {
      for (const [i, text] of FRENCH.entries()) engine.memories.add({ kind: i === 1 ? 'rule' : 'fact', scope: i === 1 ? 'shared' : `agent:${card.assignee}`, text }, 'review:test');
    }
    // --seed "<text>": one more memory of the agent (e.g. an outdated French fact the conversation corrects, to test updates).
    for (const [i, a] of args.entries()) if (a === '--seed' && args[i + 1]) engine.memories.add({ kind: 'fact', scope: `agent:${card.assignee}`, text: args[i + 1]! }, 'review:test');
    // --set <id> "<text>": rewrite an existing memory (e.g. in French, one the review tends to update) before the review.
    for (const [i, a] of args.entries()) if (a === '--set' && args[i + 2]) engine.memories.update(Number(args[i + 1]!.replace(/^m/, '')), { text: args[i + 2]! }, 'review:test');
    const set = new Set(args.flatMap((a, i) => (a === '--set' ? [Number(args[i + 1]!.replace(/^m/, ''))] : [])));
    const before = engine.memories.lastChange();
    const applied = await engine.review.review(cardId);
    console.log(`run ${run}: ${applied.length ? applied.join(', ') : 'no change'}`);
    for (const c of engine.memories.changes(new Date(0).toISOString()).filter((c) => c.id > before)) {
      const m = engine.memories.get(c.memoryId);
      if (c.action === 'forget') continue;
      written++;
      const fr = looksFrench(m.text);
      if (fr) french++;
      console.log(`  ${fr ? 'FRENCH ' : 'ok     '} ${c.action} m${m.id}${set.has(m.id) ? ' (was French)' : ''}: ${m.text}`);
    }
  } finally {
    await engine.stop();
  }
}
console.log(`${written} memories written, ${french} in French`);
process.exit(french ? 1 : 0);
