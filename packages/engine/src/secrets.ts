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
/** The ChatGPT sign-in's tokens (chatgpt.ts): Atlas's own entry, never in the engine env, the key list or the API. */
export const CHATGPT_TOKENS = 'CHATGPT_TOKENS';
/** The Claude plan sign-in's tokens (claude-plan.ts): same rules as CHATGPT_TOKENS. */
export const CLAUDE_TOKENS = 'CLAUDE_TOKENS';
/** Token entries: never in the engine env, the key list or the API. */
export const TOKEN_ENTRIES = new Set([CHATGPT_TOKENS, CLAUDE_TOKENS]);

/** Engine env = process env + stored secrets; setting a secret updates it live (models read it at each call). */
export function envWithSecrets(base: NodeJS.ProcessEnv, store?: SecretStore): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const n of store?.names() ?? []) if (!TOKEN_ENTRIES.has(n)) env[n] = store!.get(n);
  return env;
}
