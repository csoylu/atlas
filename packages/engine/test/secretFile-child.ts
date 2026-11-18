// Child process of secretFile.test.ts: writes secrets.enc in a tight loop until it is SIGKILLed.
// Args: file, password. Prints the counter after each completed write.
import { SecretFile } from '../src/secretFile.ts';

const [file, password] = process.argv.slice(2) as [string, string];
const store = new SecretFile(file, { N: 2 ** 10, failDelayMs: 0 });
await store.unlock(password, 'env', true);
let n = Number(store.get('COUNTER') ?? '0');
for (;;) {
  n++;
  // A value big enough that a write takes a while: the kill lands mid-write often.
  store.set('COUNTER', String(n));
  store.set('PADDING', 'x'.repeat(200_000 + (n % 7)));
  process.stdout.write(`${n}\n`);
}
