import type { ChatGptModel, ChatGptStatus, ClaudePlanModel, ClaudePlanStatus, CreateModelRequest, LocalModel, LocalStatus, Model } from '@atlas/shared';

/**
 * Settings → Model list, « Available to add » (#101): the models of each source (Claude plan, ChatGPT plan, Ollama on
 * this machine) that can be given to agents. Pure, so the grouping and the « Added » state are tested without a DOM.
 */

/** An Atlas model id for a Claude plan model ('claude-opus-5' → 'plan-claude-opus-5'), distinct from API-key models. */
export const planModelId = (id: string) => ('plan-' + id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')).slice(0, 31);

/** An Atlas model id from an OpenAI slug ('gpt-6.1-sol' → 'gpt-6-1-sol'). */
export const modelId = (slug: string) => {
  const id = slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return (/^[a-z]/.test(id) ? id : 'm-' + id).slice(0, 31);
};

export type SourceId = 'claude_plan' | 'chatgpt' | 'local';

/** How « Give to agents » adds the row: a model record, or the engine's local helper (it picks the id and URL). */
export type AddAction = { kind: 'create'; model: CreateModelRequest } | { kind: 'local'; name: string };

export interface AvailableRow {
  key: string;
  label: string;
  code: string;
  added: boolean;
  add: AddAction;
}

export type SourceState =
  | { kind: 'loading' }
  /** Signed out, not running or not available: one muted line linking to the source's page. */
  | { kind: 'off'; text: string; linkText: string; href: string }
  | { kind: 'empty'; text: string }
  | { kind: 'list'; rows: AvailableRow[] };

export interface AvailableSource {
  id: SourceId;
  title: string;
  state: SourceState;
}

const SUBSCRIPTIONS = '#/settings/subscriptions';
const LOCAL = '#/settings/local';

export function claudeSource(s: ClaudePlanStatus | null, available: ClaudePlanModel[] | null, models: Model[]): AvailableSource {
  const added = new Set(models.filter((m) => m.provider === 'claude_plan').map((m) => m.name));
  const state: SourceState = !s
    ? { kind: 'loading' }
    : !s.available
      ? { kind: 'off', text: s.unavailableReason ?? 'The Claude plan is not available here.', linkText: 'Subscriptions', href: SUBSCRIPTIONS }
      : !s.signedIn || !s.configured
        ? { kind: 'off', text: 'Not signed in.', linkText: 'Sign in on Subscriptions', href: SUBSCRIPTIONS }
        : available === null
          ? { kind: 'loading' }
          : available.length === 0
            ? { kind: 'empty', text: 'This account has no models for Atlas.' }
            : {
                kind: 'list',
                rows: available.map((m) => ({
                  key: 'claude:' + m.id,
                  label: m.displayName,
                  code: m.id,
                  added: added.has(m.id),
                  add: { kind: 'create', model: { id: planModelId(m.id), provider: 'claude_plan', name: m.id } },
                })),
              };
  return { id: 'claude_plan', title: 'Claude plan', state };
}

export function chatgptSource(s: ChatGptStatus | null, available: ChatGptModel[] | null, models: Model[]): AvailableSource {
  const added = new Set(models.filter((m) => m.provider === 'chatgpt').map((m) => m.name));
  const state: SourceState = !s
    ? { kind: 'loading' }
    : !s.available
      ? { kind: 'off', text: s.unavailableReason ?? 'The ChatGPT plan is not available here.', linkText: 'Subscriptions', href: SUBSCRIPTIONS }
      : !s.signedIn
        ? { kind: 'off', text: 'Not signed in.', linkText: 'Sign in on Subscriptions', href: SUBSCRIPTIONS }
        : !s.planUsage
          ? { kind: 'off', text: 'Plan use is not allowed for Atlas.', linkText: 'Allow it on Subscriptions', href: SUBSCRIPTIONS }
          : available === null
            ? { kind: 'loading' }
            : available.length === 0
              ? { kind: 'empty', text: 'This account has no models for Atlas.' }
              : {
                  kind: 'list',
                  rows: available.map((m) => ({
                    key: 'chatgpt:' + m.slug,
                    label: m.displayName,
                    code: m.slug,
                    added: added.has(m.slug),
                    add: { kind: 'create', model: { id: modelId(m.slug), provider: 'chatgpt', name: m.slug } },
                  })),
                };
  return { id: 'chatgpt', title: 'ChatGPT plan', state };
}

export function localSource(s: LocalStatus | null, installed: LocalModel[] | null): AvailableSource {
  const state: SourceState = !s
    ? { kind: 'loading' }
    : !s.binary
      ? { kind: 'off', text: 'Ollama is not installed.', linkText: 'Set it up on Local', href: LOCAL }
      : !s.running
        ? { kind: 'off', text: 'Ollama is not running.', linkText: 'Start it on Local', href: LOCAL }
        : installed === null
          ? { kind: 'loading' }
          : installed.length === 0
            ? { kind: 'off', text: 'No models on this machine yet.', linkText: 'Download one on Local', href: LOCAL }
            : {
                kind: 'list',
                rows: installed.map((m) => ({
                  key: 'local:' + m.name,
                  label: m.name,
                  code: [m.parameterSize, m.quantization].filter(Boolean).join(' · '),
                  added: m.usedBy.length > 0,
                  add: { kind: 'local', name: m.name },
                })),
              };
  return { id: 'local', title: 'Local', state };
}
