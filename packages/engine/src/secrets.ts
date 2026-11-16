/**
 * Where model keys come from (CLAUDE.md rule 5). The desktop app passes a store backed by the OS keychain
 * (Electron safeStorage); a server reads keys from its environment only. Values never go to SQLite, logs or the UI.
 */
export interface SecretStore {
  /** Names of stored secrets (never values). */
  names(): string[];
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  /** Shown in Settings, e.g. 'macOS Keychain'. */
  readonly label: string;
}

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/**
 * Plan sign-in tokens (plan-accounts.ts): CLAUDE_TOKENS / CHATGPT_TOKENS for each provider's first subscription,
 * CLAUDE_TOKENS_<ID> / CHATGPT_TOKENS_<ID> for the others. Never in the engine env, the key list or the API.
 */
export const isTokenEntry = (name: string) => /^(CLAUDE|CHATGPT)_TOKENS(_[A-Z0-9]+)?$/.test(name);

/** Engine env = process env + stored secrets; setting a secret updates it live (models read it at each call). */
export function envWithSecrets(base: NodeJS.ProcessEnv, store?: SecretStore): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const n of store?.names() ?? []) if (!isTokenEntry(n)) env[n] = store!.get(n);
  return env;
}
