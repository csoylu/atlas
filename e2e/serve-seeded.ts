// Starts a throwaway Atlas (scripted model) with a little data and prints its port; for `npm run ui:check:fast -- --port N`.
import { TestAtlas } from './harness/engine.ts';
import { tu, say } from './harness/audit.ts';
const a = await TestAtlas.start();
const ch = await a.chat();
a.model.next(tu('write_file', { path: 'docs/spec.md', content: '# Spec\n\n## One\ntext\n' }), say('Done, written.'));
await a.say(ch.id, 'write a spec');
await a.task('Seed task').catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
console.log('PORT', new URL(a.url).port);
setInterval(() => {}, 1 << 30);
