import { z } from 'zod';
import { DocRef, type Doc, type Folder, type PanelTab } from './documents.ts';

export * from './documents.ts';
export * from './cardRefs.ts';
export * from './projects.ts';
import type { Project } from './projects.ts';

/** Kanban statuses, in board order (design §7, §16). 'closed' = cancelled: nothing (more) is done; unlike 'done' it
 * doesn't satisfy a child's parents. */
export const CARD_STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'done', 'closed', 'archived'] as const;
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

/* ── Images (#103) ─────────────────────────────────────────────────────────── */

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const ImageMediaType = z.enum(IMAGE_TYPES);
export type ImageMediaType = z.infer<typeof ImageMediaType>;
/** An image file over this size is refused (upload, read_file, web_fetch). */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Images per user message. */
export const IMAGE_MAX_PER_MESSAGE = 5;
/** Images attached to a task (its description, #119). */
export const IMAGE_MAX_PER_TASK = 5;
/** An id from POST /api/uploads (a staged image). */
export const UploadId = z.string().regex(/^up_[a-z0-9-]+$/);
/** Only the newest this-many images of a conversation go to the model as pictures; older ones become a text line. */
export const IMAGE_KEEP = 6;

/**
 * A picture in the transcript. The bytes stay in a file (absolute `path`, in an agent workspace or its outputs);
 * the transcript keeps only this reference, so SQLite stays small. `data` (base64 of the possibly downscaled picture,
 * with `media_type` describing it) is filled only in the view handed to a provider, never stored.
 */
export const ImageBlock = z.object({
  type: z.literal('image'),
  path: z.string(),
  media_type: ImageMediaType,
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
  sha256: z.string(),
  data: z.string().optional(),
});
export type ImageBlock = z.infer<typeof ImageBlock>;

/**
 * A pull request linked to a task (#189): the task sits In review while it is open, goes Done when it merges and back to
 * Ready when CI, a conflict or QA fails. Read from GitHub by the engine (`gh api`); `error` = the last read failed.
 */
export const CardPr = z.object({
  /** owner/name, from the PR's url. */
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  branch: z.string().nullable(),
  base: z.string().nullable(),
  headSha: z.string().nullable(),
  state: z.enum(['open', 'merged', 'closed']),
  mergeSha: z.string().nullable(),
  /** GitHub's mergeable: false = conflicts with its base; null = not computed yet. */
  mergeable: z.boolean().nullable(),
  /** The head's check runs together: null = none (yet). */
  ci: z.enum(['pending', 'success', 'failure']).nullable(),
  /** The `qa/validated` status on the head (scripts/pr/validate.mjs). */
  qa: z.enum(['pending', 'success', 'failure']).nullable(),
  qaDescription: z.string().nullable(),
  /** Last successful read from GitHub. */
  checkedAt: z.string().nullable(),
  /** Why the last read failed, and since when reads fail (null = the last read worked). */
  error: z.string().nullable(),
  errorSince: z.string().nullable(),
  /** The head sha the reviewer was started on (once per head). */
  reviewedSha: z.string().nullable(),
});
export type CardPr = z.infer<typeof CardPr>;

export const Card = z.object({
  id: z.string(),
  /** Board cards: sequential number shown as #N (never reused). Direct chats: null. */
  number: z.number().int().nullable().default(null),
  title: z.string(),
  body: z.string(),
  status: CardStatus,
  assignee: z.string().nullable(),
  priority: z.number().int(),
  /** 'main': the kanban board. 'direct': the user's direct chat with the assignee (one per agent, never on the board). */
  board: z.enum(['main', 'direct']).default('main'),
  parents: z.array(z.string()),
  /** Why it is blocked: only on a 'blocked' card, and a blocked card always needs the user (#131). */
  block: Block.nullable(),
  /**
   * A temporary failure (rate limit, 5xx, plan paused until a reset, or task_block transient): the card waits in 'todo'
   * and the dispatcher moves it to 'ready' at `at`. Not the user's problem, so not a block (#131).
   */
  retry: z.object({ at: z.string(), reason: z.string() }).nullable().default(null),
  /** Plain-words reason a card isn't moving (« why not running »), computed from the tables. */
  waiting: z.string().nullable(),
  conversationId: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Model and effort chosen for this card/chat (null = the agent's model, the model's default effort). */
  modelId: z.string().nullable().default(null),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  /** Direct chats: a better title is being generated by the model (at the user's 3rd message). */
  naming: z.boolean().default(false),
  /** Direct chats: its agent is running a turn right now (a direct chat's status stays 'done'; this is the live signal). */
  working: z.boolean().default(false),
  /** The direct chat this card was created from (card_create in a chat): told when it finishes, closes, stops or needs the user. */
  originCard: z.string().nullable().default(null),
  /** Pictures attached to the task itself (#119): files in <data>/task-images/, shown to its assignee at each run. */
  images: z.array(ImageBlock).default([]),
  /** The agent that checks this task's pull requests while it is In review (#189); null = none yet. */
  reviewer: z.string().nullable().default(null),
  /** Its pull requests (#189), oldest link first. */
  prs: z.array(CardPr).default([]),
  /** The project it belongs to (#213): set at creation, never changes. */
  projectId: z.string().default('atlas'),
});
export type Card = z.infer<typeof Card>;

export const CreateCard = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(''),
  status: CardStatus.default('triage'),
  assignee: z.string().nullable().default(null),
  priority: z.number().int().default(0),
  parents: z.array(z.string()).default([]),
  /** Staged images (POST /api/uploads) to attach to the new task (#119): the API moves them, the row lists them. */
  uploads: z.array(UploadId).max(IMAGE_MAX_PER_TASK).default([]),
  /** Its project (#213), fixed for good; omitted = the default project (the oldest active one). */
  projectId: z.string().min(1).optional(),
});
export type CreateCard = z.input<typeof CreateCard>;
/** POST /api/cards/:id/images: staged images added to an existing task. */
export const AddCardImages = z.object({ uploads: z.array(UploadId).min(1).max(IMAGE_MAX_PER_TASK) });

/** How hard the model thinks: Claude output_config.effort, OpenAI reasoning.effort; Ollama gets low/medium/high. */
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
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
  ImageBlock,
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() }),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.string(),
    is_error: z.boolean().optional(),
    /** Pictures the tool returned (read_file / web_fetch of an image). */
    images: z.array(ImageBlock).optional(),
  }),
  // A tool the provider runs itself (Anthropic's web search). Replayed to the API as-is; never run by Atlas.
  z.object({ type: z.literal('server_tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  // Its result: Anthropic's content (search results with encrypted_content, or an error object), kept verbatim.
  // origin: the account that ran it (#173): its encrypted_content only replays through that account; Atlas's own
  // field, never sent. Missing on results stored before #173 (they replay as text).
  z.object({ type: z.literal('web_search_tool_result'), tool_use_id: z.string(), content: z.unknown(), origin: z.string().optional() }),
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
  /** Hidden by a rewind (only in the agent's history_search; never in the chat or the model's view). */
  rewound: z.boolean().optional(),
});
export type Message = z.infer<typeof Message>;

/* ── Rewind (Stop/Esc rewinds the turn, « Rewind to here », Undo) ─────────── */

/** A file a rewind puts back: its content restored, recreated (deleted since), or deleted (created since). */
export interface FileChange {
  path: string;
  change: 'restored' | 'recreated' | 'deleted';
}
/**
 * Something the rewound part did outside the chat and its files (card #138), and what the rewind does with it: `undone`
 * (a task nobody started closed, a message nobody read withdrawn, a new memory archived, a new schedule turned off; Undo
 * brings it back) or `kept` (already done or read: it can't be taken back), with why.
 */
export interface SideEffect {
  kind: 'task' | 'task_change' | 'message' | 'memory' | 'memory_change' | 'schedule' | 'schedule_delete' | 'artifact' | 'canvas' | 'push';
  /** How it is named: « #131 Mockup: artifacts library », « @zurich », « m104 Library tiles… ». */
  label: string;
  /** The card a task or message is about (a link), else null. */
  cardId: string | null;
  outcome: 'undone' | 'kept';
  /** What happened to it: closed, withdrawn, archived, turned off; « stays » when kept. */
  action: string;
  /** Why it is kept (« @munih already worked on it », « already read »), or null. */
  why: string | null;
}
/** What rewinding to a user message would do (the confirm dialog). */
export interface RewindPreview {
  seq: number;
  /** Messages hidden from the chat (that one and every one after it). */
  hidden: number;
  files: FileChange[];
  /** Why files can't be restored (no snapshot before this message, git missing…); messages are still hidden. */
  filesError: string | null;
  /** What the rewound part did elsewhere: undone or kept (#138). */
  effects: SideEffect[];
}
/** A rewind done: `text` goes back in the composer; Undo with its id. */
export interface RewindResult extends RewindPreview {
  id: string;
  text: string;
}
export const RewindRequest = z.object({ seq: z.number().int().positive().optional() });
/** A composer slash command (#99): /clear, or /compact with an optional focus for the summary. */
export const SlashCommand = z.object({ command: z.enum(['clear', 'compact']), arg: z.string().trim().max(2000).optional() });
export type SlashCommand = z.infer<typeof SlashCommand>;
/** What /compact did: `messages` folded into the summary (tool results not counted). */
export interface CompactResult {
  uptoSeq: number;
  messages: number;
  summaryChars: number;
}

/** One item of an agent's todo list (todo_write: the full list each call, stored per conversation). */
export const TodoItem = z.object({
  content: z.string().trim().min(1).max(500),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
export type TodoItem = z.infer<typeof TodoItem>;
export const TODO_LIMIT = 50;

/** A user message; `ref` = the document part it is about (« Ask about this » in the side panel). */
/** `uploads`: ids from POST /api/cards/:id/uploads; a message may be images only (then `text` is empty). */
export const PostMessage = z
  .object({
    text: z.string().trim().max(100_000).default(''),
    ref: DocRef.optional(),
    uploads: z.array(UploadId).max(IMAGE_MAX_PER_MESSAGE).default([]),
  })
  .refine((m) => m.text.length > 0 || m.uploads.length > 0, { message: 'a message needs text or an image' });
/** An image waiting to be sent (POST /api/cards/:id/uploads): the composer shows it, the message names its id. */
export interface Upload {
  id: string;
  name: string;
  media_type: ImageMediaType;
  width: number;
  height: number;
  bytes: number;
}

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

/** The prompts that start an agent without a user message (author 'system'): the chat shows them as rows (#66). */
export const WORK_KICK = 'This card is ready and assigned to you. Do it.';
export const TRIAGE_KICK = 'New card in triage. Triage it.';
export const RESUME_KICK = 'The engine restarted during your work. Continue where you left off.';

/** A run that ended without finishing (failed, stopped, interrupted): a row in the chat. `next`: when the card's next run started. */
export interface EndedRun extends Run {
  next: string | null;
}
/** A rewind still in effect (messages hidden), shown where they were. */
export interface RewindEvent {
  id: string;
  /** The first hidden message: the row sits after the messages before it. */
  fromSeq: number;
  at: string;
  /** Messages hidden (tool results not counted). */
  hidden: number;
  /** null while the files are still being put back. */
  files: FileChange[] | null;
  filesError: string | null;
  /** What the rewound part did elsewhere: undone or kept (#138). */
  effects: SideEffect[];
  /** Undo would work now (the latest rewind, nothing written since; a running agent still refuses it). */
  undoable: boolean;
}
/** What a chat shows between its messages besides them (#66): ended runs, rewinds, where the context summary ends. */
export interface Timeline {
  runs: EndedRun[];
  rewinds: RewindEvent[];
  /** The model sees `text` instead of every message with seq ≤ uptoSeq. `byUser`: made by /compact (else automatic). */
  summary: { uptoSeq: number; text: string; byUser?: boolean } | null;
  /** /clear points in effect, oldest first. Absent from engines before #99. */
  clears?: ClearEvent[];
}
/** A /clear in effect (#99): the agent forgets every message with seq ≤ uptoSeq; the chat folds them behind the row. */
export interface ClearEvent {
  id: string;
  uptoSeq: number;
  at: string;
  /** Messages before it (tool results not counted). */
  hidden: number;
  /** Undo would work now: the latest clear, nothing written since. */
  undoable: boolean;
}

/** When one tool call of a run ran (the tool_calls table): the chat shows its duration, or a live timer. */
export interface ToolCallTiming {
  /** The tool_use block's id in the assistant message. */
  toolUseId: string;
  name: string;
  status: 'running' | 'done' | 'error';
  startedAt: string;
  endedAt: string | null;
  /** What a file tool did (tool_calls.detail), for the chat's detail views; never sent to the model. */
  detail?: ToolCallDetail;
  /** The last lines of a running foreground shell command: live events only, never stored. */
  tail?: string;
  /** Secret values replaced by [secret NAME] in this call's output (#206): the chat's « 1 secret hidden ». */
  secretsHidden?: number;
}

/**
 * edit: the 1-based line (in the edited file) where each replacement starts.
 * write: created a new file, or rewrote one; `before` = its previous text (null when too big to keep).
 */
export type ToolCallDetail = { kind: 'edit'; lines: number[] } | { kind: 'write'; created: boolean; before: string | null };

export interface Agent {
  id: string;
  rolePrompt: string;
  modelId: string;
  workdir: string | null;
  enabled: boolean;
  /** Work runs this agent may have at once. */
  maxRuns: number;
  /**
   * Its main chat (v3) in the default project: the direct chat the sidebar and voice open; null until first opened.
   * One per project (#214): `Project.members[].mainChat`.
   */
  mainChat: string | null;
}
/** Starts a user message that came by voice (speech-to-text): the agent answers it in short spoken sentences. */
export const VOICE_MARK = '🎙 ';
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
  /**
   * Agent that checks pull requests of tasks In review (#189); its own PRs go to the triage agent. null = nobody: the
   * task waits In review and says so.
   */
  reviewAgent: string | null;
  /** The human's name, as agents address them (asked on first launch; null until then). */
  userName: string | null;
  /** The human in their own words (age, job, background): agents adapt to it. Asked on first launch. */
  userAbout: string | null;
  /**
   * The model of the background memory review (after a task ends, every REVIEW_EVERY messages of a chat): null = automatic
   * (a Sonnet model if there is one, else the agent's own), 'off' = no review.
   */
  memoryReviewModel: string | null;
}
/** Max length of Settings.userAbout. */
export const USER_ABOUT_MAX = 200;
/** Author id of the human's messages (and actor of their changes). */
export const USER = 'user';
/** Settings → About & data. */
export interface About {
  version: string;
  /** Where the database, workspaces and logs live on the engine's machine. */
  dataDir: string;
  /** Server mode (login required) rather than the desktop app. */
  server: boolean;
  /** Voice mode is available (the desktop app on a Mac): shows Settings → Voice. */
  voice: boolean;
  /** The PATH agent commands get (#136); null while the login shell is still being read. */
  shellPath: ShellPathInfo | null;
}
/** Where agent shells get their PATH from (#136). */
export interface ShellPathInfo {
  path: string;
  /** 'login': the user's login shell; 'engine': the engine's own environment (server mode, Windows, or a failure). */
  source: 'login' | 'engine';
  /** The login shell asked, if any. */
  shell: string | null;
  /** Why the login shell's PATH could not be read (then source is 'engine'). */
  error: string | null;
}
/** A published release newer than the running app (GET /api/update). */
export interface AppRelease {
  version: string;
  /** The release notes: its CHANGELOG.md entry (markdown). */
  notes: string;
  publishedAt: string;
}
export type UpdatePhase = 'idle' | 'downloading' | 'verifying' | 'installing' | 'failed';
/** App updates from GitHub releases (#123, docs/updater.md): Settings → About, the sidebar badge and its dialog. */
export interface UpdateStatus {
  current: string;
  /** Null when this app can install an update by itself (the packaged Mac app); else why not (dev, server, Windows). */
  cannotInstall: string | null;
  checking: boolean;
  checkedAt: string | null;
  /** The last check failed (no network, GitHub refused): shown as is. */
  checkError: string | null;
  /** Releases newer than the running version, newest first; empty = up to date. */
  releases: AppRelease[];
  phase: UpdatePhase;
  /** The version being (or last tried to be) installed. */
  target: string | null;
  received: number;
  total: number | null;
  /** Why the last install failed (phase 'failed'). */
  error: string | null;
  lastUpdate: { from: string; to: string; at: string } | null;
  /** Agents with a run going now: they are interrupted by the restart and resume after it. */
  working: { agent: string; card: number | null; title: string }[];
}
export const UpdateSettings = z
  .object({
    triageAgent: z.string().nullable(),
    reviewAgent: z.string().nullable(),
    userName: z.string().trim().min(1, 'Enter your name').max(40),
    userAbout: z.string().trim().min(1, 'Say a few words about yourself').max(USER_ABOUT_MAX),
    memoryReviewModel: z.string().min(1).nullable(),
  })
  .partial()
  .strict();

export interface Model {
  id: string;
  /** 'chatgpt': OpenAI models on the user's ChatGPT plan (Sign in with ChatGPT, design §5); name is the model slug. */
  /** 'anthropic': OAuth-based via the claude-code provider (Hermes CLI integration, design §5). */
  /** 'claude_plan': Claude models billed to the signed-in Claude subscription via OAuth. */
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

/**
 * Memory v2 (design §8), per project since #215. Three levels: `global` (the user's own rules and preferences, who the
 * user is: every project, projectId null), `shared` (every member of one project) and `agent:<id>` (that agent in one
 * project). A run sees global + its project's shared + its own in that project, nothing of another project. Rules,
 * preferences and pinned rows are always in the system prompt (MEMORY_BUDGET chars per run, of which global takes at
 * most MEMORY_BUDGET_GLOBAL, enforced on write); facts and task notes (kind `project`) come back by recall.
 */
export const MEMORY_TEXT_MAX = 500;
/** Always-on chars a run sees: global + its project + its own there. */
export const MEMORY_BUDGET = 3000;
/** The global part of MEMORY_BUDGET: every project keeps at least MEMORY_BUDGET - MEMORY_BUDGET_GLOBAL for itself. */
export const MEMORY_BUDGET_GLOBAL = 1500;
export const MEMORY_RECALL = 8;
/** The background memory review reads a chat again after this many new messages (v3). */
export const MEMORY_REVIEW_EVERY = 20;
/** `project` = task notes (about one task, stale when it ends): the stored value predates projects (#215). */
export const MemoryKind = z.enum(['rule', 'preference', 'fact', 'project']);
export type MemoryKind = z.infer<typeof MemoryKind>;
export const MemoryStatus = z.enum(['active', 'stale', 'archived']);
export type MemoryStatus = z.infer<typeof MemoryStatus>;
export const MemoryScope = z.string().regex(/^(global|shared|agent:[a-z][a-z0-9_-]*)$/, 'global, shared or agent:<id>');
export const GLOBAL_SCOPE = 'global';
export interface Memory {
  id: number;
  kind: MemoryKind;
  scope: string;
  /** The project of a `shared` or `agent:<id>` memory; null for `global`. */
  projectId: string | null;
  text: string;
  /** Where it was learned: a message of a conversation (null when the user wrote it or it came from the v1 migration). */
  sourceConversationId: string | null;
  sourceSeq: number | null;
  /** That conversation's card (to open it), when it still exists. */
  sourceCardId: string | null;
  /** Task notes: the card they belong to; they go `stale` when that card is done or closed. */
  cardId: string | null;
  status: MemoryStatus;
  pinned: boolean;
  createdAt: string;
  confirmedAt: string;
  updatedAt: string;
  updatedBy: string;
}
/** `projectId`: a project memory's project (omitted = the default project); none for a global one. */
export const CreateMemory = z
  .object({
    kind: MemoryKind,
    scope: MemoryScope,
    text: z.string().trim().min(1).max(MEMORY_TEXT_MAX),
    pinned: z.boolean().default(false),
    cardId: z.string().nullable().default(null),
    projectId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type CreateMemory = z.input<typeof CreateMemory>;
/**
 * Edit, pin, archive (status archived), restore (status active) or move: scope `global` drops the project; `shared` or
 * `agent:<id>` from global takes `projectId` (omitted = the default project); `projectId` alone moves it to that project.
 */
export const UpdateMemory = z
  .object({ text: z.string().trim().min(1).max(MEMORY_TEXT_MAX), kind: MemoryKind, scope: MemoryScope, projectId: z.string().min(1), pinned: z.boolean(), status: MemoryStatus })
  .partial()
  .strict();
export type UpdateMemory = z.infer<typeof UpdateMemory>;
/** `project`: one project's memories (global ones are scope `global`). */
export const MemoryQuery = z
  .object({ scope: MemoryScope, project: z.string().min(1), kind: MemoryKind, status: MemoryStatus, q: z.string().trim().min(1) })
  .partial();
export type MemoryQuery = z.infer<typeof MemoryQuery>;
/** An agent's always-on memory in one project: the run's total and its global part, against their budgets. */
export interface MemoryBudget {
  used: number;
  limit: number;
  global: number;
  globalLimit: number;
  projectId: string;
}
/** One change to a memory, for the daily digest and its undo. `before`: the row before the change (null for an add). */
export interface MemoryChange {
  id: number;
  memoryId: number;
  at: string;
  by: string;
  action: 'add' | 'update' | 'confirm' | 'forget' | 'restore' | 'pin' | 'unpin' | 'stale' | 'undo';
  before: { text: string; kind: MemoryKind; scope: string | null; projectId: string | null; status: MemoryStatus; pinned: boolean } | null;
  /** Undone by a later change (its id). */
  undoneBy: number | null;
}

/**
 * Weekly memory cleanup (#83): an agent proposes, the user approves or rejects each line in the Inbox. merge: the first
 * memory gets `text` (and kind/scope if given), the others are archived. update: one memory gets text/kind/scope.
 * archive: every memory listed is archived.
 */
export const ProposalAction = z.enum(['merge', 'update', 'archive']);
export type ProposalAction = z.infer<typeof ProposalAction>;
export type ProposalStatus = 'pending' | 'approved' | 'rejected';
export interface MemoryProposal {
  id: number;
  /** The cleanup card that made it. */
  cardId: string;
  action: ProposalAction;
  memoryIds: number[];
  text: string | null;
  kind: MemoryKind | null;
  scope: string | null;
  reason: string;
  status: ProposalStatus;
  createdBy: string;
  createdAt: string;
  decidedAt: string | null;
  /** The memories it is about, as they are now. */
  memories: Memory[];
}

// claude_code remains readable only for historical records (the store can still hold it); the API
// rejects it on create/update through CreateModelRequest/UpdateModelRequest below.
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
/** Providers a new or edited model may select through the API (claude_code was removed in 0018). */
export const SelectableModelProvider = z.enum(['anthropic', 'openai_compat', 'chatgpt', 'claude_plan'], {
  error: (iss) =>
    iss.input === 'claude_code'
      ? 'provider claude_code was removed (0018): existing rows stay readable, but new or edited models cannot select it'
      : 'provider must be one of anthropic, openai_compat, chatgpt, claude_plan',
});
/** POST /api/models body: like CreateModel, without the removed claude_code provider. */
export const CreateModelRequest = CreateModel.extend({ provider: SelectableModelProvider });
export type CreateModelRequest = z.input<typeof CreateModelRequest>;
/** PATCH /api/models/:id body: like UpdateModel, without the removed claude_code provider. */
export const UpdateModelRequest = UpdateModel.extend({ provider: SelectableModelProvider.optional() });
export type UpdateModelRequest = z.input<typeof UpdateModelRequest>;

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

/* ── Workflows (#170, design §9): a trigger wired to agent steps, approvals and conditions. They replaced schedules. ── */

export const WORKFLOW_NODE_KINDS = ['trigger', 'agent', 'approval', 'condition'] as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];
/** The named exits of each kind of node: one edge per exit at most. */
export const WORKFLOW_EXITS = {
  trigger: ['start'],
  agent: ['done', 'failed'],
  approval: ['approved', 'rejected'],
  condition: ['yes', 'no'],
} as const satisfies Record<WorkflowNodeKind, readonly string[]>;
/** Exits that end a run as Failed when nothing is wired to them; every other unwired exit ends it Done. */
export const WORKFLOW_FAILING_EXITS = ['failed', 'rejected'] as const;

/** At set times (a cron in a time zone, or once at an instant: what schedules had) or only by hand (Run now). */
export const TimeTrigger = z.object({
  kind: z.literal('time'),
  repeat: z.enum(SCHEDULE_KINDS),
  /** 5-field cron (or 6 with seconds), evaluated in `timezone`. */
  cron: z.string().trim().min(1).nullable().default(null),
  /** Once, at this instant (ISO 8601 with offset). */
  at: z.iso.datetime({ offset: true }).nullable().default(null),
  timezone: z.string().refine(isTimeZone, 'unknown time zone (use an IANA name like Europe/Paris)'),
});
export const TriggerConfig = z.discriminatedUnion('kind', [TimeTrigger, z.object({ kind: z.literal('manual') })]);
export type TriggerConfig = z.infer<typeof TriggerConfig>;
/** An agent gets the prompt as a task: a new task each run, or one task reopened each run that keeps the history. */
export const AgentStepConfig = z.object({
  title: z.string().trim().max(200).default(''),
  /** null: not chosen yet (a run reaching it fails and says so). */
  agentId: z.string().min(1).nullable().default(null),
  /** Variables: {{run.id}}, {{previous.summary}}, {{previous.task}}. */
  prompt: z.string().max(20_000).default(''),
  newTaskEachRun: z.boolean().default(false),
});
/** A task blocked on Master in the Inbox, with Approve / Reject. */
export const ApprovalConfig = z.object({ title: z.string().trim().max(200).default(''), question: z.string().max(5_000).default('') });
/** Two tests only, nothing judged by a model. `node`: the step counted. */
export const ConditionConfig = z.discriminatedUnion('test', [
  z.object({ test: z.literal('ranFewer'), title: z.string().trim().max(200).default(''), node: z.string().min(1), times: z.number().int().min(1).max(100) }),
  z.object({ test: z.literal('summaryContains'), title: z.string().trim().max(200).default(''), text: z.string().min(1).max(500) }),
]);
const nodeBase = { id: z.string().trim().min(1).max(40), x: z.number().finite(), y: z.number().finite() };
export const WorkflowNode = z.discriminatedUnion('kind', [
  z.object({ ...nodeBase, kind: z.literal('trigger'), config: TriggerConfig }),
  z.object({ ...nodeBase, kind: z.literal('agent'), config: AgentStepConfig }),
  z.object({ ...nodeBase, kind: z.literal('approval'), config: ApprovalConfig }),
  z.object({ ...nodeBase, kind: z.literal('condition'), config: ConditionConfig }),
]);
export type WorkflowNode = z.infer<typeof WorkflowNode>;
export type WorkflowNodeInput = z.input<typeof WorkflowNode>;
export const WorkflowEdge = z.object({ from: z.string().min(1), exit: z.string().min(1), to: z.string().min(1) });
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;
export const WorkflowGraph = z.object({ nodes: z.array(WorkflowNode).max(100), edges: z.array(WorkflowEdge).max(300) });
export type WorkflowGraph = z.infer<typeof WorkflowGraph>;

export const WORKFLOW_RUN_STATES = ['running', 'waiting', 'done', 'failed', 'stopped', 'skipped'] as const;
/** waiting: the current step waits for Master (an approval, or an agent's task blocked on you or in review). */
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];
export type WorkflowStepState = 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export interface WorkflowRunStep {
  id: number;
  nodeId: string;
  kind: WorkflowNodeKind;
  /** 1 the first time this node runs in the run, 2 the second (a loop)… */
  round: number;
  state: WorkflowStepState;
  /** The exit taken, once finished. */
  exit: string | null;
  cardId: string | null;
  summary: string | null;
  startedAt: string;
  endedAt: string | null;
}
export interface WorkflowRun {
  id: string;
  workflowId: string;
  /** Run 1, 2, 3… within its workflow. */
  number: number;
  state: WorkflowRunState;
  trigger: 'time' | 'manual';
  /** Why it ended (failed, stopped, skipped) or how (the exit that ended it). */
  reason: string | null;
  startedAt: string;
  endedAt: string | null;
  /** In GET /api/workflow-runs/:id, the workflow.run event and a workflow's lastRun. */
  steps?: WorkflowRunStep[];
}

export interface Workflow extends WorkflowGraph {
  id: string;
  name: string;
  /** Off: the trigger doesn't fire; Run now still works. */
  enabled: boolean;
  /** 'schedules': migrated from a schedule (#170). */
  origin: 'schedules' | null;
  /** Bumped by every graph save: a save from an older revision is refused. */
  revision: number;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  /** Why the trigger last failed to start a run; cleared by the next start. */
  lastError: string | null;
  /** The latest run that ran (a skipped one only when none did), with its steps, for lists. */
  lastRun: WorkflowRun | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Its project (#213); null = global. */
  projectId: string | null;
}

/** POST /api/workflows/preview: the next firings of a draft time trigger (time zone: the engine's if not given). */
export const TriggerPreview = z.object({
  repeat: z.enum(SCHEDULE_KINDS),
  cron: z.string().trim().min(1).nullable().default(null),
  at: z.iso.datetime({ offset: true }).nullable().default(null),
  timezone: z.string().optional(),
});
export type TriggerPreview = z.input<typeof TriggerPreview>;

export const CreateWorkflow = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  nodes: WorkflowGraph.shape.nodes,
  edges: WorkflowGraph.shape.edges,
  /** Its project (#213); null = global (its tasks go to the default project); omitted = the default project. */
  projectId: z.string().min(1).nullable().optional(),
});
export type CreateWorkflow = z.input<typeof CreateWorkflow>;
/** PUT /api/workflows/:id/graph: `revision` is the one the editor loaded. */
export const SaveWorkflowGraph = WorkflowGraph.extend({ revision: z.number().int() });
export type SaveWorkflowGraph = z.input<typeof SaveWorkflowGraph>;
export const UpdateWorkflow = z.object({ name: z.string().trim().min(1).max(200), enabled: z.boolean() }).partial();
export type UpdateWorkflow = z.input<typeof UpdateWorkflow>;

/** WebSocket events, engine → UI. */
export type ServerEvent =
  | { type: 'card.updated'; card: Card }
  | { type: 'card.deleted'; id: string }
  | { type: 'message.appended'; message: Message }
  /** Messages were hidden by a rewind or brought back by its undo: reload the conversation. */
  | { type: 'conversation.rewound'; cardId: string; conversationId: string }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.delta'; runId: string; conversationId: string; text: string }
  /** Thinking text as the model streams it (#80): shown live above the reply, not spoken. */
  | { type: 'run.thinking'; runId: string; conversationId: string; text: string }
  /** A tool call started or ended. */
  | { type: 'toolcall.updated'; cardId: string; call: ToolCallTiming }
  | { type: 'document.updated'; doc: Doc }
  /** Library folders were created, renamed or deleted (a delete also sends its artifacts as document.updated). */
  | { type: 'folders.updated'; folders: Folder[] }
  | { type: 'memory.updated'; memory: Memory }
  | { type: 'memory.proposal'; proposal: MemoryProposal }
  | { type: 'panel.updated'; chatId: string; tabs: PanelTab[] }
  | { type: 'workflow.updated'; workflow: Workflow }
  | { type: 'workflow.deleted'; id: string }
  /** A run started, moved to another step or ended (with its steps). */
  | { type: 'workflow.run'; run: WorkflowRun }
  | { type: 'local.updated'; status: LocalStatus }
  | { type: 'local.pull'; pull: LocalPull }
  | { type: 'chatgpt.updated'; status: ChatGptStatus }
  | { type: 'claude.updated'; status: ClaudePlanStatus }
  | { type: 'usage.recorded'; conversationId: string | null; cardId: string | null }
  | { type: 'notification.created'; notification: Notification }
  /** Notifications were read or archived: reload the Inbox. */
  | { type: 'inbox.changed' }
  | { type: 'voice.updated'; status: VoiceStatus }
  | { type: 'update.updated'; status: UpdateStatus }
  /** A secret was added, edited, rotated, deleted or used: reload Settings → Secrets (names and metadata only). */
  | { type: 'secrets.updated' }
  /** The server's secrets.enc was unlocked, locked or got a new password (#208): the sidebar badge and Settings → Secrets. */
  | { type: 'secrets.status'; status: SecretStoreStatus }
  /** A project was created, edited, archived or restored, or a member joined or left (#213). */
  | { type: 'project.updated'; project: Project };

/* ── Voice mode (desktop only): « Hi Atlas », all local (docs/voice-research.md) ─────────────────────── */

/** Supertonic 3 voices, the default first (Master's pick, card #42; same ids as @atlas/voice VOICES). */
export const VOICE_NAMES = ['voice-9', 'voice-0', 'voice-1', 'voice-2', 'voice-3', 'voice-4', 'voice-5', 'voice-6', 'voice-7', 'voice-8'] as const;
export type VoiceName = (typeof VOICE_NAMES)[number];
/** macOS microphone permission, as Electron reports it. */
export type MicAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
export interface VoiceModelStatus {
  id: string;
  label: string;
  bytes: number;
  installed: boolean;
}
export interface VoiceStatus {
  enabled: boolean;
  voice: VoiceName;
  /** Wake word sensitivity, 0 (low) … 1 (high). */
  sensitivity: number;
  models: VoiceModelStatus[];
  /** A model download under way: bytes over every missing model. */
  download: { received: number; total: number; model: string } | null;
  mic: MicAccess;
  /** The last download or load failure, in words; cleared by a retry. */
  error: string | null;
  /**
   * « Pause listening » (menu bar, card #54): microphone closed and orb hidden while voice mode stays on. `until`: when
   * it resumes by itself (ISO), or null = until Master resumes it. null = not paused.
   */
  paused: { until: string | null } | null;
  /** Enabled, not paused, every model installed and the microphone allowed. */
  ready: boolean;
  /**
   * « Hey Atlas » wake word (card #57). Off: nothing listens at rest, the microphone stays closed until the push-to-talk
   * shortcut (or « Start talking » in the menu bar) opens it for one conversation.
   */
  wakeWord: boolean;
  /**
   * Push-to-talk (card #57): a global shortcut (Electron accelerator, e.g. « Alt+Space ») that does what « Hey Atlas »
   * does; pressed again while Atlas speaks it interrupts, while it listens it ends the conversation. Or, on a Mac,
   * PTT_HOLD_OPTION (card #75): hold ⌥ alone to talk, release to send. `error`: the desktop app could not register it
   * (another app holds it, or macOS has not allowed Input Monitoring: `permission`, Settings shows a button for it).
   */
  ptt: { enabled: boolean; shortcut: string; error: string | null; permission: boolean };
}

/* Push-to-talk shortcuts: Electron accelerators, at least one modifier (a bare key would be taken from every app). */
export const DEFAULT_PTT_SHORTCUT = 'Alt+Space';
/** Push-to-talk as a walkie-talkie on a Mac (card #75): hold ⌥ alone (left or right) to talk, release to send. */
export const PTT_HOLD_OPTION = 'Option';
/** The default push-to-talk: hold ⌥ on a Mac, ⌥Space elsewhere. */
export const defaultPttShortcut = (platform: string): string => (platform === 'darwin' ? PTT_HOLD_OPTION : DEFAULT_PTT_SHORTCUT);
/** macOS: System Settings → Privacy & Security → Input Monitoring (hold ⌥ needs it). */
export const INPUT_MONITORING_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';
const PTT_MODIFIERS = ['Command', 'Control', 'Alt', 'Shift'] as const;
const PTT_KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|[-=[\];',./\\`])$/;
/** Why `acc` can't be a push-to-talk shortcut, or null when it can (« Alt+Space », « Command+Shift+K », « Option »). */
export function pttShortcutProblem(acc: string): string | null {
  if (acc === PTT_HOLD_OPTION) return null;
  const parts = acc.split('+');
  const key = parts.pop() ?? '';
  if (!parts.length) return 'the shortcut needs at least one modifier (⌘, ⌃, ⌥ or ⇧)';
  if (new Set(parts).size !== parts.length || parts.some((m) => !(PTT_MODIFIERS as readonly string[]).includes(m))) return `unknown modifier in « ${acc} »`;
  if (!PTT_KEY.test(key)) return `unsupported key « ${key} »`;
  return null;
}
/** « Alt+Space » → « ⌥ Space » (macOS symbols, modifiers in Apple's order). */
export function pttShortcutLabel(acc: string): string {
  if (acc === PTT_HOLD_OPTION) return '⌥ Option (hold)';
  const parts = acc.split('+');
  const key = parts.pop() ?? '';
  const sym: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };
  const mods = Object.keys(sym).filter((m) => parts.includes(m)).map((m) => sym[m]).join('');
  const keys: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩', Backspace: '⌫', Delete: '⌦', Tab: '⇥' };
  return `${mods} ${keys[key] ?? key}`.trim();
}
/** How Master starts talking with it: « hold ⌥ Option » / « press ⌥ Space ». */
export const pttAction = (acc: string): string => (acc === PTT_HOLD_OPTION ? 'hold ⌥ Option' : `press ${pttShortcutLabel(acc)}`);

export const UpdateVoice = z
  .object({
    enabled: z.boolean(),
    voice: z.enum(VOICE_NAMES),
    sensitivity: z.number().min(0).max(1),
    wakeWord: z.boolean(),
    ptt: z.boolean(),
    pttShortcut: z.string().superRefine((s, ctx) => {
      const problem = pttShortcutProblem(s);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
    /** null: resume. `until` null: until resumed; an ISO time in the future: until then. */
    pause: z
      .object({ until: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'until must be an ISO date').nullable() })
      .strict()
      .nullable(),
  })
  .partial()
  .strict();
export type UpdateVoice = z.infer<typeof UpdateVoice>;

/* ── Plan subscriptions (design §5: several Claude / ChatGPT sign-ins, failover in list order) ─────────── */

/** One usage window of a plan: how much is used (percent) and when it resets. */
export interface PlanWindow {
  usedPct: number;
  resetsAt: string | null;
}
/** A subscription's usage, from the headers of its latest response. */
export interface PlanQuota {
  fiveHour: PlanWindow | null;
  week: PlanWindow | null;
  /** The provider's overall status word when it sends one (Claude: allowed, allowed_warning, rejected). */
  status: string | null;
  at: string;
}
export type PlanProvider = 'claude_plan' | 'chatgpt';
/** One signed-in (or to-be-signed-in) subscription, as the UI may see it (never a token). */
export interface PlanAccount {
  id: string;
  provider: PlanProvider;
  label: string;
  position: number;
  signedIn: boolean;
  email: string | null;
  /** ChatGPT: plan use was allowed at sign-in. Claude: same as signedIn. */
  planUsage: boolean;
  /** Usage limit: no requests to this account. pausedUntil null while paused = until Resume. */
  paused: boolean;
  pausedUntil: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  quota: PlanQuota | null;
}
export const CreatePlanAccount = z.object({ provider: z.enum(['claude_plan', 'chatgpt']), label: z.string().trim().min(1).max(40) }).strict();
export type CreatePlanAccount = z.infer<typeof CreatePlanAccount>;
export const UpdatePlanAccount = z.object({ label: z.string().trim().min(1).max(40), resume: z.literal(true) }).partial().strict();
export type UpdatePlanAccount = z.infer<typeof UpdatePlanAccount>;

/**
 * Kinds of notification the engine writes. card.blocked / card.review rows are for the system notification and history;
 * the Inbox shows those cards from their live state (InboxNeed). plan.* rows are « system ».
 */
export const NOTIFICATION_KINDS = ['card.blocked', 'card.review', 'card.done', 'run.failed', 'schedule.ran', 'memory.cleanup', 'plan.switched', 'plan.exhausted', 'github.unreadable', 'review.stalled'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Something the user is told about (also shown as a system notification by the app). */
export interface Notification {
  id: number;
  at: string;
  kind: string;
  title: string;
  body: string;
  cardId: string | null;
  readAt: string | null;
  /** Archived from the Inbox (E): it leaves the list. */
  archivedAt: string | null;
  /** Its task's project (#213); null = not about a task. */
  projectId: string | null;
}

/** A board card waiting on the user (blocked or in review): derived from the card's live state, so it leaves the Inbox by itself. */
export interface InboxNeed {
  card: Card;
  /** When it started waiting on the user. */
  since: string;
  /** Blocked because its last run failed (shown with the error and Retry). */
  failed: boolean;
  /** The latest card.blocked / card.review row for this card (opening the item marks it read), if any. */
  notificationId: number | null;
  unread: boolean;
  /** The handoff of card_request_review (review only), else null. */
  summary: string | null;
}

/** The Inbox (design §16): « Needs you » on top, then « Updates » (not archived, newest first). */
export interface Inbox {
  needsYou: InboxNeed[];
  updates: Notification[];
  /** The sidebar badge: needs you + unread updates. */
  badge: number;
}

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
  /** The plan subscription that served the latest answer, with its quota (null: not a plan model). */
  plan: { provider: PlanProvider; label: string; quota: PlanQuota | null } | null;
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
  /** The user allowed Atlas to use the plan (scope chatgpt.tokens.use.direct granted). Signed in without it = no requests. */
  planUsage: boolean;
  /** The one-time « You're using your ChatGPT plan » notice still has to be shown. */
  showWelcome: boolean;
  /** Every signed-in account reached its usage limit (the first one's pause time); null while one can still answer. */
  pausedAt: string | null;
  lastError: string | null;
  /** The subscriptions, in failover order. Top-level fields describe the provider as a whole. */
  accounts: PlanAccount[];
  /** Which account a sign-in in progress is for. */
  pendingAccountId: string | null;
}
export const UpdateChatGpt = z.object({ welcomed: z.literal(true), resume: z.literal(true) }).partial().strict();
export type UpdateChatGpt = z.infer<typeof UpdateChatGpt>;
/** A model the signed-in account can use (GET /v1/models, visibility « list »), in OpenAI's order. */
export interface ChatGptModel {
  slug: string;
  displayName: string;
}
/* ── Claude subscription OAuth ───────────────────────────────────────────────────── */

/**
 * Optional advanced OAuth overrides. Normal subscription sign-in uses built-in defaults.
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
  { name: 'ATLAS_CLAUDE_HEADERS', label: 'Extra request headers (JSON object)', secret: false, required: false },
] as const;
export type ClaudePlanSetting = (typeof CLAUDE_PLAN_SETTINGS)[number]['name'];

/** The Claude account signed in on this machine, as the UI may see it (never a token or the client secret). */
export interface ClaudePlanStatus {
  available: boolean;
  unavailableReason: string | null;
  /** Every required setting is filled and valid. */
  configured: boolean;
  /** What's missing or refused in the settings (the user reads it in Settings → Subscriptions). */
  configProblems: string[];
  /** Non-secret setting values; secrets only say whether they're set. */
  settings: Record<ClaudePlanSetting, string | null>;
  /** Exact redirect URI to register with Anthropic (null = any loopback port, RFC 8252). */
  redirectUri: string | null;
  signedIn: boolean;
  pending: boolean;
  email: string | null;
  showWelcome: boolean;
  /** Every signed-in account reached its limit: the earliest reset (null while one can still answer). */
  pausedUntil: string | null;
  lastError: string | null;
  /** The subscriptions, in failover order. */
  accounts: PlanAccount[];
  /** Which account a sign-in in progress is for. */
  pendingAccountId: string | null;
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

/** Ollama library names (qwen3:8b, or namespace/model:tag). Hugging Face repos are not used (10 Nov 2026). */
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

/**
 * Secrets (#206): API keys, tokens and URLs agents use in shell commands as $NAME, and the model keys Atlas itself uses.
 * The value lives only in the secret store (OS keychain); this is the metadata (table `secrets`). No route returns a value.
 */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export type SecretKind = 'model_key' | 'agent';
/** Who gets an agent secret: nobody (default), the listed agents, or every agent. Model keys are always 'none'. */
export type SecretGrant = 'none' | 'agents' | 'all';
export interface SecretInfo {
  name: string;
  description: string;
  kind: SecretKind;
  grant: SecretGrant;
  /** The agents of grant 'agents' (empty otherwise). */
  agents: string[];
  /** Null = global (every project); else the project that owns it: only its runs get it, only its members can be granted it. */
  project: string | null;
  /** False when the row exists but the store holds no value (a crash between the two writes, or an agent's request). */
  hasValue: boolean;
  /** 'user' or an agent id. */
  createdBy: string;
  createdCard: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  lastUsedAt: string | null;
  lastUsedBy: string | null;
  /** « Needs secret X » (#207): the blocked task that waits for this value (or grant); it restarts by itself then. */
  waitingCard: string | null;
}
/**
 * Where secret values are kept (#208): 'keychain' (desktop, always open), 'file' (server: secrets.enc, locked until its
 * password is given), 'env' (no store: keys come from the engine's environment, nothing can be written).
 */
export interface SecretStoreStatus {
  kind: 'keychain' | 'file' | 'env';
  /** secrets.enc exists (a password was set). False: the first password creates it. Always true for the keychain. */
  exists: boolean;
  /** Values can't be read or written: commands that use a secret, models whose key is in the store and new secrets stop. */
  locked: boolean;
  /** When it was last unlocked or locked (null for the keychain and env). */
  since: string | null;
  /** Who unlocked it: ATLAS_SECRETS_PASSWORD at start, or typed in Settings. Null when locked. */
  source: 'env' | 'ui' | null;
  /** ATLAS_SECRETS_PASSWORD was set but did not unlock the file: why. */
  error: string | null;
}
export interface SecretList {
  /** Where values are kept ('macOS Keychain'), or null: this engine has no store (keys come from its environment). */
  store: string | null;
  status: SecretStoreStatus;
  /** Names with a stored value (plan sign-ins excluded), for the API keys and Model list pages. */
  names: string[];
  secrets: SecretInfo[];
}
export const CreateSecret = z
  .object({
    name: z.string().regex(SECRET_NAME_RE, 'letters A-Z, digits and _, starting with a letter'),
    description: z.string().trim().max(500).default(''),
    value: z.string().trim().min(1),
    grant: z.enum(['none', 'agents', 'all']).default('none'),
    agents: z.array(z.string()).default([]),
    /** Null = global; a project id (or name): only that project's runs get it (#215). */
    project: z.string().min(1).nullable().default(null),
  })
  .strict();
export type CreateSecret = z.infer<typeof CreateSecret>;
/** POST /api/secrets/unlock (server): the secrets password, kept in memory only. */
export const UnlockSecrets = z.object({ password: z.string().min(1).max(1024) }).strict();
export type UnlockSecrets = z.infer<typeof UnlockSecrets>;
/** POST /api/secrets/password (server): no `current` the first time (it creates secrets.enc), else the current one. */
export const SecretsPassword = z.object({ current: z.string().min(1).max(1024).optional(), next: z.string().min(8).max(1024) }).strict();
export type SecretsPassword = z.infer<typeof SecretsPassword>;
/** Names are fixed after creation; the value changes through PUT /api/secrets/:name only. */
export const UpdateSecret = z
  .object({ description: z.string().trim().max(500), grant: z.enum(['none', 'agents', 'all']), agents: z.array(z.string()), project: z.string().min(1).nullable() })
  .partial()
  .strict();
export type UpdateSecret = z.infer<typeof UpdateSecret>;

/** Pre-v3 transcripts call the task tools card_* (card_create…): the same tool under its current task_* name. */
export const currentToolName = (name: string): string => (name.startsWith('card_') ? `task_${name.slice(5)}` : name);
