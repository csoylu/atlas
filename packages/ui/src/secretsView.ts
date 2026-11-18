import type { Account, Model, SecretInfo, SecretStoreStatus } from '@atlas/shared';
import type { Element, ElementContent, Root, RootContent } from 'hast';

/**
 * Settings → Secrets (#209, mockup #205) and the redacted values in a chat: the pure parts, tested in
 * secretsView.test.ts. Values never reach the UI: everything here works on names and metadata.
 */

/** `[secret NAME]`: what the engine puts in place of a secret's value in a tool output (secrets.ts redact). */
export const SECRET_MARK = /\[secret ([A-Z][A-Z0-9_]{1,63})\]/g;

/** Text split around the `[secret NAME]` marks. */
export function splitSecretMarks(text: string): (string | { secret: string })[] {
  const out: (string | { secret: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(SECRET_MARK)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ secret: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The names of the secrets hidden in a text, once each, in order. */
export const hiddenNames = (text: string): string[] => [...new Set([...text.matchAll(SECRET_MARK)].map((m) => m[1]!))];

/** « 1 secret hidden », « 3 secrets hidden »: the pill on a tool row. */
export const hiddenPill = (n: number) => `${n} ${n === 1 ? 'secret' : 'secrets'} hidden`;

/** Rehype plugin: each `[secret NAME]` in a message becomes <span class="sec-redacted">, also inside inline code. */
export function rehypeSecrets() {
  return (tree: Root) => markIn(tree);
}

function markIn(node: Root | Element): void {
  const kids = node.children as (RootContent | ElementContent)[];
  for (let i = kids.length - 1; i >= 0; i--) {
    const k = kids[i]!;
    if (k.type === 'element') {
      markIn(k);
      continue;
    }
    if (k.type !== 'text' || !SECRET_MARK.test(k.value)) continue;
    SECRET_MARK.lastIndex = 0;
    const parts: ElementContent[] = splitSecretMarks(k.value).map((p) =>
      typeof p === 'string'
        ? { type: 'text', value: p }
        : { type: 'element', tagName: 'span', properties: { className: ['sec-redacted'], title: `The value of ${p.secret} is hidden` }, children: [{ type: 'text', value: `[secret ${p.secret}]` }] },
    );
    kids.splice(i, 1, ...parts);
  }
}

// ── Dates ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const hm = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (d: Date, now: Date) =>
  d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });

/** « today 09:40 », « yesterday », « 12 Nov »: when a secret was updated or a store unlocked. */
export function whenText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return `today ${hm(d)}`;
  if (sameDay(d, new Date(now.getTime() - 86_400_000))) return 'yesterday';
  return day(d, now);
}

/** « just now », « 14 min ago », « 2 h ago », then whenText: when a secret was last used. */
export function agoText(iso: string, now = new Date()): string {
  const s = (now.getTime() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 6 * 3600) return `${Math.floor(s / 3600)} h ago`;
  return whenText(iso, now);
}

// ── Rows ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Agent secrets with a value by name, then the ones without a value (an agent asked for them, or a crash), as in the mockup. */
export function agentSecrets(list: SecretInfo[]): SecretInfo[] {
  return list.filter((s) => s.kind === 'agent').sort((a, b) => Number(!a.hasValue) - Number(!b.hasValue) || a.name.localeCompare(b.name));
}

/** The agents a secret goes to: 'all', or the listed ones (empty = nobody). */
export const grantees = (s: Pick<SecretInfo, 'grant' | 'agents'>, all: string[]): string[] => (s.grant === 'all' ? all : s.grant === 'agents' ? s.agents : []);

/** « munih and zurich », « munih, paris and zurich ». */
export function andList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** What Delete costs, said before it happens. */
export function deleteText(s: Pick<SecretInfo, 'name' | 'grant' | 'agents'>): string {
  const who = s.grant === 'all' ? 'Every agent loses it' : s.grant === 'agents' && s.agents.length ? `${andList(s.agents)} ${s.agents.length === 1 ? 'loses' : 'lose'} it` : 'No agent has it';
  return s.grant === 'none' || (s.grant === 'agents' && !s.agents.length)
    ? `${who}; the value is gone for good.`
    : `${who}: $${s.name} is empty in their next commands.`;
}

/**
 * A model key's row: the Anthropic account it belongs to (API keys page) or the models that use it (Model list), with
 * where to manage it. A key nothing uses any more keeps its env name.
 */
export function modelKeyRow(s: Pick<SecretInfo, 'name'>, accounts: Account[], models: Model[]): { title: string; description: string; open: { label: string; hash: string } } {
  const i = accounts.findIndex((a) => a.secret === s.name);
  if (i >= 0)
    return {
      title: `Anthropic · ${accounts[i]!.label}`,
      description: `Anthropic account ${i + 1} of ${accounts.length} · Claude models`,
      open: { label: 'Open in API keys', hash: '#/settings/api-keys' },
    };
  const users = models.filter((m) => m.credentialEnv === s.name).map((m) => `« ${m.id} »`);
  return {
    title: s.name,
    description: users.length ? `Key of the ${users.length === 1 ? 'model' : 'models'} ${andList(users)}` : 'No model uses this key',
    open: { label: 'Open in Model list', hash: '#/settings/model-list' },
  };
}

/** The store line above the list: where values are kept, or how the server's file was unlocked. */
export function storeLine(store: string | null, st: SecretStoreStatus, now = new Date()): string {
  if (st.kind === 'env') return "This engine has no secret store: model keys come from its environment, and agent secrets can't be added.";
  if (st.kind === 'keychain') return `Encrypted with the ${store ?? 'keychain'}`;
  const when = st.since ? ` ${whenText(st.since, now)}` : '';
  return st.source === 'env' ? `unlocked at start by ATLAS_SECRETS_PASSWORD${when}` : `unlocked by you${when}`;
}

/** A name as typed: upper case, spaces and dashes to _, other characters dropped. */
export const cleanName = (typed: string) => typed.toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '');
