import { z } from 'zod';

/** Kanban statuses, in board order (design §7, §16). */
export const CARD_STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'done', 'archived'] as const;
export const CardStatus = z.enum(CARD_STATUSES);
export type CardStatus = z.infer<typeof CardStatus>;

/** Why a card is blocked (design §7). */
export const BLOCK_KINDS = ['needs_input', 'dependency', 'capability', 'transient'] as const;
export const BlockKind = z.enum(BLOCK_KINDS);
export type BlockKind = z.infer<typeof BlockKind>;

export const Block = z.object({
  kind: BlockKind,
  reason: z.string(),
  /** Suggested answers, recommended first. */
  options: z.array(z.string()),
  /** Transient blocks: when the dispatcher retries. */
  until: z.string().nullable(),
});
export type Block = z.infer<typeof Block>;

export const Card = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  status: CardStatus,
  assignee: z.string().nullable(),
  priority: z.number().int(),
  /** 'main': the kanban board. 'direct': Can's direct chat with the assignee (one per agent, never on the board). */
  board: z.enum(['main', 'direct']).default('main'),
  parents: z.array(z.string()),
  block: Block.nullable(),
  /** Plain-words reason a card isn't moving (« why not running »), computed from the tables. */
  waiting: z.string().nullable(),
  conversationId: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Model and effort chosen for this card/chat (null = the agent's model, the model's default effort). */
  modelId: z.string().nullable().default(null),
  effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
});
export type Card = z.infer<typeof Card>;

export const CreateCard = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(''),
  status: CardStatus.default('triage'),
  assignee: z.string().nullable().default(null),
  priority: z.number().int().default(0),
  parents: z.array(z.string()).default([]),
});
export type CreateCard = z.input<typeof CreateCard>;

/**
 * How hard the model thinks: Claude output_config.effort, OpenAI reasoning.effort; Ollama gets none/low/medium/high.
 * 'none' turns thinking off on local models; Claude and the ChatGPT plan have no off, they get low.
 */
export const Effort = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

export const UpdateCard = z
  .object({
    /** This card's or chat's model instead of its agent's; null = the agent's model. */
    modelId: z.string().nullable(),
    /** null = the model's default effort. */
    effort: Effort.nullable(),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(20_000),
    status: CardStatus,
    assignee: z.string().nullable(),
    priority: z.number().int(),
    parents: z.array(z.string()),
  })
  .partial();
export type UpdateCard = z.infer<typeof UpdateCard>;

/** Content blocks, Anthropic-shaped so the transcript can be replayed to a model as-is. */
export const ContentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() }),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.string(),
    is_error: z.boolean().optional(),
  }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

export const Message = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant']),
  author: z.string(),
  content: z.array(ContentBlock),
  at: z.string(),
});
export type Message = z.infer<typeof Message>;

export const PostMessage = z.object({ text: z.string().trim().min(1).max(100_000) });

/**
 * Simplified drawing elements (design §11): what agents write instead of raw Excalidraw JSON. The UI converts them
 * with Excalidraw's skeleton API. `from`/`to` on arrows bind them to other elements by id.
 */
export const SketchElement = z.object({
  id: z.string().optional(),
  type: z.enum(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'frame']),
  x: z.number(),
  y: z.number(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  label: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  color: z.string().optional(),
  background: z.string().optional(),
});
export type SketchElement = z.infer<typeof SketchElement>;

/** A drawing is either agent-written sketch elements, or full Excalidraw elements once edited in the UI. */
export const DrawingScene = z.object({
  sketch: z.array(SketchElement).optional(),
  elements: z.array(z.unknown()).optional(),
  files: z.record(z.string(), z.unknown()).optional(),
});
export type DrawingScene = z.infer<typeof DrawingScene>;

/** Canvas nodes (design §16): one zod entry per renderer kind. Adding a kind = one entry here + one UI renderer. */
const NodeBase = z.object({
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  w: z.number().min(40),
  h: z.number().min(30),
  title: z.string().default(''),
  /** Optional link to a card. */
  cardId: z.string().nullable().optional(),
});
export const CanvasNode = z.discriminatedUnion('kind', [
  NodeBase.extend({ kind: z.literal('markdown'), text: z.string() }),
  NodeBase.extend({ kind: z.literal('html'), html: z.string() }),
  NodeBase.extend({ kind: z.literal('url'), url: z.string().min(1) }),
  NodeBase.extend({ kind: z.literal('drawing'), scene: DrawingScene }),
]);
export type CanvasNode = z.infer<typeof CanvasNode>;
export type CanvasNodeKind = CanvasNode['kind'];

export interface Canvas {
  id: string;
  name: string;
  nodes: CanvasNode[];
  version: number;
  updatedBy: string;
  updatedAt: string;
}
export const CreateCanvas = z.object({ name: z.string().trim().min(1).max(100) });
export const SaveCanvas = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  nodes: z.array(CanvasNode),
  /** Optimistic concurrency: the version the client edited. */
  baseVersion: z.number().int(),
});
export type SaveCanvas = z.infer<typeof SaveCanvas>;
export const CanvasOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('upsert'), node: CanvasNode }),
  z.object({ op: z.literal('delete'), id: z.string() }),
]);
export type CanvasOp = z.infer<typeof CanvasOp>;

export const RUN_STATUSES = ['running', 'done', 'failed', 'stopped', 'interrupted'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RUN_KINDS = ['chat', 'work', 'triage'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export interface Run {
  id: string;
  cardId: string;
  agentId: string;
  kind: RunKind;
  status: RunStatus;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface Agent {
  id: string;
  rolePrompt: string;
  modelId: string;
  workdir: string | null;
  enabled: boolean;
  /** Work runs this agent may have at once. */
  maxRuns: number;
}
export const UpdateAgent = z
  .object({
    rolePrompt: z.string().max(50_000),
    modelId: z.string(),
    workdir: z.string().nullable(),
    enabled: z.boolean(),
    maxRuns: z.number().int().min(1).max(10),
  })
  .partial();
export type UpdateAgent = z.infer<typeof UpdateAgent>;
export const CreateAgent = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/, 'lowercase letters, digits, - or _'),
  rolePrompt: z.string().max(50_000).default(''),
  modelId: z.string(),
  workdir: z.string().nullable().default(null),
  maxRuns: z.number().int().min(1).max(10).default(1),
});
export type CreateAgent = z.input<typeof CreateAgent>;

export interface Settings {
  /** Agent that shapes cards dropped in triage; null = nobody triages. */
  triageAgent: string | null;
}
export const UpdateSettings = z.object({ triageAgent: z.string().nullable() }).partial().strict();

export interface Model {
  id: string;
  /** 'chatgpt': OpenAI models on Can's ChatGPT plan (Sign in with ChatGPT, design §5); name is the model slug. */
  /** 'anthropic': OAuth-based via the claude-code provider (Hermes CLI integration, design §5). */
  /** 'claude_plan': Claude models on Can's Claude plan, through Atlas's own Anthropic-approved sign-in (design §5). */
  provider: 'anthropic' | 'openai_compat' | 'chatgpt' | 'claude_plan' | 'claude_code';
  name: string;
  baseUrl: string | null;
  /** Name of the env var holding the key; never the key itself (CLAUDE.md rule 5). */
  credentialEnv: string | null;
  /** Whether that env var is set in the engine (the value never leaves the engine). */
  credentialPresent: boolean;
  maxTokens: number;
  /** Context window in tokens; the view sent to the model is compacted past 70 % of it (design §8). */
  contextWindow: number;
  /** Last successful test call, and the error of the last failed call or test (cleared by a success). */
  verifiedAt: string | null;
  lastError: string | null;
}

export const MEMORY_LIMIT = 4000;
export interface Memory {
  agentId: string;
  text: string;
  updatedBy: string;
  updatedAt: string | null;
}

// claude_code remains readable only for historical records; new/updated models cannot select it.
export const ModelProvider = z.enum(['anthropic', 'openai_compat', 'chatgpt', 'claude_plan', 'claude_code']);
export const CreateModel = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/, 'lowercase letters, digits, - or _'),
  provider: ModelProvider,
  name: z.string().min(1),
  baseUrl: z.string().url().nullable().default(null),
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable().default(null),
  maxTokens: z.number().int().positive().default(16000),
  /** Omitted: 200k for Anthropic, 32k for local servers (a model test then detects the real value). */
  contextWindow: z.number().int().min(2048).optional(),
});
export type CreateModel = z.input<typeof CreateModel>;
export const DEFAULT_CONTEXT_WINDOW = { anthropic: 200_000, openai_compat: 32_768, chatgpt: 200_000, claude_plan: 200_000, claude_code: 200_000 } as const;
/** Edits: only the fields sent change (no defaults, unlike CreateModel). */
export const UpdateModel = z
  .object({
    provider: ModelProvider,
    name: z.string().min(1),
    baseUrl: z.string().url().nullable(),
    credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable(),
    maxTokens: z.number().int().positive(),
    contextWindow: z.number().int().min(2048),
  })
  .partial();
export type UpdateModel = z.input<typeof UpdateModel>;

export interface ModelTest {
  ok: boolean;
  error: string | null;
  ms: number;
  /** Context window the server reported (Ollama, llama.cpp), now stored on the model; null if it reports none. */
  detectedContextWindow: number | null;
}

export const SCHEDULE_KINDS = ['cron', 'at'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** True for an IANA time zone the runtime knows (Europe/Paris, UTC…). Same check in the UI and the engine. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false; // RangeError is the answer to the question, not a failure
  }
}

/**
 * A schedule (design §9): at a cron time or once at a given instant, give an agent a prompt. Either a new card each
 * time (createCard), or the prompt is posted on the schedule's own card, reopened each time, so the agent keeps the
 * history between runs (chatCardId).
 */
export interface Schedule {
  id: string;
  agentId: string;
  title: string;
  kind: ScheduleKind;
  /** 5-field cron (or 6 with seconds), evaluated in `timezone`. */
  cron: string | null;
  /** One-shot instant, ISO 8601. */
  at: string | null;
  prompt: string;
  createCard: boolean;
  timezone: string;
  enabled: boolean;
  /** Next firing; null once a one-shot has fired. */
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastCardId: string | null;
  chatCardId: string | null;
  /** Why the last firing failed; cleared by the next success. */
  lastError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const ScheduleFields = {
  agentId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(SCHEDULE_KINDS),
  cron: z.string().trim().min(1).nullable(),
  at: z.iso.datetime({ offset: true }).nullable(),
  prompt: z.string().trim().min(1).max(20_000),
  createCard: z.boolean(),
  timezone: z.string().refine(isTimeZone, 'unknown time zone (use an IANA name like Europe/Paris)'),
  enabled: z.boolean(),
};
const needsWhen = (s: { kind?: ScheduleKind; cron?: string | null; at?: string | null }, ctx: z.RefinementCtx) => {
  if (s.kind === 'cron' && !s.cron) ctx.addIssue({ code: 'custom', path: ['cron'], message: 'a cron schedule needs a cron expression' });
  if (s.kind === 'at' && !s.at) ctx.addIssue({ code: 'custom', path: ['at'], message: 'a one-shot schedule needs a time' });
};
export const CreateSchedule = z
  .object({
    ...ScheduleFields,
    /** Defaults to the prompt's first line. */
    title: ScheduleFields.title.optional(),
    cron: ScheduleFields.cron.default(null),
    at: ScheduleFields.at.default(null),
    createCard: ScheduleFields.createCard.default(false),
    /** Defaults to the engine machine's time zone. */
    timezone: ScheduleFields.timezone.optional(),
    enabled: ScheduleFields.enabled.default(true),
  })
  .superRefine(needsWhen);
export type CreateSchedule = z.input<typeof CreateSchedule>;
/** Edits: only the fields sent change (no defaults). Kind/cron/at consistency is checked on the merged result. */
export const UpdateSchedule = z.object(ScheduleFields).partial();
export type UpdateSchedule = z.input<typeof UpdateSchedule>;
export const ScheduleWhen = z.object({ kind: ScheduleFields.kind, cron: ScheduleFields.cron, at: ScheduleFields.at }).superRefine(needsWhen);

/** WebSocket events, engine → UI. */
export type ServerEvent =
  | { type: 'card.updated'; card: Card }
  | { type: 'card.deleted'; id: string }
  | { type: 'message.appended'; message: Message }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.delta'; runId: string; conversationId: string; text: string }
  | { type: 'canvas.updated'; canvas: Canvas }
  | { type: 'canvas.deleted'; id: string }
  | { type: 'schedule.updated'; schedule: Schedule }
  | { type: 'schedule.deleted'; id: string }
  | { type: 'local.updated'; status: LocalStatus }
  | { type: 'local.pull'; pull: LocalPull }
  | { type: 'chatgpt.updated'; status: ChatGptStatus }
  | { type: 'claude.updated'; status: ClaudePlanStatus }
  | { type: 'usage.recorded'; conversationId: string | null; cardId: string | null };

/* ── Token usage (engine usage.ts: every model call, from what the provider reports) ──────────────────── */
export interface UsageCount {
  calls: number;
  /** Prompt tokens, cached part included. */
  input: number;
  output: number;
}
/** One chat's usage, and how full its context was at the latest answer. */
export interface ChatUsage extends UsageCount {
  cached: number;
  /** Prompt size of the latest answer; null before the first one. */
  lastInput: number | null;
  lastModelId: string | null;
  /** Context window of the model that answered last (null if it was deleted). */
  contextWindow: number | null;
}
export interface UsageSummary {
  days: number;
  /** Oldest first, one entry per local day; tokens (in + out) per source. */
  perDay: { day: string; anthropic: number; chatgpt: number; claude_plan: number; claude_code: number; openai_compat: number }[];
  /** Most used first. week = the last 7 days, month = the whole range. */
  models: { modelId: string; provider: Model['provider']; today: UsageCount; week: UsageCount; month: UsageCount }[];
  total: UsageCount & { cached: number };
}

/* ── ChatGPT plan (design §5: OpenAI's Sign in with ChatGPT for open-source, locally hosted apps) ─────────── */

/** Where to review usage and set Atlas's limit (OpenAI asks apps to link it next to usage and on limit errors). */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
/** The ChatGPT account signed in on this machine, as the UI may see it (never a token). */
export interface ChatGptStatus {
  /** Sign-in can work here: the desktop app (tokens in the keychain). A server engine has nowhere safe to keep them yet. */
  available: boolean;
  /** Why not, when unavailable. */
  unavailableReason: string | null;
  signedIn: boolean;
  /** A sign-in is open in the browser, waiting for the callback. */
  pending: boolean;
  email: string | null;
  /** Can allowed Atlas to use the plan (scope chatgpt.tokens.use.direct granted). Signed in without it = no requests. */
  planUsage: boolean;
  /** The one-time « You're using your ChatGPT plan » notice still has to be shown. */
  showWelcome: boolean;
  /** Usage limit reached: requests are paused until Can resumes them. */
  pausedAt: string | null;
  lastError: string | null;
}
export const UpdateChatGpt = z.object({ welcomed: z.literal(true), resume: z.literal(true) }).partial().strict();
export type UpdateChatGpt = z.infer<typeof UpdateChatGpt>;
/** A model the signed-in account can use (GET /v1/models, visibility « list »), in OpenAI's order. */
export interface ChatGptModel {
  slug: string;
  displayName: string;
}
/* ── Claude plan (design §5: Atlas's own Anthropic-approved OAuth client; details from env/keychain) ─────── */

/**
 * The connection details Anthropic issues with its approval, read live from the engine env (desktop: keychain
 * entries set on the Models page; server: .env). Placeholders until Can fills them in.
 */
export const CLAUDE_PLAN_SETTINGS = [
  { name: 'ATLAS_CLAUDE_CLIENT_ID', label: 'Client ID', secret: false, required: true },
  { name: 'ATLAS_CLAUDE_CLIENT_SECRET', label: 'Client secret (only if Anthropic issued one)', secret: true, required: false },
  { name: 'ATLAS_CLAUDE_AUTHORIZE_URL', label: 'Authorization URL', secret: false, required: true },
  { name: 'ATLAS_CLAUDE_TOKEN_URL', label: 'Token URL', secret: false, required: true },
  { name: 'ATLAS_CLAUDE_REVOKE_URL', label: 'Revocation URL (optional)', secret: false, required: false },
  { name: 'ATLAS_CLAUDE_SCOPES', label: 'Scopes (space-separated)', secret: false, required: true },
  { name: 'ATLAS_CLAUDE_REDIRECT_PORT', label: 'Callback port (if the redirect URI is registered with a fixed port)', secret: false, required: false },
  { name: 'ATLAS_CLAUDE_API_BASE', label: 'API base URL (default https://api.anthropic.com)', secret: false, required: false },
  { name: 'ATLAS_CLAUDE_HEADERS', label: 'Extra request headers named in the approval (JSON object)', secret: false, required: false },
] as const;
export type ClaudePlanSetting = (typeof CLAUDE_PLAN_SETTINGS)[number]['name'];

/** The Claude account signed in on this machine, as the UI may see it (never a token or the client secret). */
export interface ClaudePlanStatus {
  available: boolean;
  unavailableReason: string | null;
  /** Every required setting is filled and valid. */
  configured: boolean;
  /** What's missing or refused in the settings (Can reads it on the Models page). */
  configProblems: string[];
  /** Non-secret setting values; secrets only say whether they're set. */
  settings: Record<ClaudePlanSetting, string | null>;
  /** Exact redirect URI to register with Anthropic (null = any loopback port, RFC 8252). */
  redirectUri: string | null;
  signedIn: boolean;
  pending: boolean;
  email: string | null;
  showWelcome: boolean;
  /** Rate or usage limit: no requests until this time (or Resume). */
  pausedUntil: string | null;
  lastError: string | null;
}
export const UpdateClaudePlan = z.object({ welcomed: z.literal(true), resume: z.literal(true) }).partial().strict();
export type UpdateClaudePlan = z.infer<typeof UpdateClaudePlan>;
export interface ClaudePlanModel {
  id: string;
  displayName: string;
}

/* ── Local models (design §5: the engine manages an Ollama server on its own machine) ─────────────────────── */

/** The local model server as the engine sees it. */
export interface LocalStatus {
  runtime: 'ollama';
  /** Where the engine reaches it (also the base URL of local models, + /v1). */
  url: string;
  /** Path of the ollama binary, or null when it isn't installed. */
  binary: string | null;
  version: string | null;
  running: boolean;
  /** started: the engine started it and watches it; external: something else runs it (an app, brew services). */
  owner: 'atlas' | 'external' | null;
  /** The engine starts the server when it starts, and whenever a local model is needed. */
  autostart: boolean;
  /** Context window the server gives each loaded model (OLLAMA_CONTEXT_LENGTH). Applies when Atlas starts it. */
  contextLength: number;
  /** One-click install is possible (Homebrew on macOS). */
  canInstall: boolean;
  installing: boolean;
  /** Last problem (crash, failed start, failed install), cleared by the next success. */
  error: string | null;
  /** This machine's memory, to say whether a model fits. */
  totalMemory: number;
}

export interface LocalModel {
  /** Ollama tag, e.g. qwen3:8b. */
  name: string;
  size: number;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  modifiedAt: string;
  capabilities: string[];
  /** In memory right now. */
  loaded: { memory: number; contextLength: number | null; until: string | null } | null;
  /** Atlas model ids that point at it. */
  usedBy: string[];
}

export interface LocalPull {
  name: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error: string | null;
}

export const UpdateLocal = z
  .object({
    autostart: z.boolean(),
    contextLength: z.number().int().min(2048).max(1_048_576),
  })
  .partial()
  .strict();
export type UpdateLocal = z.infer<typeof UpdateLocal>;

/** Ollama library names (qwen3:8b, or namespace/model:tag). Hugging Face repos are not used (Can, 10 Nov 2026). */
export const PullName = z
  .string()
  .trim()
  .refine((n) => !/^(hf\.co|huggingface\.co)\//i.test(n), 'Hugging Face models are not used: pick one from ollama.com/library')
  .refine((n) => /^[\w.-]+(\/[\w.-]+)?(:[\w.-]+)?$/.test(n), 'not a model name');

/* ── Anthropic accounts (several API keys in priority order; design §5) ──────────────────────────────── */
export interface RateLimit {
  limit: number;
  remaining: number;
  /** ISO time the bucket is full again. */
  reset: string | null;
}
export interface AccountLimits {
  requests: RateLimit | null;
  input: RateLimit | null;
  output: RateLimit | null;
  tokens: RateLimit | null;
  /** When these were read (the last call). */
  at: string;
}
export interface Account {
  id: string;
  provider: 'anthropic';
  label: string;
  /** Name of the env var / keychain entry with the key (never the key). */
  secret: string;
  keyPresent: boolean;
  priority: number;
  enabled: boolean;
  cooldownUntil: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  limits: AccountLimits | null;
  today: { calls: number; input: number; output: number };
}
export const CreateAccount = z.object({
  label: z.string().trim().min(1).max(60),
  /** Desktop: the key itself, saved in the keychain. */
  key: z.string().trim().min(10).optional(),
  /** Server: the env var that holds the key. */
  secret: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  priority: z.number().int().min(0).max(99).optional(),
});
export type CreateAccount = z.infer<typeof CreateAccount>;
export const UpdateAccount = z
  .object({ label: z.string().trim().min(1).max(60), priority: z.number().int().min(0).max(99), enabled: z.boolean(), key: z.string().trim().min(10) })
  .partial()
  .strict();
export type UpdateAccount = z.infer<typeof UpdateAccount>;
