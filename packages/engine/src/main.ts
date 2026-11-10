import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startEngine } from './index.ts';

const root = resolve(import.meta.dirname, '../../..');
// Secrets come from env vars; .env at the repo root is loaded if present (gitignored).
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const dataDir = resolve(process.env.ATLAS_DATA_DIR ?? join(root, 'data'));
const port = Number(process.env.ATLAS_PORT ?? 4317);
const host = process.env.ATLAS_HOST ?? '127.0.0.1';
const uiDir = join(root, 'packages/ui/dist');
// Server mode: a login password (design §12). Unset: no login, localhost only.
const password = process.env.ATLAS_PASSWORD || null;

const engine = await startEngine({ dbFile: join(dataDir, 'atlas.db'), dataDir, port, host, uiDir, password });
console.log(`engine listening on ${engine.url} (data: ${dataDir}; ${password ? 'login required' : 'no login, localhost only'})`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await engine.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
