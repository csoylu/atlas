import { CreateModel, DEFAULT_CONTEXT_WINDOW, UpdateModel, type Model, type ModelTest } from '@atlas/shared';
import { ConflictError, NotFoundError } from './kanban.ts';
import type { Db } from './store/db.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { OpenAiCompatProvider } from './providers/openai.ts';
import { ModelError, type Provider } from './providers/types.ts';

interface ModelRow {
  id: string;
  provider: Model['provider'];
  name: string;
  base_url: string | null;
  credential_env: string | null;
  max_tokens: number;
  context_window: number;
  verified_at: string | null;
  last_error: string | null;
}

export type ProviderFactory = (model: Model, env: NodeJS.ProcessEnv) => Provider;

/** Real providers. Missing configuration is a ModelError, never a fallback (design §5). */
export const realProviders: ProviderFactory = (m, env) => {
  if (m.provider === 'claude_code') {
    const token = env['CLAUDE_CODE_OAUTH_TOKEN']?.trim();
    const key = env['ANTHROPIC_API_KEY']?.trim();
    if (!token && !key) throw new ModelError(`model ${m.id} needs CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the engine's environment`);
    // Keep the legacy adapter's hardcoded identity aligned with Can's installed Claude Code version.
    return new AnthropicProvider(token ? null : key!, {
      baseURL: m.baseUrl ?? undefined,
      authToken: token,
      maxRetries: 0,
      headers: { 'user-agent': 'claude-code/2.1.322', ...(token ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}) },
    });
  }
  if (m.provider === 'chatgpt') throw new ModelError(`model ${m.id} uses the ChatGPT plan, which this engine has no sign-in for`);
  if (m.provider === 'claude_plan') throw new ModelError(`model ${m.id} uses the Claude plan, which this engine has no sign-in for`);
  const key = m.credentialEnv ? env[m.credentialEnv] : undefined;
  if (m.provider === 'anthropic') {
    if (!key)
      throw new ModelError(`model ${m.id} needs ${m.credentialEnv ?? 'an API key'}: set it on the Models page (desktop) or in the engine's environment`);
    return new AnthropicProvider(key, m.baseUrl ?? undefined);
  }
  if (!m.baseUrl) throw new ModelError(`model ${m.id} has no base URL`);
  return new OpenAiCompatProvider(m.baseUrl, key);
};

export class Models {
  constructor(
    private db: Db,
    private factory: ProviderFactory = realProviders,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  private toModel(r: ModelRow): Model {
    return {
      id: r.id,
      provider: r.provider,
      name: r.name,
      baseUrl: r.base_url,
      credentialEnv: r.credential_env,
      credentialPresent:
        r.provider === 'claude_code' ? !!(this.env['CLAUDE_CODE_OAUTH_TOKEN']?.trim() || this.env['ANTHROPIC_API_KEY']?.trim()) : r.provider === 'chatgpt'
          ? !!this.chatgpt?.status().planUsage
          : r.provider === 'claude_plan'
            ? !!this.claude?.status().signedIn
          : this.pooled({ provider: r.provider, credentialEnv: r.credential_env })
            ? this.accounts!.list().some((a) => a.enabled && a.keyPresent)
            : !!(r.credential_env && this.env[r.credential_env]),
      maxTokens: r.max_tokens,
      contextWindow: r.context_window,
      verifiedAt: r.verified_at,
      lastError: r.last_error,
    };
  }

  list(): Model[] {
    return (this.db.prepare('SELECT * FROM models ORDER BY id').all() as ModelRow[]).map((r) => this.toModel(r));
  }

  get(id: string): Model {
    const row = this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined;
    if (!row) throw new ModelError(`model ${id} does not exist`);
    return this.toModel(row);
  }

  update(id: string, patch: UpdateModel): Model {
    const p = UpdateModel.parse(patch);
    const cur = this.get(id);
    const next = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as Model;
    if (next.provider === 'openai_compat' && !next.baseUrl) throw new ConflictError('an OpenAI-compatible model needs a base URL');
    this.db
      .prepare(
        'UPDATE models SET provider = ?, name = ?, base_url = ?, credential_env = ?, max_tokens = ?, context_window = ?, verified_at = NULL, last_error = NULL WHERE id = ?',
      )
      .run(next.provider, next.name, next.baseUrl, next.credentialEnv, next.maxTokens, next.contextWindow, id);
    return this.get(id);
  }

  remove(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(id)) throw new NotFoundError(`model ${id} does not exist`);
    const users = this.db.prepare('SELECT id FROM agents WHERE model_id = ?').all(id) as { id: string }[];
    if (users.length) throw new ConflictError(`model ${id} is used by ${users.map((u) => '@' + u.id).join(', ')}`);
    this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
  }

  /** Record the outcome of a call: a success clears the error, a non-transient failure is shown until fixed. */
  record(id: string, error: string | null): void {
    if (error === null) this.db.prepare('UPDATE models SET verified_at = ?, last_error = NULL WHERE id = ?').run(new Date().toISOString(), id);
    else this.db.prepare('UPDATE models SET last_error = ? WHERE id = ?').run(error, id);
  }

  create(input: CreateModel): Model {
    const c = CreateModel.parse(input);
    if (c.provider === 'openai_compat' && !c.baseUrl) throw new ConflictError('an OpenAI-compatible model needs a base URL');
    if (this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(c.id)) throw new ConflictError(`model ${c.id} already exists`);
    this.db
      .prepare('INSERT INTO models (id, provider, name, base_url, credential_env, max_tokens, context_window) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.provider, c.name, c.baseUrl, c.credentialEnv, c.maxTokens, c.contextWindow ?? DEFAULT_CONTEXT_WINDOW[c.provider]);
    return this.get(c.id);
  }

  /** A 1-token call proving the model answers (design §5). */
  async test(id: string): Promise<ModelTest> {
    const t0 = Date.now();
    try {
      const { model, provider } = this.provider(id);
      await provider.complete(
        { model: model.name, maxTokens: 1, system: 'Reply with one word.', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], tools: [] },
        () => {},
        AbortSignal.timeout(30_000),
      );
      this.record(id, null);
      const detected = model.provider === 'openai_compat' && model.baseUrl ? await detectContextWindow(model.baseUrl, model.name) : null;
      if (detected) this.db.prepare('UPDATE models SET context_window = ? WHERE id = ?').run(detected, id);
      return { ok: true, error: null, ms: Date.now() - t0, detectedContextWindow: detected };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(id)) this.record(id, error);
      return { ok: false, error, ms: Date.now() - t0, detectedContextWindow: null };
    }
  }

  /** Hook run before each call to a model it claims (the managed local server starts on demand). */
  private before: { serves(baseUrl: string | null): boolean; ensure(): Promise<void> } | null = null;
  setLocal(local: { serves(baseUrl: string | null): boolean; ensure(): Promise<void> }) {
    this.before = local;
  }
  /** Anthropic models without their own key use the accounts (accounts.ts), in priority order. */
  private accounts: { provider(): Provider; list(): { enabled: boolean; keyPresent: boolean }[] } | null = null; // provider() throws when no account can be used
  setAccounts(a: { provider(): Provider; list(): { enabled: boolean; keyPresent: boolean }[] }) {
    this.accounts = a;
  }
  private pooled(m: { provider: string; credentialEnv: string | null }): boolean {
    return m.provider === 'anthropic' && !m.credentialEnv && !!this.accounts && this.factory === realProviders;
  }

  /** The signed-in ChatGPT account (chatgpt.ts) serves 'chatgpt' models with real providers. */
  private chatgpt: { provider(): Provider; status(): { planUsage: boolean } } | null = null;
  setChatGpt(c: { provider(): Provider; status(): { planUsage: boolean } }) {
    this.chatgpt = c;
  }

  /** The signed-in Claude plan (claude-plan.ts) serves 'claude_plan' models with real providers. */
  private claude: { provider(): Provider; status(): { signedIn: boolean } } | null = null;
  setClaude(c: { provider(): Provider; status(): { signedIn: boolean } }) {
    this.claude = c;
  }

  /** The provider for a model, with the same account protections for every request. */
  provider(id: string): { model: Model; provider: Provider } {
    const model = this.get(id);
    const provider =
      model.provider === 'chatgpt' && this.chatgpt && this.factory === realProviders
        ? this.chatgpt.provider()
        : model.provider === 'claude_plan' && this.claude && this.factory === realProviders
          ? this.claude.provider()
        : this.pooled(model)
          ? this.accounts!.provider()
          : this.factory(model, this.env);
    const local = this.before;
    if (!local || !local.serves(model.baseUrl)) return { model, provider };
    return {
      model,
      provider: {
        complete: async (req, onText, signal) => {
          try {
            await local.ensure();
          } catch (e) {
            throw new ModelError(`local model server: ${e instanceof Error ? e.message : String(e)}`);
          }
          return provider.complete(req, onText, signal);
        },
      },
    };
  }
}

/**
 * The context window a local server actually runs a model with (Ollama and llama.cpp default far below the model's
 * maximum, and Ollama silently cuts prompts that overflow it). Asked right after a successful call, so the model is
 * loaded. Ollama: GET /api/ps → context_length. llama.cpp: GET /props → n_ctx. Any other server answers neither:
 * null, and the configured value stays (it is shown and editable in Settings).
 */
export async function detectContextWindow(baseUrl: string, modelName: string): Promise<number | null> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(root + path, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    return res?.ok ? res.json().catch(() => null) : null;
  };
  const ps = (await get('/api/ps')) as { models?: { name?: string; model?: string; context_length?: number }[] } | null;
  const loaded = ps?.models?.find((m) => m.name === modelName || m.model === modelName);
  if (loaded?.context_length) return loaded.context_length;
  const props = (await get('/props')) as { n_ctx?: number; default_generation_settings?: { n_ctx?: number } } | null;
  return props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? null;
}
