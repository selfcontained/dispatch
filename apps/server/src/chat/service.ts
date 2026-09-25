import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { Pool } from "pg";
import type {
  Block,
  BlockAuthor,
  BlockStartup,
  BlockFindingData,
  BlockFindingResolution,
  BlockFindingState,
  BlockFindingStatus,
  BlockFormData,
  BlockKind,
  BlockLinkData,
  BlockQuestionData,
  BlockReviewInput,
  BlockTasksData,
  ChatAttachment,
  ChatUserAttachmentInput,
  StreamAnswerResponse,
  StreamBlockEntry,
  StreamChangedEvent,
  StreamEntryEvent,
  StreamFeedResponse,
  StreamPostResponse,
  StreamReactionResponse,
  StreamReadEvent,
} from "@dispatch/shared";
import {
  BLOCK_ATTACHMENTS_MAX,
  BLOCK_CANCEL_REASON_MAX_CHARS,
  BLOCK_FORM_FIELDS_MAX,
  BLOCK_OPTION_LABEL_MAX_CHARS,
  BLOCK_OPTIONS_MAX,
  BLOCK_REACTIONS_MAX,
  BLOCK_REVIEW_FINDINGS_MAX,
  BLOCK_TASKS_MAX,
  BLOCK_TEXT_MAX_CHARS,
  reviewFindings,
} from "@dispatch/shared";

import type { AgentRecord, AgentTerminalAccess } from "../agents/types.js";
import { resolveFilesDir } from "../shared/files.js";
import { agentTree, parentAgentId, rootAgentId } from "../agents/tree.js";
import {
  buildPostEnvelope,
  describeReview,
  buildReactionEnvelope,
  buildRetryTurnEnvelope,
  RETRY_TURN_NOTICE,
  type EnvelopeSender,
  formatAttachmentSize,
} from "./envelope.js";
import {
  type ComposeFeedOptions,
  composeStreamFeed,
  loadBlockEntry,
} from "./feed.js";
import {
  loadNewestTurnBlockId,
  loadTurnEntries,
  turnAnchorOf,
} from "./turns.js";
import { findMentions, type Mentionable } from "./mentions.js";
import type { PromptSource } from "../agents/acp/prompt-source.js";
import {
  StreamStore,
  type StreamEventRow,
  type TurnPayload,
} from "../agents/acp/stream-store.js";
import {
  BlockStore,
  isBlockId,
  sameAuthor,
  shownIdsOf,
  type UpdateBlockInput,
} from "./store.js";
import { chatUrlSchema, normalizeReactionEmoji } from "./validation.js";

/**
 * An attachment as an agent supplies it to `post`: `file` names a file it
 * shared before (by `fileName` or `fileId`) or a `path` on disk that the
 * server uploads first; the server fills in the file row fields.
 */
export type BlockAttachmentInput =
  | {
      type: "file";
      fileName?: string;
      fileId?: number;
      path?: string;
      description?: string;
    }
  | { type: "link"; url: string; title?: string }
  | { type: "pr"; url: string; title?: string }
  | { type: "code"; code: string; language?: string; path?: string };

/** What an agent hands `post`. */
export type PostInput = {
  /** The agent to deliver to; omitted = the author's own stream, for people. */
  to?: string | null;
  kind?: BlockKind;
  text?: string;
  replyTo?: string | null;
  question?: BlockQuestionData | null;
  form?: BlockFormData | null;
  link?: BlockLinkData | null;
  review?: BlockReviewInput | null;
  tasks?: BlockTasksData | null;
  attachments?: BlockAttachmentInput[];
  /** Also send the browser/Slack notification. */
  notify?: boolean;
};

export type UpdateInput = {
  text?: string;
  data?: unknown;
  state?: Record<string, unknown>;
  attachments?: BlockAttachmentInput[];
};

/**
 * How a block reaches an agent. The service owns the workflow (row,
 * envelope, outcome, events); this adapter owns the runtime, so tests can
 * stand in a fake and the service never imports it.
 */
/**
 * How long a prompt may sit unaccepted by an idle engine before Dispatch
 * calls it undelivered. Long enough that an engine merely slow to pick a
 * prompt up is not written off; short enough that nobody watches a
 * spinner for the rest of the session.
 */
const DELIVERY_GIVE_UP_MS = 90_000;

export type StreamDeliveryAdapter = {
  /**
   * Whether the agent can receive a prompt right now. Throws `AgentError`
   * for a missing/stopped agent; resolves to `mode: "inert"` when there is
   * no engine.
   */
  access: (agentId: string) => Promise<AgentTerminalAccess>;
  /** Queue `text` as a prompt for the agent; resolves when accepted. */
  /**
   * Queue the envelope as a prompt. `blockId` names the block the envelope
   * carries, so the turn it opens can be tied back to it without anything
   * reading the id out of the envelope text again.
   */
  inject: (
    agentId: string,
    text: string,
    opts?: { blockId?: string; source?: PromptSource; alone?: boolean }
  ) => Promise<void>;
  /** Whether a turn is holding deliveries for this agent right now. */
  held: (agentId: string) => boolean;
  /** Whether an active turn, rather than queued prompts, blocks delivery. */
  activeTurn: (agentId: string) => boolean;
  /** Cut the agent's running turn, for a post sent to interrupt it. */
  cancel: (agentId: string) => Promise<void>;
  controlQueuedPrompt?: (
    agentIds: string[],
    blockId: string,
    action: "delete" | "send-now"
  ) => boolean;
  /** Names of commands this agent's ACP session currently accepts. */
  commands?: (agentId: string) => readonly string[];
};

export type StreamAgent = Pick<
  AgentRecord,
  "id" | "name" | "filesDir" | "status"
>;

export type StreamServiceDeps = {
  pool: Pool;
  publishUiEvent: (
    event: StreamChangedEvent | StreamEntryEvent | StreamReadEvent
  ) => void;
  /** Minimal agent lookup: name, files dir and status are all the service needs. */
  getAgent: (agentId: string) => Promise<StreamAgent | null>;
  /**
   * Root of per-agent files directories (config.filesRoot), so the envelope
   * can hand the agent an absolute path for a file attachment — the same
   * resolution `GET /files/:file` serves from.
   */
  filesRoot: string;
  /**
   * Whether any browser is listening. Composing a turn entry reads the whole
   * open turn and the recorder asks for one about ten times a second, so an
   * unattended agent would pay for an announcement nobody receives. Absent
   * means assume someone is listening.
   */
  hasUiClient?: () => boolean;
  /** An agent posted a question or form for people: it is waiting now. */
  onInputPosted?: (agentId: string, text: string) => Promise<void>;
  /** Copy a file from the agent's disk into its files; for `path` attachments. */
  uploadFile?: (
    agentId: string,
    input: { filePath: string; description: string }
  ) => Promise<{ fileName: string }>;
  /** The browser/Slack notification a post with `notify: true` sends. */
  notify?: (
    agentId: string,
    input: { message: string; title?: string }
  ) => Promise<unknown>;
  /** Required for anything that delivers to an agent. */
  delivery?: StreamDeliveryAdapter;
  log?: {
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
};

/** Base for the domain errors the HTTP layer maps to a status code. */
export abstract class StreamServiceError extends Error {
  abstract readonly statusCode: number;
}

export class StreamValidationError extends StreamServiceError {
  readonly statusCode = 400;
}

export class StreamNotFoundError extends StreamServiceError {
  readonly statusCode = 404;
}

export class StreamConflictError extends StreamServiceError {
  readonly statusCode = 409;
}

export class StreamForbiddenError extends StreamServiceError {
  readonly statusCode = 403;
}

/**
 * What an agent was created with, as `AgentManager.createAgent` hands it to
 * the recorder once the agent row and its file rows exist. Files are the
 * seeded file rows; links are the raw startup URLs.
 */
export type LaunchContextInput = {
  agentId: string;
  /** The initial prompt as the person (or launching agent) wrote it. */
  text?: string;
  files?: Array<{ fileId: number }>;
  links?: string[];
  /** The agent that created this one via launch_agent, if any. */
  launchedByAgentId?: string | null;
};

/**
 * The id a new agent's launch card is written with: derived from the
 * agent's, so the steps of its startup, the instructions it runs with and
 * its briefing all land on the one row whichever is written first. A
 * v5-shaped UUID over the agent id, which the column requires. (Cards that
 * predate this have ids of their own; they are found by agent, not by id.)
 */
export function launchBlockId(agentId: string): string {
  return derivedBlockId(`launch:${agentId}`);
}

function derivedBlockId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) +
      h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

/** A launch block resolved but not yet written; see `prepareLaunchContext`. */
export type PreparedLaunchContext = {
  id: string;
  /**
   * One envelope line per resolved startup attachment — *every* one, not
   * the capped set the row stores. The engine's first turn must still
   * describe all the startup files and links.
   */
  attachmentLines: string[];
  /** Exactly what the row will store. */
  postText: string;
  /** Write the block and announce the feed change. */
  record: () => Promise<Block>;
};

/**
 * Appended to a launch block whose prompt did not fit in
 * `BLOCK_TEXT_MAX_CHARS`. The engine's first turn always carries the full
 * prompt, so the block must say plainly that it is showing less.
 */
export const LAUNCH_POST_TRUNCATED_NOTE =
  "[Truncated for the stream — the agent's first turn received the full prompt.]";

function launchPostAttachmentNote(hidden: number): string {
  return `[${hidden} more startup attachment${hidden === 1 ? "" : "s"} not listed here — all of them were delivered to the agent.]`;
}

/**
 * The launch block's stored text, normalized once so the row and the first
 * turn cannot disagree without saying so.
 */
export function buildLaunchPostText(
  text: string,
  hiddenAttachments = 0
): string {
  const notes: string[] = [];
  if (hiddenAttachments > 0) {
    notes.push(launchPostAttachmentNote(hiddenAttachments));
  }
  const reserved = notes.reduce((sum, note) => sum + note.length + 2, 0);
  let body = text;
  if (body.length + reserved > BLOCK_TEXT_MAX_CHARS) {
    const budget =
      BLOCK_TEXT_MAX_CHARS - reserved - (LAUNCH_POST_TRUNCATED_NOTE.length + 2);
    body = body.slice(0, Math.max(0, budget));
    notes.unshift(LAUNCH_POST_TRUNCATED_NOTE);
  }
  return [body, ...notes].filter((part) => part.length > 0).join("\n\n");
}

export type AnswerInput = {
  /** Client-minted id for the reply block. */
  id?: string;
  value: string;
  /** Only consulted for a freeform answer; an option's label wins otherwise. */
  label?: string;
  attachments?: ChatUserAttachmentInput[];
};

const ANSWER_LABEL_MAX = 200;
const NO_OP_LOG = { warn() {}, error() {} };
const USER: BlockAuthor = { kind: "user" };

// ---------------------------------------------------------------------------
// Validation: the shape checks zod cannot express across fields, and the
// per-kind rules for `data`.
// ---------------------------------------------------------------------------

function requireText(text: string | undefined): string {
  const value = text ?? "";
  if (value.length > BLOCK_TEXT_MAX_CHARS) {
    throw new StreamValidationError(
      `text must be ${BLOCK_TEXT_MAX_CHARS} characters or fewer.`
    );
  }
  return value;
}

/**
 * `state.cancellation` as given to `update`/`PATCH …/state`: `true` (no
 * reason), a reason string, or `{ reason }`. Anything else is malformed.
 */
function parseCancelReason(raw: unknown): string | undefined {
  if (raw === true) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed
      ? trimmed.slice(0, BLOCK_CANCEL_REASON_MAX_CHARS)
      : undefined;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const reason = (raw as { reason?: unknown }).reason;
    if (reason === undefined) return undefined;
    if (typeof reason !== "string") {
      throw new StreamValidationError(
        "state.cancellation.reason must be a string."
      );
    }
    const trimmed = reason.trim();
    return trimmed
      ? trimmed.slice(0, BLOCK_CANCEL_REASON_MAX_CHARS)
      : undefined;
  }
  throw new StreamValidationError(
    "state.cancellation must be true, a reason string, or { reason }."
  );
}

function uniqueIds(items: Array<{ id: string }>, what: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item.id !== "string" || !item.id.trim()) {
      throw new StreamValidationError(`Every ${what} needs an id.`);
    }
    if (seen.has(item.id)) {
      throw new StreamValidationError(`Duplicate ${what} id "${item.id}".`);
    }
    seen.add(item.id);
  }
}

/** The kind a post is, from what it carries; and its validated data. */
export function resolveKindAndData(input: PostInput): {
  kind: BlockKind;
  data: unknown;
} {
  const given = [
    input.question ? "question" : null,
    input.form ? "form" : null,
    input.link ? "link" : null,
    input.review ? "review" : null,
    input.tasks ? "tasks" : null,
  ].filter((k): k is BlockKind => k !== null);
  if (given.length > 1) {
    throw new StreamValidationError(
      `A post carries one of question, form, link, review or tasks, not ${given.join(" and ")}.`
    );
  }
  // A post that carries nothing but text and files is a file post.
  const kind =
    input.kind ??
    given[0] ??
    ((input.attachments ?? []).some((a) => a.type === "file")
      ? "file"
      : "text");
  if (given[0] && given[0] !== kind) {
    throw new StreamValidationError(
      `kind "${kind}" does not match the ${given[0]} data given.`
    );
  }
  switch (kind) {
    case "text":
      return { kind, data: null };
    case "file":
      if (!(input.attachments ?? []).some((a) => a.type === "file")) {
        throw new StreamValidationError(
          'kind "file" needs at least one file attachment.'
        );
      }
      return { kind, data: null };
    case "question": {
      const q = input.question;
      if (!q || !Array.isArray(q.options) || q.options.length === 0) {
        throw new StreamValidationError("question needs at least one option.");
      }
      if (q.options.length > BLOCK_OPTIONS_MAX) {
        throw new StreamValidationError(
          `question.options must have ${BLOCK_OPTIONS_MAX} entries or fewer.`
        );
      }
      for (const o of q.options) {
        const label = typeof o.label === "string" ? o.label.trim() : "";
        if (!label || label.length > BLOCK_OPTION_LABEL_MAX_CHARS) {
          throw new StreamValidationError(
            `Each option label must be 1–${BLOCK_OPTION_LABEL_MAX_CHARS} characters: a short action for a button. Put the explanation in the text.`
          );
        }
      }
      return {
        kind,
        data: {
          options: q.options.map((o) => ({
            label: o.label.trim(),
            ...(o.value !== undefined ? { value: o.value } : {}),
          })),
          ...(q.allowFreeform ? { allowFreeform: true } : {}),
        },
      };
    }
    case "form": {
      const f = input.form;
      if (!f || !Array.isArray(f.fields) || f.fields.length === 0) {
        throw new StreamValidationError("form needs at least one field.");
      }
      if (f.fields.length > BLOCK_FORM_FIELDS_MAX) {
        throw new StreamValidationError(
          `form.fields must have ${BLOCK_FORM_FIELDS_MAX} entries or fewer.`
        );
      }
      uniqueIds(f.fields, "form field");
      for (const field of f.fields) {
        if (field.type === "select" && !(field.options?.length ?? 0)) {
          throw new StreamValidationError(
            `form field "${field.id}" is a select and needs options.`
          );
        }
      }
      return { kind, data: f };
    }
    case "link": {
      const l = input.link;
      const url = chatUrlSchema.safeParse(l?.url);
      if (!l || !url.success) {
        throw new StreamValidationError("link needs an absolute http(s) url.");
      }
      return {
        kind,
        data: { url: url.data, ...(l.title ? { title: l.title } : {}) },
      };
    }
    case "review": {
      const r = input.review;
      if (!r || typeof r.summary !== "string" || !Array.isArray(r.findings)) {
        throw new StreamValidationError("review needs summary and findings.");
      }
      if (r.findings.length > BLOCK_REVIEW_FINDINGS_MAX) {
        throw new StreamValidationError(
          `review.findings must have ${BLOCK_REVIEW_FINDINGS_MAX} entries or fewer.`
        );
      }
      const review: BlockReviewInput = {
        summary: requireText(r.summary),
        findings: r.findings.map((finding, index) =>
          validateFinding(finding, `finding ${index + 1}`)
        ),
      };
      return { kind, data: review };
    }
    case "finding":
    case "launch":
      throw new StreamValidationError(
        `A ${kind} block is written by Dispatch, not posted: post a review to raise findings.`
      );
    case "tasks": {
      const t = input.tasks;
      if (!t || !Array.isArray(t.items) || t.items.length === 0) {
        throw new StreamValidationError("tasks needs at least one item.");
      }
      if (t.items.length > BLOCK_TASKS_MAX) {
        throw new StreamValidationError(
          `tasks.items must have ${BLOCK_TASKS_MAX} entries or fewer.`
        );
      }
      uniqueIds(t.items, "task");
      return { kind, data: t };
    }
  }
}

/** A finding as a reviewer states it, checked and trimmed to what is stored. */
function validateFinding(value: unknown, label: string): BlockFindingData {
  const f = (value ?? {}) as Partial<BlockFindingData>;
  if (!["blocker", "major", "minor", "nit"].includes(f.severity as string)) {
    throw new StreamValidationError(`${label} has an unknown severity.`);
  }
  const title = typeof f.title === "string" ? f.title.trim() : "";
  if (!title || title.length > 300) {
    throw new StreamValidationError(
      `${label} needs a title of 1–300 characters.`
    );
  }
  if (typeof f.body !== "string" || !f.body.trim()) {
    throw new StreamValidationError(`${label} needs a body.`);
  }
  return {
    severity: f.severity as BlockFindingData["severity"],
    title,
    body: requireText(f.body),
    ...(typeof f.path === "string" && f.path.trim()
      ? { path: f.path.trim() }
      : {}),
    ...(typeof f.line === "number" && Number.isInteger(f.line) && f.line > 0
      ? { line: f.line }
      : {}),
  };
}

/** New `data` for a block its author is editing, checked against its kind. */
function validUpdateData(block: Block, value: unknown): unknown {
  switch (block.kind) {
    case "review": {
      const summary = (value as { summary?: unknown } | null)?.summary;
      if (typeof summary !== "string") {
        throw new StreamValidationError(
          "A review's data is { summary }; its findings are blocks of their own."
        );
      }
      return { summary: requireText(summary) };
    }
    case "finding":
      return validateFinding(value, "finding");
    case "launch":
      throw new StreamValidationError("A launch card is written by Dispatch.");
    default:
      return resolveKindAndData({
        kind: block.kind,
        ...(block.kind === "question"
          ? { question: value as BlockQuestionData }
          : {}),
        ...(block.kind === "form" ? { form: value as BlockFormData } : {}),
        ...(block.kind === "link" ? { link: value as BlockLinkData } : {}),
        ...(block.kind === "tasks" ? { tasks: value as BlockTasksData } : {}),
        attachments: block.attachments.map((a) =>
          a.type === "file" ? { type: "file" as const, fileId: a.fileId } : a
        ),
      }).data;
  }
}

/** The initial state a kind starts with. */
function initialState(kind: BlockKind, data: unknown): unknown {
  switch (kind) {
    case "question":
    case "form":
      return {};
    case "tasks": {
      const items: Record<string, string> = {};
      for (const item of (data as BlockTasksData).items)
        items[item.id] = "todo";
      return { items };
    }
    default:
      return null;
  }
}

type TurnPublish = { done: Promise<void>; again: boolean };

/**
 * Everything that reads or writes a stream: posts from people and agents,
 * answers, state changes, reactions, delivery to agents, the launch block,
 * and the events that keep a mounted feed current.
 */
/**
 * The text a block delivers as a prompt: its own text, plus what its data
 * says when the data is the point (a review's findings). A question's
 * options are not spelled out: the recipient of a question is a person.
 */
function envelopeText(block: Block): string {
  if (block.kind === "review") {
    const review = describeReview(block, reviewFindings(block));
    return block.text.trim() ? `${block.text.trim()}\n\n${review}` : review;
  }
  return block.text;
}

/**
 * Who a post is addressed to, in the order it named them: the agents it
 * mentioned or was sent to, or its single recipient. Empty for a block
 * meant for people.
 */
export function addressedTo(block: Block): string[] {
  const data = block.kind === "text" ? block.data : undefined;
  const named = data?.mentions?.length ? data.mentions : data?.recipients;
  if (named && named.length > 0) return named;
  return block.toAgentId ? [block.toAgentId] : [];
}

/** The agents on the two sides of a block: who wrote or launched it, and whom it is for. */
function sidesOf(block: Block): string[] {
  const sides = [
    block.author.kind === "agent" ? block.author.agentId : null,
    block.launchedByAgentId ?? null,
    block.toAgentId,
  ].filter((id): id is string => !!id);
  return [...new Set(sides)];
}

export class StreamService {
  readonly store: BlockStore;
  private readonly turns: StreamStore;
  private readonly inFlightDeliveries = new Set<Promise<unknown>>();
  private readonly turnPublishes = new Map<string, TurnPublish>();
  private readonly log: NonNullable<StreamServiceDeps["log"]>;

  constructor(private readonly deps: StreamServiceDeps) {
    this.store = new BlockStore(deps.pool);
    this.turns = new StreamStore(deps.pool);
    this.log = deps.log ?? NO_OP_LOG;
  }

  /**
   * The stream an agent's blocks live in: its root's. A child posts into
   * its parent's stream; an agent with no parent has its own.
   */
  streamOf(agentId: string): Promise<string> {
    return rootAgentId(this.deps.pool, agentId);
  }

  /**
   * Who a reply in a thread is for, when the writer named nobody. A thread
   * has two sides: its host's author (or the agent that launched it) and
   * whoever the host is for — on a finding the reviewer and the agent whose
   * work it is; on a launch card the parent and its child.
   *
   * - answering a particular comment goes to that comment's author;
   * - one side writing goes to the other side;
   * - a person writing goes to both sides, so neither hears of it second
   *   hand.
   *
   * Falls back to any other agent in the thread; empty when there is none.
   */
  private async threadRecipients(
    thread: { threadId: string; replyTo: string },
    author: BlockAuthor
  ): Promise<string[]> {
    const host = await this.store.getById(thread.threadId);
    if (!host) return [];
    const self = author.kind === "agent" ? author.agentId : null;
    if (thread.replyTo !== thread.threadId) {
      const target = await this.store.getById(thread.replyTo);
      if (target?.author.kind === "agent" && target.author.agentId !== self) {
        return [target.author.agentId];
      }
    }
    const sides = sidesOf(host).filter((id) => id !== self);
    if (sides.length > 0) return sides;
    const others = await this.store.threadParticipants(thread.threadId, author);
    const agent = others.find(
      (p): p is { kind: "agent"; agentId: string } => p.kind === "agent"
    );
    return agent ? [agent.agentId] : [];
  }

  /**
   * An agent's launch card, written if it is not there yet: the one block
   * its startup steps, its instructions and its briefing all land on,
   * whichever comes first.
   */
  async ensureLaunchBlock(agentId: string): Promise<Block> {
    const existing = await this.store.findLaunchBlock(agentId);
    if (existing) return existing;
    const streamId = await this.streamOf(agentId);
    const id = launchBlockId(agentId);
    const written = await this.store.insertIfAbsent({
      id,
      streamId,
      author: USER,
      toAgentId: agentId,
      kind: "launch",
      state: {},
      delivered: true,
      // Who launched it is the launch's to say (see `prepareLaunchContext`),
      // never read off the agent row, which a create request can fill in.
    });
    if (written) {
      await this.publishEntry(streamId, id);
      return written;
    }
    const raced = await this.store.getById(id);
    if (!raced) throw new StreamNotFoundError("Launch card not found.");
    return raced;
  }

  /**
   * Where an agent's own posts and turns go when nothing points them
   * elsewhere. A child's is its launch card's thread: the one entry for it
   * in its parent's stream holds its work, and the stream stays about the
   * parent's. An agent with a stream of its own posts in the stream.
   */
  private async homeOf(
    agentId: string
  ): Promise<{ threadId: string; replyTo: string } | null> {
    const streamId = await this.streamOf(agentId);
    if (streamId === agentId) return null;
    const card = await this.ensureLaunchBlock(agentId);
    return { threadId: card.id, replyTo: card.id };
  }

  /**
   * The block a reply to `block` lands under: `block` itself when it opens
   * a thread — it is top-level, or another block shows it (a finding in a
   * review) — and otherwise the thread `block` is already in.
   */
  private async threadHostFor(block: Block): Promise<string> {
    if (!block.threadId) return block.id;
    const container = await this.store.getById(block.threadId);
    return container && shownIdsOf(container).includes(block.id)
      ? block.id
      : block.threadId;
  }

  /** Whether another block shows `block`, rather than listing it as a reply. */
  private async isShown(block: Block): Promise<boolean> {
    return (await this.threadHostFor(block)) === block.id && !!block.threadId;
  }

  // -------------------------------------------------------------------------
  // People (HTTP)
  // -------------------------------------------------------------------------

  /**
   * A person's post: to the stream's agent by default, or a reply in a
   * thread. Persisted first, then delivered to the recipient as a prompt.
   * The pending row is on the wire before delivery can settle it.
   */
  async sendUserPost(
    streamId: string,
    input: {
      id?: string;
      to?: string | null;
      text: string;
      replyTo?: string | null;
      attachments?: ChatUserAttachmentInput[];
      /** A review left by hand: the block is a `review` with these findings. */
      review?: BlockReviewInput | null;
      allowInert?: boolean;
      /** Cut the recipient's running turn so this lands next, not after it. */
      interrupt?: boolean;
    }
  ): Promise<StreamPostResponse> {
    const attachments = input.attachments ?? [];
    const text = requireText(input.text);
    const review = input.review
      ? (resolveKindAndData({ review: input.review }).data as BlockReviewInput)
      : null;
    if (!text.trim() && attachments.length === 0 && !review) {
      throw new StreamValidationError("text is required.");
    }
    if (attachments.length > BLOCK_ATTACHMENTS_MAX) {
      throw new StreamValidationError(
        `attachments must have ${BLOCK_ATTACHMENTS_MAX} entries or fewer.`
      );
    }
    if (review) {
      const toAgentId = input.to ?? streamId;
      await this.requireAgent(toAgentId);
      const created = await this.createReview({
        ...(input.id ? { id: input.id } : {}),
        streamId,
        author: USER,
        toAgentId,
        text,
        review,
        host: null,
        live: await this.canDeliver(toAgentId, input.allowInert ?? true),
      });
      const held =
        created.delivered === null
          ? (await this.deliverBlock(created, { kind: "user" })).held
          : false;
      return { block: created, delivered: created.delivered, held };
    }
    let thread = await this.resolveThread(streamId, input.replyTo ?? null);
    // `@name` in the text names the recipients, in the stream's tree; it
    // wins over the page's default. Otherwise a reply in a thread goes to
    // the agents on its sides, and a top-level post to the stream's agent
    // unless addressed elsewhere.
    const tree = await this.treeAgents(streamId);
    const mentioned = findMentions(text, tree);
    const sides =
      mentioned.length === 0 && !input.to && thread
        ? await this.threadRecipients(thread, USER)
        : [];
    const recipients =
      mentioned.length > 0
        ? mentioned
        : sides.length > 0
          ? sides
          : [input.to ?? streamId];
    const toAgentId = recipients[0]!;
    // ACP commands must be the entire prompt's first token. A normal post's
    // DISPATCH POST envelope would hide the slash from the adapter, so an
    // advertised command goes alone and reaches it as raw text. Keep the
    // stored block: the command and its result still belong to one turn.
    const commandName = /^\/([^\s/]+)(?:\s|$)/.exec(text)?.[1];
    const rawCommand =
      !!commandName &&
      !review &&
      // Only an explicit reply is a conversation. A child's default home
      // is its launch-card thread, but a command typed in its composer is
      // still a standalone ACP prompt.
      !thread &&
      attachments.length === 0 &&
      mentioned.length === 0 &&
      recipients.length === 1 &&
      (this.delivery().commands?.(toAgentId) ?? []).includes(commandName);
    // A message for one child, written anywhere but a thread, goes to the
    // child's own thread: its card is where its conversation is.
    if (!thread && recipients.length === 1) {
      thread = await this.homeOf(toAgentId);
    }
    const recipientAgents = await Promise.all(
      recipients.map((id) => this.requireAgent(id))
    );
    const recipient = recipientAgents[0]!;
    let resolved: ChatAttachment[] = [];
    if (attachments.length > 0) {
      resolved = await this.resolveAttachmentsFor(recipient, attachments);
    }
    const linesFor = new Map(
      recipientAgents.map((agent) => [
        agent.id,
        resolved.length > 0 ? this.describeAttachments(agent, resolved) : [],
      ])
    );
    const liveFor = new Map(
      await Promise.all(
        recipients.map(
          async (id) =>
            [id, await this.canDeliver(id, input.allowInert ?? true)] as const
        )
      )
    );
    const liveRecipients = recipients.filter((id) => liveFor.get(id));
    const live = liveRecipients.length === recipients.length;
    const textData = {
      ...(rawCommand ? { acpCommand: true as const } : {}),
      ...(mentioned.length > 0 ? { mentions: mentioned } : {}),
      ...(mentioned.length === 0 && recipients.length > 1
        ? { recipients }
        : {}),
    };
    const row = {
      streamId,
      author: USER,
      toAgentId,
      kind: "text" as const,
      threadId: thread?.threadId ?? null,
      replyTo: thread?.replyTo ?? null,
      text,
      ...(Object.keys(textData).length > 0 ? { data: textData } : {}),
      attachments: resolved,
      delivered: live ? null : false,
    };
    const block = input.id
      ? await this.store.insertIfAbsent({ id: input.id, ...row })
      : await this.store.insert(row);
    if (!block) {
      throw new StreamConflictError("A block with that id already exists.");
    }
    await this.publishEntry(streamId, block.id);
    if (!live) return { block, delivered: false, held: false };
    // Cut each recipient's turn first, so the prompt this sends is what the
    // agent reads next instead of queueing behind work the user is trying
    // to redirect. The turn settles as `interrupted`.
    if (input.interrupt) {
      const delivery = this.delivery();
      await Promise.all(
        recipients.map((id) =>
          delivery.cancel(id).catch((error: unknown) => {
            this.log.warn(
              { err: error, agentId: id, blockId: block.id },
              "stream: could not cut the turn for an interrupting post"
            );
          })
        )
      );
    }
    const nameOf = new Map(recipientAgents.map((a) => [a.id, a.name]));
    const { held } = await this.deliverBlockTo(
      block,
      recipients,
      { kind: "user" },
      (agentId) => ({
        ...(rawCommand ? { rawPrompt: text, alone: true } : {}),
        attachmentLines: linesFor.get(agentId) ?? [],
        mention:
          mentioned.length > 0
            ? {
                alsoTo: recipients
                  .filter((id) => id !== agentId)
                  .map((id) => nameOf.get(id) ?? id),
              }
            : null,
        ...(input.interrupt ? { alone: true } : {}),
      })
    );
    return { block, delivered: null, held };
  }

  /**
   * Start an agent turn from a UI action without writing a prompt post into
   * the stream. The agent receives the instructions; the turn records a short
   * description of what started it.
   */
  async promptAgent(
    agentId: string,
    input: { text: string; description: string }
  ): Promise<{ held: boolean }> {
    await this.requireAgent(agentId);
    await this.canDeliver(agentId, false);
    return this.injectDetached({
      agentId,
      envelope: input.text,
      record: async () => undefined,
      logContext: { agentId, reason: "dispatch-prompt" },
      source: { source: "system", text: input.description },
    });
  }

  /**
   * A review and its findings, written together: the review, then a
   * finding block for each item in the review's thread, which the review
   * shows. `host` is the card the review goes on — a child's review lands
   * on its launch card, which shows it in turn — or null for a review in
   * the stream. The review comes back with its findings attached, ready to
   * deliver.
   */
  private async createReview(input: {
    /** Client-minted, for a person's review; the store mints one otherwise. */
    id?: string;
    streamId: string;
    author: BlockAuthor;
    toAgentId: string | null;
    text: string;
    review: BlockReviewInput;
    host: { threadId: string; replyTo: string } | null;
    live: boolean;
    attachments?: ChatAttachment[];
  }): Promise<Block> {
    const client = await this.deps.pool.connect();
    let review: Block;
    const findings: Block[] = [];
    try {
      await client.query("BEGIN");
      const tx = this.store.withClient(client);
      review = await tx.insert({
        ...(input.id ? { id: input.id } : {}),
        streamId: input.streamId,
        author: input.author,
        toAgentId: input.toAgentId,
        kind: "review",
        threadId: input.host?.threadId ?? null,
        replyTo: input.host?.replyTo ?? null,
        text: input.text,
        data: { summary: input.review.summary },
        state: { blocks: [] },
        attachments: input.attachments ?? [],
        delivered: input.toAgentId ? (input.live ? null : false) : null,
      });
      const at = new Date().toISOString();
      for (const finding of input.review.findings) {
        findings.push(
          await tx.insert({
            streamId: input.streamId,
            author: input.author,
            // The finding is for the same agent the review is: it is that
            // agent's to answer, and the review's delivery carries it.
            toAgentId: input.toAgentId,
            kind: "finding",
            threadId: review.id,
            replyTo: review.id,
            data: finding,
            state: { status: "open", by: input.author, at },
            delivered: input.toAgentId ? true : null,
          })
        );
      }
      review =
        (await tx.update(review.id, {
          state: { blocks: findings.map((f) => f.id) },
        })) ?? review;
      if (input.host) await tx.appendShown(input.host.threadId, review.id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await this.publishEntry(input.streamId, review.id);
    return { ...review, blocks: findings };
  }

  /**
   * Answer an agent question. The stored question decides what `value`
   * means: an option's label is the reply text, and a client label only
   * matters for a freeform answer. The reply block and the answer land in
   * one transaction, so racing answers leave exactly one reply.
   */
  async answerQuestion(
    streamId: string,
    blockId: string,
    input: AnswerInput
  ): Promise<StreamAnswerResponse> {
    if (!isBlockId(blockId)) {
      throw new StreamValidationError("blockId must be a UUID.");
    }
    if (!input.value.trim()) {
      throw new StreamValidationError("value is required.");
    }
    const attachments = input.attachments ?? [];
    if (attachments.length > BLOCK_ATTACHMENTS_MAX) {
      throw new StreamValidationError(
        `attachments must have ${BLOCK_ATTACHMENTS_MAX} entries or fewer.`
      );
    }
    const question = await this.store.getById(blockId);
    if (
      !question ||
      question.streamId !== streamId ||
      question.author.kind !== "agent" ||
      question.kind !== "question"
    ) {
      throw new StreamNotFoundError("Question not found.");
    }
    if (question.state?.answer) {
      throw new StreamConflictError("Question already answered.");
    }
    if (question.state?.cancellation) {
      throw new StreamConflictError("Question was canceled.");
    }
    const { value } = input;
    const options = question.data.options;
    const option = options.find((o) => (o.value ?? o.label) === value);
    let label: string | undefined;
    if (option) {
      label = option.label;
    } else if (question.data.allowFreeform) {
      const supplied = input.label?.trim() ?? "";
      label = supplied ? supplied.slice(0, ANSWER_LABEL_MAX) : undefined;
    } else {
      throw new StreamValidationError(
        "value does not match one of the question's options."
      );
    }
    const text = requireText(option ? option.label : value);
    const toAgentId = question.author.agentId;
    const recipient = await this.requireAgent(toAgentId);
    let resolved: ChatAttachment[] = [];
    let attachmentLines: string[] = [];
    if (attachments.length > 0) {
      resolved = await this.resolveAttachmentsFor(recipient, attachments);
      attachmentLines = this.describeAttachments(recipient, resolved);
    }
    const live = await this.canDeliver(toAgentId, true);

    const client = await this.deps.pool.connect();
    let reply: Block;
    let answered: Block | null;
    try {
      await client.query("BEGIN");
      const tx = this.store.withClient(client);
      const replyRow = {
        streamId,
        author: USER,
        toAgentId,
        kind: "text" as const,
        threadId: question.threadId ?? question.id,
        replyTo: question.id,
        text,
        attachments: resolved,
        delivered: live ? null : false,
      };
      const inserted = input.id
        ? await tx.insertIfAbsent({ id: input.id, ...replyRow })
        : await tx.insert(replyRow);
      if (!inserted) {
        await client.query("ROLLBACK");
        throw new StreamConflictError("A block with that id already exists.");
      }
      reply = inserted;
      answered = await tx.recordAnswer(question.id, {
        value,
        ...(label !== undefined ? { label } : {}),
        by: USER,
        blockId: reply.id,
        at: new Date().toISOString(),
      });
      if (!answered) {
        await client.query("ROLLBACK");
        throw new StreamConflictError("Question already answered.");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await this.publishEntry(streamId, answered.id);
    await this.publishEntry(streamId, reply.id);
    if (live) {
      await this.deliverBlock(reply, { kind: "user" }, attachmentLines, {
        answers: { blockId: question.id, kind: "question" },
      });
    }
    return { block: answered, reply, delivered: live ? null : false };
  }

  /** Submit a form: the values land on the form's state and reach its author. */
  async submitForm(
    streamId: string,
    blockId: string,
    input: { id?: string; values: Record<string, string | number | boolean> }
  ): Promise<StreamAnswerResponse> {
    const form = await this.store.getById(blockId);
    if (
      !form ||
      form.streamId !== streamId ||
      form.author.kind !== "agent" ||
      form.kind !== "form"
    ) {
      throw new StreamNotFoundError("Form not found.");
    }
    if (form.state?.submission) {
      throw new StreamConflictError("Form already submitted.");
    }
    if (form.state?.cancellation) {
      throw new StreamConflictError("Form was canceled.");
    }
    const values: Record<string, string | number | boolean> = {};
    for (const field of form.data.fields) {
      const value = input.values[field.id];
      if (value === undefined || value === "") {
        if (field.required) {
          throw new StreamValidationError(`"${field.label}" is required.`);
        }
        continue;
      }
      values[field.id] = value;
    }
    const toAgentId = form.author.agentId;
    const live = await this.canDeliver(toAgentId, true);
    const text = form.data.fields
      .filter((f) => values[f.id] !== undefined)
      .map((f) => `${f.label}: ${String(values[f.id])}`)
      .join("\n");
    const client = await this.deps.pool.connect();
    let reply: Block;
    let submitted: Block | null;
    try {
      await client.query("BEGIN");
      const tx = this.store.withClient(client);
      const inserted = await tx.insertIfAbsent({
        id: input.id ?? randomUUID(),
        streamId,
        author: USER,
        toAgentId,
        kind: "text",
        threadId: form.threadId ?? form.id,
        replyTo: form.id,
        text,
        delivered: live ? null : false,
      });
      if (!inserted) {
        await client.query("ROLLBACK");
        throw new StreamConflictError("A block with that id already exists.");
      }
      reply = inserted;
      submitted = await tx.recordSubmission(form.id, {
        values,
        by: USER,
        blockId: reply.id,
        at: new Date().toISOString(),
      });
      if (!submitted) {
        await client.query("ROLLBACK");
        throw new StreamConflictError("Form already submitted.");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await this.publishEntry(streamId, submitted.id);
    await this.publishEntry(streamId, reply.id);
    if (live) {
      await this.deliverBlock(reply, { kind: "user" }, [], {
        answers: { blockId: form.id, kind: "form" },
      });
    }
    return { block: submitted, reply, delivered: live ? null : false };
  }

  /**
   * Pull back an open question or form: the author withdrawing its own
   * ask, or the user withdrawing one addressed to them. Distinct from
   * `answerQuestion`/`submitForm`/`closeOwnQuestion` — this settles the ask
   * with no answer, and leaves one thread note recording who did it and
   * why. Atomic with that note (one transaction), so a retry never leaves
   * a second note; atomic with the state write itself, so a cancel racing
   * an answer or submission (see `recordAnswer`/`recordSubmission`) leaves
   * exactly one winner.
   */
  private async cancelAsk(
    block: Block,
    rawCancellation: unknown,
    by: BlockAuthor
  ): Promise<Block> {
    if (block.kind !== "question" && block.kind !== "form") {
      throw new StreamValidationError(
        `A ${block.kind} block has nothing to cancel.`
      );
    }
    // question/form blocks are only ever agent-authored (see `post`), but
    // spelled out explicitly rather than leaned on: a user can never be
    // "the author" here.
    const isOwner = by.kind === "agent" && sameAuthor(block.author, by);
    const isAddresseeUser = by.kind === "user" && block.toAgentId === null;
    if (!isOwner && !isAddresseeUser) {
      throw new StreamForbiddenError(
        "Only the agent that posted this ask, or the user it was addressed to, may cancel it."
      );
    }
    const reason = parseCancelReason(rawCancellation);
    const already = block.state as {
      answer?: unknown;
      submission?: unknown;
      cancellation?: unknown;
    } | null;
    if (already?.cancellation) return block;
    if (already?.answer || already?.submission) {
      throw new StreamConflictError(
        block.kind === "question"
          ? "Question already answered."
          : "Form already submitted."
      );
    }

    // Whichever side isn't the one canceling hears about it, if it's an
    // agent: the asking agent when the user cancels, the addressee when
    // the author cancels its own ask of another agent. A question the
    // author closes toward the user needs no notification — the user just
    // reads the stream.
    let notifyAgentId: string | null = null;
    if (by.kind === "user") {
      if (block.author.kind === "agent") notifyAgentId = block.author.agentId;
    } else if (block.toAgentId && block.toAgentId !== by.agentId) {
      notifyAgentId = block.toAgentId;
    }
    // A recipient going offline must not prevent the authorized state change.
    const live = notifyAgentId
      ? await this.canDeliver(notifyAgentId, true).catch((error: unknown) => {
          this.log.warn(
            { err: error, agentId: notifyAgentId },
            "stream: cancellation recipient unavailable"
          );
          return false;
        })
      : false;

    const client = await this.deps.pool.connect();
    let canceled: Block | null;
    let note: Block | null = null;
    try {
      await client.query("BEGIN");
      const tx = this.store.withClient(client);
      canceled = await tx.recordCancellation(block.id, {
        by,
        at: new Date().toISOString(),
        ...(reason ? { reason } : {}),
      });
      if (canceled) {
        note = await tx.insert({
          streamId: block.streamId,
          author: by,
          toAgentId: notifyAgentId,
          kind: "text",
          threadId: block.threadId ?? block.id,
          replyTo: block.id,
          text: reason ? `Canceled: ${reason}` : "Canceled.",
          delivered: notifyAgentId ? (live ? null : false) : null,
        });
      }
      await client.query(canceled ? "COMMIT" : "ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!canceled) {
      // Lost a race between the precheck above and the atomic write: an
      // answer, submission or another cancel landed first. Resolve it the
      // same way the precheck would have.
      const fresh = await this.store.getById(block.id);
      if (!fresh) throw new StreamNotFoundError("Block not found.");
      const state = fresh.state as {
        answer?: unknown;
        submission?: unknown;
        cancellation?: unknown;
      } | null;
      if (state?.cancellation) return fresh;
      throw new StreamConflictError(
        fresh.kind === "question"
          ? "Question already answered."
          : "Form already submitted."
      );
    }
    await this.publishEntry(canceled.streamId, canceled.id);
    if (note) await this.publishEntry(canceled.streamId, note.id);
    if (notifyAgentId && live && note) {
      const from = await this.senderOf(by);
      await this.deliverBlock(note, from, [], {
        answers: { blockId: canceled.id, kind: canceled.kind },
      });
    }
    return canceled;
  }

  /**
   * Change a block's state: a finding resolved, a task ticked. The author
   * and the recipient may; people always may. The other side is told when
   * someone changed it.
   */
  async setState(
    streamId: string,
    blockId: string,
    patch: Record<string, unknown>,
    by: BlockAuthor
  ): Promise<Block> {
    const block = await this.store.getById(blockId);
    if (!block || block.streamId !== streamId) {
      throw new StreamNotFoundError("Block not found.");
    }
    // A question/form's `cancellation` follows its own authorization (the
    // author, or the user it was addressed to) and its own atomic path —
    // narrower than, and distinct from, the review/tasks state below.
    if (
      (block.kind === "question" || block.kind === "form") &&
      patch &&
      typeof patch === "object" &&
      "cancellation" in patch
    ) {
      return this.cancelAsk(block, patch.cancellation, by);
    }
    if (
      by.kind === "agent" &&
      !sameAuthor(block.author, by) &&
      block.toAgentId !== by.agentId
    ) {
      throw new StreamForbiddenError(
        "Only the block's author or the agent it is addressed to may change its state."
      );
    }
    if (block.kind !== "finding" && block.kind !== "tasks") {
      throw new StreamValidationError(
        `A ${block.kind} block has no state to change this way.`
      );
    }
    const kind = block.kind;
    const stamped = stampState(kind, patch, by);
    const updated =
      kind === "finding"
        ? await this.store.update(block.id, { state: stamped })
        : await this.store.mergeState(block.id, stamped);
    if (!updated) throw new StreamNotFoundError("Block not found.");
    await this.publishEntry(streamId, updated.id);
    // The two sides of the block hear about a change the other made: the
    // author (a reviewer) when a person resolves or reopens a finding, the
    // recipient (the one whose work it is) when the author does.
    const sides = new Set(sidesOf(updated));
    if (by.kind === "agent") sides.delete(by.agentId);
    // A finding settled by its reviewer asks nothing of the agent whose
    // work it is: only a reopen gives that agent something to do.
    if (
      updated.kind === "finding" &&
      updated.state.status === "resolved" &&
      updated.toAgentId &&
      sameAuthor(updated.author, by)
    ) {
      sides.delete(updated.toAgentId);
    }
    const summary = describeStateChange(updated, stamped);
    const from = await this.senderOf(by);
    for (const agentId of sides) {
      if (!(await this.canDeliver(agentId, true))) continue;
      const hint =
        updated.kind === "finding"
          ? findingMoveHint(
              updated,
              updated.author.kind === "agent" &&
                updated.author.agentId === agentId
                ? "author"
                : "addressee"
            )
          : null;
      // The change is about the block, so the answer belongs in its thread
      // when it opens one (a finding), and in the thread it is in otherwise.
      const answerIn = (await this.isShown(updated))
        ? updated.id
        : (updated.threadId ?? null);
      this.injectDetached({
        agentId,
        envelope: buildPostEnvelope({
          blockId: updated.id,
          from,
          text: hint ? `${summary}\n${hint}` : summary,
          threadId: answerIn,
        }),
        record: async () => undefined,
        logContext: { blockId: updated.id, side: agentId },
        source: {
          source: "chat",
          chatMessageId: updated.id,
          ...(answerIn ? { answerIn } : {}),
        },
      });
    }
    return updated;
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  async addReaction(
    streamId: string,
    blockId: string,
    rawEmoji: unknown,
    author: BlockAuthor = USER
  ): Promise<StreamReactionResponse> {
    const { block, emoji } = await this.reactionTarget(
      streamId,
      blockId,
      rawEmoji,
      author
    );
    const existing = await this.store.listReactions(block.id);
    if (
      existing.some(
        (reaction) =>
          sameAuthor(reaction.author, author) && reaction.emoji === emoji
      )
    ) {
      return { blockId: block.id, reactions: existing };
    }
    if (existing.length >= BLOCK_REACTIONS_MAX) {
      throw new StreamValidationError(
        `A block can carry ${BLOCK_REACTIONS_MAX} reactions at most.`
      );
    }
    // A person's reaction reaches the agent that wrote the block.
    const recipient =
      author.kind === "user" && block.author.kind === "agent"
        ? block.author.agentId
        : null;
    const live = recipient ? await this.canDeliver(recipient, true) : false;
    const reaction = await this.store.insertReaction({
      streamId,
      blockId: block.id,
      author,
      emoji,
      delivered: recipient ? (live ? null : false) : null,
    });
    if (reaction) {
      await this.publishEntry(streamId, block.id);
      if (recipient && live) {
        const postsSince = await this.store.countLaterPostsBySameAuthor(
          block.id
        );
        this.injectDetached({
          agentId: recipient,
          envelope: buildReactionEnvelope({
            blockId: block.id,
            emoji,
            kind: block.kind,
            text: block.text,
            postsSince,
          }),
          record: async (delivered) => {
            await this.store.setReactionDelivered(reaction.id, delivered);
            await this.publishEntry(streamId, block.id);
          },
          logContext: { blockId: block.id, reactionId: reaction.id },
        });
      }
    }
    return {
      blockId: block.id,
      reactions: await this.store.listReactions(block.id),
    };
  }

  async removeReaction(
    streamId: string,
    blockId: string,
    rawEmoji: unknown,
    author: BlockAuthor = USER
  ): Promise<StreamReactionResponse> {
    const { block, emoji } = await this.reactionTarget(
      streamId,
      blockId,
      rawEmoji,
      author
    );
    if (await this.store.deleteReaction(block.id, author, emoji)) {
      await this.publishEntry(streamId, block.id);
    }
    return {
      blockId: block.id,
      reactions: await this.store.listReactions(block.id),
    };
  }

  private async reactionTarget(
    streamId: string,
    blockId: string,
    rawEmoji: unknown,
    author: BlockAuthor
  ): Promise<{ block: Block; emoji: string }> {
    if (!isBlockId(blockId)) {
      throw new StreamValidationError(
        author.kind === "agent"
          ? "id must be the block id from a DISPATCH POST envelope."
          : "blockId must be a UUID."
      );
    }
    const emoji = normalizeReactionEmoji(rawEmoji);
    if (emoji === null) {
      throw new StreamValidationError(
        "emoji must be a single emoji, such as 👍."
      );
    }
    const block = await this.store.getById(blockId);
    if (
      !block ||
      block.streamId !== streamId ||
      sameAuthor(block.author, author)
    ) {
      throw new StreamNotFoundError(
        author.kind === "agent"
          ? "Block not found — you can react to other people's and agents' blocks on your stream, by the id from their DISPATCH POST envelope."
          : "Block not found."
      );
    }
    return { block, emoji };
  }

  // -------------------------------------------------------------------------
  // Agents (MCP)
  // -------------------------------------------------------------------------

  /** An agent's `post`. */
  async post(agentId: string, input: PostInput): Promise<Block> {
    const author: BlockAuthor = { kind: "agent", agentId };
    const agent = await this.requireAgent(agentId);
    const streamId = await this.streamOf(agentId);
    const resolved = resolveKindAndData(input);
    const kind = resolved.kind;
    const data = resolved.data;
    const text = requireText(input.text);
    const attachmentInputs = input.attachments ?? [];
    if (attachmentInputs.length > BLOCK_ATTACHMENTS_MAX) {
      throw new StreamValidationError(
        `attachments must have ${BLOCK_ATTACHMENTS_MAX} entries or fewer.`
      );
    }
    if (!text.trim() && data === null && attachmentInputs.length === 0) {
      throw new StreamValidationError(
        "A post needs text, an attachment, or one of question, form, link, review or tasks."
      );
    }
    const replyTo = input.replyTo ?? null;
    let toAgentId = input.to ?? null;
    if (toAgentId === agentId) {
      throw new StreamValidationError("to must name another agent.");
    }
    if (toAgentId !== null) await this.requireAgent(toAgentId);
    const home = await this.homeOf(agentId);
    const attachments = await this.resolveAgentAttachments(
      agent,
      attachmentInputs
    );
    const from: EnvelopeSender = { kind: "agent", agentId, name: agent.name };
    const attachmentLines = this.describeAttachments(agent, attachments);
    if (kind === "review") {
      // A review is its own record, not a reply: a child's goes on its
      // launch card, which shows it; anyone else's goes in the stream.
      const review = await this.createReview({
        streamId,
        author,
        toAgentId,
        text,
        review: data as BlockReviewInput,
        host: home,
        live: toAgentId ? await this.canDeliver(toAgentId, true) : false,
        attachments,
      });
      if (toAgentId && review.delivered === null) {
        await this.deliverBlock(review, from, attachmentLines);
      }
      return review;
    }
    // Named with replyTo, the post goes in that thread; otherwise in the
    // agent's own place — a child's launch thread, the stream for anyone
    // else. Only a reply named on purpose is routed to the thread's other
    // side: a post in the agent's own place is for whoever it names.
    const thread = replyTo ? await this.resolveThread(streamId, replyTo) : home;
    const sides =
      toAgentId === null && replyTo && thread
        ? await this.threadRecipients(thread, author)
        : [];
    if (toAgentId === null && sides.length > 0) toAgentId = sides[0]!;
    const recipients =
      kind === "text" && input.to == null && sides.length > 1
        ? sides
        : toAgentId
          ? [toAgentId]
          : [];
    const liveAll = await Promise.all(
      recipients.map((id) => this.canDeliver(id, true))
    );
    const live = recipients.length > 0 && liveAll.every(Boolean);
    const insert: Parameters<BlockStore["insert"]>[0] = {
      streamId,
      author,
      toAgentId,
      kind,
      threadId: thread?.threadId ?? null,
      replyTo: thread?.replyTo ?? null,
      text,
      data:
        recipients.length > 1
          ? { ...((data as object) ?? {}), recipients }
          : data,
      state: initialState(kind, data),
      attachments,
      delivered: toAgentId ? (live ? null : false) : null,
    };
    // A reply to an open question addressed to this agent closes that
    // question. The reply and answer must commit together: a cancellation
    // that wins the race must not leave a visible or delivered answer reply.
    const target =
      kind === "text" && replyTo && thread && text.trim()
        ? await this.store.getById(thread.replyTo)
        : null;
    const answering =
      target?.kind === "question" &&
      target.toAgentId === agentId &&
      !target.state?.answer &&
      !target.state?.cancellation;
    let block: Block;
    let answered: Block | null = null;
    if (answering && target) {
      const client = await this.deps.pool.connect();
      try {
        await client.query("BEGIN");
        const tx = this.store.withClient(client);
        block = await tx.insert(insert);
        const option = target.data.options.find(
          (o) =>
            o.label.trim() === text.trim() ||
            (o.value ?? o.label) === text.trim()
        );
        answered = await tx.recordAnswer(target.id, {
          value: option ? (option.value ?? option.label) : text.trim(),
          ...(option ? { label: option.label } : {}),
          by: author,
          blockId: block.id,
          at: new Date().toISOString(),
        });
        if (!answered) {
          throw new StreamConflictError(
            "Question was already answered or canceled."
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } else {
      block = await this.store.insert(insert);
    }
    await this.publishEntry(streamId, block.id);
    if (answered) await this.publishEntry(answered.streamId, answered.id);
    if (live) {
      await this.deliverBlockTo(block, recipients, from, () => ({
        attachmentLines,
        answers: answered ? { blockId: answered.id, kind: "question" } : null,
      }));
    }
    if (
      toAgentId === null &&
      (kind === "question" || kind === "form") &&
      this.deps.onInputPosted
    ) {
      await this.deps
        .onInputPosted(agentId, text || describeInput(block))
        .catch((error: unknown) => {
          this.log.warn(
            { err: error, agentId },
            "stream: failed to mark the agent waiting"
          );
        });
    }
    if (input.notify && this.deps.notify) {
      await this.deps
        .notify(agentId, { message: text || describeInput(block) })
        .catch((error: unknown) => {
          this.log.warn({ err: error, agentId }, "stream: notification failed");
        });
    }
    return block;
  }

  /** An agent's `update`: its own block's text, data, attachments or state; a block addressed to it, state only. */
  async update(
    agentId: string,
    blockId: string,
    input: UpdateInput
  ): Promise<Block> {
    const author: BlockAuthor = { kind: "agent", agentId };
    if (!isBlockId(blockId)) {
      throw new StreamValidationError("id must be the id returned by post.");
    }
    const block = await this.store.getById(blockId);
    if (!block) throw new StreamNotFoundError("Block not found.");
    const own = sameAuthor(block.author, author);
    if (!own && block.toAgentId !== agentId) {
      throw new StreamForbiddenError(
        "Only your own blocks, or the state of a block addressed to you, can be updated."
      );
    }
    if (!own) {
      if (
        input.text !== undefined ||
        input.data !== undefined ||
        input.attachments !== undefined
      ) {
        throw new StreamForbiddenError(
          "Only the state of a block addressed to you can be changed."
        );
      }
      if (!input.state) throw new StreamValidationError("state is required.");
      return this.setState(block.streamId, block.id, input.state, author);
    }
    if (
      (block.kind === "question" || block.kind === "form") &&
      input.state &&
      "cancellation" in input.state
    ) {
      if (
        input.text !== undefined ||
        input.data !== undefined ||
        input.attachments !== undefined ||
        Object.keys(input.state).length !== 1
      ) {
        throw new StreamValidationError(
          "state.cancellation must be updated on its own."
        );
      }
      return this.cancelAsk(block, input.state.cancellation, author);
    }
    const patch: UpdateBlockInput = {};
    if (input.text !== undefined) patch.text = requireText(input.text);
    if (input.data !== undefined)
      patch.data = validUpdateData(block, input.data);
    if (input.attachments !== undefined) {
      const agent = await this.requireAgent(agentId);
      patch.attachments = await this.resolveAgentAttachments(
        agent,
        input.attachments
      );
    }
    let updated = await this.store.update(block.id, patch);
    if (!updated) throw new StreamNotFoundError("Block not found.");
    if (input.state) {
      if (block.kind === "finding" || block.kind === "tasks") {
        updated = await this.setState(
          block.streamId,
          block.id,
          input.state,
          author
        );
      } else if (block.kind === "question" && "answer" in input.state) {
        // The author closing its own question: it found the answer, or no
        // longer needs one. The word given becomes the answer on record.
        updated = await this.closeOwnQuestion(
          block,
          input.state.answer,
          author
        );
      } else if (block.kind === "review" || block.kind === "launch") {
        throw new StreamValidationError(
          block.kind === "review"
            ? "A review's state is its findings: update each finding by its own id."
            : "A launch card's state is written by Dispatch."
        );
      } else {
        updated =
          (await this.store.mergeState(block.id, input.state)) ?? updated;
      }
    }
    await this.publishEntry(updated.streamId, updated.id);
    return updated;
  }

  private async closeOwnQuestion(
    block: Block,
    answer: unknown,
    author: BlockAuthor
  ): Promise<Block> {
    if (block.kind !== "question") return block;
    if (block.state?.answer) {
      throw new StreamConflictError("Question already answered.");
    }
    if (block.state?.cancellation) {
      throw new StreamConflictError("Question was canceled.");
    }
    const raw =
      typeof answer === "string"
        ? answer
        : answer && typeof answer === "object"
          ? (answer as { value?: unknown }).value
          : undefined;
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      throw new StreamValidationError(
        "state.answer must be the answer as text (or { value }): what settled the question."
      );
    }
    const option = block.data.options.find(
      (o) => o.label.trim() === value || (o.value ?? o.label) === value
    );
    const closed = await this.store.recordAnswer(block.id, {
      value: option ? (option.value ?? option.label) : value,
      ...(option ? { label: option.label } : {}),
      by: author,
      at: new Date().toISOString(),
    });
    if (!closed) throw new StreamConflictError("Question already answered.");
    return closed;
  }

  // -------------------------------------------------------------------------
  // Launch block
  // -------------------------------------------------------------------------

  /**
   * Resolve a launch's context without writing it: the attachments and the
   * envelope lines that describe them, plus a `record` that performs the
   * write. A launch with no context at all resolves to null.
   */
  async prepareLaunchContext(
    input: LaunchContextInput
  ): Promise<PreparedLaunchContext | null> {
    const text = input.text ?? "";
    const links = (input.links ?? []).filter((url) => url.trim().length > 0);
    const files = input.files ?? [];
    if (!text.trim() && files.length === 0 && links.length === 0) {
      // Nothing to brief with, but the card still says who launched it:
      // its launcher is the other side of its thread.
      if (input.launchedByAgentId) {
        const card = await this.ensureLaunchBlock(input.agentId);
        const marked = await this.store.setLaunchedBy(
          card.id,
          input.launchedByAgentId
        );
        if (marked) await this.publishEntry(marked.streamId, marked.id);
      }
      return null;
    }
    const inputs: ChatUserAttachmentInput[] = [
      ...files.map((file) => ({
        type: "file" as const,
        fileId: file.fileId,
      })),
      ...links.map((url) => ({ type: "link" as const, url })),
    ];
    let attachments: ChatAttachment[] = [];
    let attachmentLines: string[] = [];
    if (inputs.length > 0) {
      const agent = await this.requireAgent(input.agentId);
      attachments = await this.resolveAttachmentsFor(agent, inputs);
      attachmentLines = this.describeAttachments(agent, attachments);
    }
    const stored =
      attachments.length > BLOCK_ATTACHMENTS_MAX
        ? attachments.slice(0, BLOCK_ATTACHMENTS_MAX)
        : attachments;
    const postText = buildLaunchPostText(
      text,
      attachments.length - stored.length
    );
    const streamId = await this.streamOf(input.agentId);
    const existing = await this.store.findLaunchBlock(input.agentId);
    const id = existing?.id ?? launchBlockId(input.agentId);
    return {
      id,
      attachmentLines,
      postText,
      record: async () => {
        const block = await this.store.writeLaunchBriefing({
          id,
          streamId,
          agentId: input.agentId,
          text: postText,
          attachments: stored,
          launchedByAgentId: input.launchedByAgentId ?? null,
        });
        await this.publishEntry(streamId, block.id);
        return block;
      },
    };
  }

  /**
   * The system prompt the agent was started with, kept on its launch card
   * so what it was told is always readable and always current: a restart
   * rewrites it rather than adding another. Never delivered: the engine
   * already has it as its system prompt.
   */
  async recordSystemPrompt(input: {
    agentId: string;
    prompt: string;
  }): Promise<Block | null> {
    const text = input.prompt.trim();
    if (!text) return null;
    const card = await this.ensureLaunchBlock(input.agentId);
    if (card.kind === "launch" && card.state?.instructions === text) {
      return card;
    }
    const updated = await this.store.setStateKey(card.id, "instructions", text);
    if (updated) await this.publishEntry(updated.streamId, updated.id);
    return updated;
  }

  /**
   * The workspace coming up, on the agent's launch card: rewritten as each
   * phase runs, so the person watches the worktree, the config, the
   * dependencies and the engine happen rather than waiting at an empty
   * stream.
   */
  async recordStartupStep(input: {
    agentId: string;
    phase: string;
    label: string;
    cwd?: string;
  }): Promise<Block | null> {
    const at = new Date().toISOString();
    return this.updateStartup(input.agentId, (startup) => {
      // Reaching a phase ends the one before it: the phases run in turn,
      // and nothing else reports when one finishes.
      const steps = startup.steps.map((step) =>
        step.status === "running"
          ? { ...step, status: "done" as const, endedAt: at }
          : step
      );
      if (steps.some((step) => step.phase === input.phase)) return null;
      steps.push({
        phase: input.phase,
        label: input.label,
        startedAt: at,
        status: "running",
      });
      return {
        ...startup,
        steps,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      };
    });
  }

  /** The workspace is up, or it failed: the card's startup stops at its last step. */
  async recordStartupDone(input: {
    agentId: string;
    error?: string;
    cwd?: string;
  }): Promise<Block | null> {
    const at = new Date().toISOString();
    return this.updateStartup(input.agentId, (startup) => {
      if (startup.steps.length === 0 && !input.error) return null;
      const steps = startup.steps.map((step) =>
        step.status === "running"
          ? {
              ...step,
              status: input.error ? ("failed" as const) : ("done" as const),
              endedAt: at,
              ...(input.error ? { detail: input.error } : {}),
            }
          : step
      );
      return {
        ...startup,
        steps,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.error ? { failed: input.error } : { readyAt: at }),
      };
    });
  }

  /**
   * Read the card's startup record, apply a change, and write it back. The
   * whole record is rewritten each time, which is safe because one launch
   * owns it and its phases run one after another.
   */
  private async updateStartup(
    agentId: string,
    change: (startup: BlockStartup) => BlockStartup | null
  ): Promise<Block | null> {
    const card = await this.ensureLaunchBlock(agentId);
    const current: BlockStartup =
      card.kind === "launch" && card.state?.startup
        ? card.state.startup
        : { steps: [] };
    const next = change(current);
    if (!next) return card;
    const updated = await this.store.setStateKey(card.id, "startup", next);
    if (updated) await this.publishEntry(updated.streamId, updated.id);
    return updated;
  }

  async recordLaunchContext(input: LaunchContextInput): Promise<Block | null> {
    const prepared = await this.prepareLaunchContext(input);
    return prepared ? prepared.record() : null;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  publishChanged(agentId: string): void {
    this.deps.publishUiEvent({ type: "stream.changed", agentId });
  }

  /**
   * The agent's newest turn as the feed row it now is. Never rejects. One
   * compose per agent at a time, with a single trailing re-run.
   */
  async publishTurnEntry(agentId: string): Promise<void> {
    if (this.deps.hasUiClient && !this.deps.hasUiClient()) return;
    const running = this.turnPublishes.get(agentId);
    if (running) {
      running.again = true;
      return running.done;
    }
    const state: TurnPublish = { done: Promise.resolve(), again: false };
    this.turnPublishes.set(agentId, state);
    state.done = (async () => {
      try {
        do {
          state.again = false;
          await this.composeTurnEntry(agentId);
        } while (state.again);
      } finally {
        this.turnPublishes.delete(agentId);
      }
    })();
    return state.done;
  }

  /** The agent's newest turn as its feed row, the one `publishTurnEntry` sends. */
  async turnEntry(agentId: string): Promise<StreamBlockEntry | null> {
    const blockId = await loadNewestTurnBlockId(this.store.db, agentId);
    if (!blockId) return null;
    const streamId = await this.streamOf(agentId);
    return loadBlockEntry(this.store.db, streamId, blockId, this.heldCheck());
  }

  private async composeTurnEntry(agentId: string): Promise<void> {
    try {
      const blockId = await loadNewestTurnBlockId(this.store.db, agentId);
      if (blockId) {
        const streamId = await this.streamOf(agentId);
        await this.publishBlockEntry(streamId, blockId);
      }
    } catch (error) {
      this.log.warn(
        { err: error, agentId },
        "stream: could not compose the turn for its feed event"
      );
    }
  }

  /**
   * This stream's feed, with each post's delivery state resolved against
   * what its recipients are doing right now.
   */
  async feed(
    streamId: string,
    opts: Omit<ComposeFeedOptions, "isHeld"> = {}
  ): Promise<StreamFeedResponse> {
    return composeStreamFeed(this.store, streamId, {
      ...opts,
      isHeld: this.heldCheck(),
    });
  }

  /**
   * Whether an agent is mid-turn, so a prompt waits behind it. Read from
   * the adapter rather than stored: it is true only for as long as the
   * turn runs. Nothing is held when there is no adapter to ask.
   */
  private heldCheck(): (agentId: string) => boolean {
    const delivery = this.deps.delivery;
    if (!delivery) return () => false;
    return (agentId) => {
      try {
        return delivery.held(agentId);
      } catch {
        return false;
      }
    };
  }

  /** One block (a turn's, with its turn attached) as a feed row event. */
  private async publishBlockEntry(
    streamId: string,
    blockId: string
  ): Promise<void> {
    const entry = await loadBlockEntry(
      this.store.db,
      streamId,
      blockId,
      this.heldCheck()
    );
    if (!entry) return;
    this.deps.publishUiEvent({
      type: "stream.entry",
      agentId: streamId,
      entry,
    });
  }

  /**
   * A turn opened: its block, by the agent, empty until the turn settles.
   * A turn that a reply in a thread opened answers in that thread; any
   * other turn answers in the agent's own place (a child's launch thread,
   * the stream for anyone else). The block's id goes back onto the turn row
   * so later events find it.
   */
  async recordTurnStarted(input: {
    agentId: string;
    turnRow: StreamEventRow;
    prompt: PromptSource;
  }): Promise<string | null> {
    const streamId = await this.streamOf(input.agentId);
    let thread: { threadId: string; replyTo: string } | null = null;
    if (input.prompt.source === "chat" && input.prompt.answerIn) {
      // The prompt said where its answer goes.
      const host = await this.store.getById(input.prompt.answerIn);
      if (host && host.streamId === streamId) {
        thread = { threadId: host.id, replyTo: host.id };
      }
    } else if (input.prompt.source === "chat") {
      // Posts delivered together each say where their answer belongs. The
      // turn answers in a thread only when every one of them points into
      // that same thread; any disagreement puts it in the agent's own
      // place, where an answer to a post in a thread is still seen and one
      // about a channel post is not buried in a thread.
      const ids = input.prompt.chatMessageIds ?? [input.prompt.chatMessageId];
      const places = await Promise.all(ids.map((id) => this.turnPlaceFor(id)));
      const [first] = places;
      if (first && places.every((p) => p?.threadId === first.threadId)) {
        thread = places[places.length - 1]!;
      }
    }
    thread ??= await this.homeOf(input.agentId);
    const block = await this.store.insert({
      streamId,
      author: { kind: "agent", agentId: input.agentId },
      kind: "text",
      origin: "turn",
      data: { turnEventId: input.turnRow.id },
      text: "",
      threadId: thread?.threadId ?? null,
      replyTo: thread?.replyTo ?? null,
    });
    return block.id;
  }

  /**
   * Where a turn a post opened belongs: that post's thread, or null for the
   * agent's own place. Answering a question or a form settles that ask and
   * nothing more, so the work it leads to belongs back in the agent's own
   * place where it can be seen; the answer itself stays threaded under the
   * question. A reply to anything else — a comment on a finding, an
   * ordinary post — is a discussion, and its turns belong in that thread.
   * A post that is not a reply (a review delivered to the agent whose work
   * it is) opens work, not a discussion.
   *
   * The test is what the reply answers, not what the thread is rooted at:
   * an agent's question is usually itself a reply inside some other thread,
   * so the root is rarely the question.
   */
  private async turnPlaceFor(blockId: string): Promise<{
    threadId: string;
    replyTo: string;
  } | null> {
    if (!isBlockId(blockId)) return null;
    const opener = await this.store.getById(blockId);
    // A block another shows (a review delivered to the agent whose work it
    // is) opens work, which belongs in the agent's own place. A prompt
    // about such a block that belongs under it says so (`answerIn`).
    if (!opener?.threadId || (await this.isShown(opener))) return null;
    const answered = opener.replyTo
      ? await this.store.getById(opener.replyTo)
      : null;
    if (answered?.kind === "question" || answered?.kind === "form") {
      return null;
    }
    return { threadId: opener.threadId, replyTo: opener.id };
  }

  /** A turn settled or was cut: its block takes the answer as its text. */
  async recordTurnSettled(input: {
    agentId: string;
    turnRow: StreamEventRow;
  }): Promise<void> {
    const blockId = input.turnRow.payload.blockId;
    if (typeof blockId !== "string") return;
    const turns = await loadTurnEntries(this.store.db, input.agentId, [
      input.turnRow.id,
    ]);
    const text = turns.get(input.turnRow.id)?.result?.text ?? "";
    await this.store.update(blockId, { text });
    const streamId = await this.streamOf(input.agentId);
    await this.publishBlockEntry(streamId, blockId);
    this.deps.publishUiEvent({ type: "stream.changed", agentId: streamId });
  }

  publishRead(
    agentId: string,
    read: { unreadCount: number; readAt: string; upToAt: string | null }
  ): void {
    this.deps.publishUiEvent({ type: "stream.read", agentId, ...read });
  }

  /**
   * Announce one block as the feed row it now is, read back through the
   * feed's own query. A thread reply is published as itself (the client
   * files it into the open thread) and then its root is published again,
   * since the root's reply count changed.
   */
  private async publishEntry(streamId: string, blockId: string): Promise<void> {
    let entry: StreamBlockEntry | null = null;
    try {
      entry = await loadBlockEntry(
        this.store.db,
        streamId,
        blockId,
        this.heldCheck()
      );
    } catch (error) {
      this.log.warn(
        { err: error, streamId, blockId },
        "stream: could not read a block back for its feed event"
      );
    }
    if (!entry) {
      this.publishChanged(streamId);
      return;
    }
    this.deps.publishUiEvent({
      type: "stream.entry",
      agentId: streamId,
      entry,
    });
    if (entry.block.threadId) {
      await this.publishEntry(streamId, entry.block.threadId);
    }
  }
  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  private async canDeliver(
    agentId: string,
    allowInert: boolean
  ): Promise<boolean> {
    const access = await this.delivery().access(agentId);
    if (access.mode === "live") return true;
    if (!allowInert) throw new StreamConflictError(access.message);
    return false;
  }

  private delivery(): StreamDeliveryAdapter {
    if (!this.deps.delivery) {
      throw new Error("StreamService: no delivery adapter configured.");
    }
    return this.deps.delivery;
  }

  private async senderOf(author: BlockAuthor): Promise<EnvelopeSender> {
    if (author.kind === "user") return { kind: "user" };
    const agent = await this.deps.getAgent(author.agentId);
    return {
      kind: "agent",
      agentId: author.agentId,
      name: agent?.name ?? author.agentId,
    };
  }

  /**
   * Queue the block as a prompt for its recipient and return at once. The
   * detached continuation records true/false on the row and publishes it
   * again; graceful shutdown waits (briefly) for it, and a restart sweeps
   * whatever it could not wait for to delivered=false.
   */
  private async deliverBlock(
    block: Block,
    from: EnvelopeSender,
    attachmentLines: string[] = [],
    extra: { answers?: { blockId: string; kind: BlockKind } | null } = {}
  ): Promise<{ held: boolean }> {
    const toAgentId = block.toAgentId;
    if (!toAgentId) return { held: false };
    return this.deliverBlockTo(block, [toAgentId], from, () => ({
      attachmentLines,
      answers: extra.answers ?? null,
    }));
  }

  /**
   * One block to one or more agents (a post with several `@mentions`):
   * each gets its own envelope; the block reads as delivered once every
   * delivery succeeded, and as held while any is waiting behind a turn.
   */
  private async deliverBlockTo(
    block: Block,
    recipients: readonly string[],
    from: EnvelopeSender,
    perRecipient: (agentId: string) => {
      attachmentLines?: string[];
      answers?: { blockId: string; kind: BlockKind } | null;
      mention?: { alsoTo: string[] } | null;
      /** Sent to cut in: its own turn, never combined with other posts. */
      alone?: boolean;
      /** ACP slash command, sent without the Dispatch envelope. */
      rawPrompt?: string;
    }
  ): Promise<{ held: boolean }> {
    const finding = await this.findingOf(block);
    const outcomes = new Map<string, boolean>();
    // A post to several agents keeps each outcome of its own, so one
    // recipient that never took it can be seen, and sent again, without
    // disturbing the ones that did. What decides this is who the post was
    // addressed to, not how many are being sent to now: a retry of one
    // copy must not overwrite the other recipients' results.
    const named = addressedTo(block);
    const perAgent = named.length > 1;
    let held = false;
    for (const agentId of recipients) {
      const own = perRecipient(agentId);
      const result = this.injectDetached({
        agentId,
        envelope:
          own.rawPrompt ??
          buildPostEnvelope({
            blockId: block.id,
            from,
            text: envelopeText(block),
            attachmentLines: own.attachmentLines ?? [],
            threadId: block.threadId,
            finding: finding
              ? {
                  id: finding.id,
                  title: finding.title,
                  opened: finding.authorAgentId === agentId,
                }
              : null,
            answers: own.answers ?? null,
            mention: own.mention ?? null,
          }),
        record: async (delivered) => {
          outcomes.set(agentId, delivered);
          if (perAgent) {
            await this.store.setRecipientDelivered(
              block.id,
              agentId,
              delivered
            );
          }
          if (outcomes.size < recipients.length) {
            // Say so as each one lands: a reader watching a post to three
            // agents sees it arrive three times, not once at the end.
            if (perAgent) await this.publishEntry(block.streamId, block.id);
            return;
          }
          if (perAgent) {
            await this.store.settleDelivered(block.id, named);
          } else {
            await this.store.setDelivered(
              block.id,
              [...outcomes.values()].every(Boolean)
            );
          }
          await this.publishEntry(block.streamId, block.id);
        },
        logContext: { blockId: block.id },
        ...(own.alone ? { alone: true } : {}),
      });
      held = held || result.held;
    }
    return { held };
  }

  /** The agents a person can name with `@` in this stream: its tree. */
  private async treeAgents(streamId: string): Promise<Mentionable[]> {
    const ids = await agentTree(this.deps.pool, streamId);
    const result = await this.deps.pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM agents WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [ids]
    );
    return result.rows;
  }

  private injectDetached(input: {
    agentId: string;
    envelope: string;
    record: (delivered: boolean) => Promise<void>;
    logContext: Record<string, string>;
    /** What the prompt is, for a prompt that is not a block being delivered. */
    source?: PromptSource;
    alone?: boolean;
  }): { held: boolean } {
    const { agentId, logContext } = input;
    const delivery = this.delivery();
    let accepted = false;
    const settlement = delivery
      .inject(agentId, input.envelope, {
        ...(input.source
          ? { source: input.source }
          : { blockId: input.logContext.blockId }),
        ...(input.alone ? { alone: true } : {}),
      })
      .then(
        () => true,
        (error: unknown) => {
          if (
            error instanceof Error &&
            error.name === "QueuedPromptDeletedError"
          )
            return null;
          this.log.warn(
            { err: error, agentId, ...logContext },
            "stream: delivery failed — agent may have exited"
          );
          return false;
        }
      )
      .then(async (delivered) => {
        accepted = true;
        if (delivered !== null) await input.record(delivered);
      })
      .catch((error: unknown) => {
        this.log.error(
          { err: error, agentId, ...logContext },
          "stream: failed to record delivery outcome"
        );
      });
    this.trackDelivery(settlement);
    this.giveUpIfUnwanted({
      agentId,
      taken: () => accepted,
      record: input.record,
      logContext,
    });
    return { held: delivery.held(agentId) };
  }

  /**
   * A prompt an engine never takes would otherwise sit unresolved for the
   * life of the process: the injection promise simply never settles, and a
   * person is left watching "Sending" with nothing scheduled to end it.
   * That is the engine having gone unresponsive — most likely right after
   * being interrupted — so the post is marked undelivered and the reader
   * gets the failed state they can retry from.
   *
   * Waiting behind a long turn is not that. While the agent is busy the
   * prompt is queued exactly as intended, however long that takes, so the
   * watch re-arms instead of failing it. The real outcome always wins: if
   * the engine takes the prompt later, that write lands after this one.
   */
  private giveUpIfUnwanted(input: {
    agentId: string;
    taken: () => boolean;
    record: (delivered: boolean) => Promise<void>;
    logContext: Record<string, string>;
  }): void {
    const { agentId, logContext } = input;
    const wait = () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DELIVERY_GIVE_UP_MS);
        // Never a reason to hold the process open.
        timer.unref?.();
      });
    void (async () => {
      for (;;) {
        await wait();
        if (input.taken()) return;
        // Still queued behind the agent's own work: that is the queue
        // doing its job, so keep waiting.
        if (this.delivery().activeTurn(agentId)) continue;
        this.log.warn(
          { agentId, ...logContext },
          "stream: the engine never took this prompt; marking it undelivered"
        );
        await input
          .record(false)
          .catch((error: unknown) =>
            this.log.error(
              { err: error, agentId, ...logContext },
              "stream: failed to record a given-up delivery"
            )
          );
        return;
      }
    })();
  }

  async recoverPendingDeliveries(): Promise<string[]> {
    const streamIds = [
      ...new Set([
        ...(await this.store.sweepPendingDeliveries()),
        ...(await this.store.sweepPendingReactions()),
      ]),
    ];
    for (const streamId of streamIds) this.publishChanged(streamId);
    return streamIds;
  }

  private trackDelivery(settlement: Promise<unknown>): void {
    this.inFlightDeliveries.add(settlement);
    void settlement.finally(() => {
      this.inFlightDeliveries.delete(settlement);
    });
  }

  get inFlightDeliveryCount(): number {
    return this.inFlightDeliveries.size;
  }

  async waitForInFlightDeliveries(timeoutMs: number): Promise<boolean> {
    if (this.inFlightDeliveries.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      const pending = Promise.allSettled([...this.inFlightDeliveries]).then(
        () => true as const
      );
      return await Promise.race([pending, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Threads, attachments
  // -------------------------------------------------------------------------

  /**
   * Where a reply lands: `replyTo` may name a block that opens a thread (a
   * top-level block, or one another block shows) or a reply inside one
   * (then the thread is that reply's). Must be on this stream.
   */
  private async resolveThread(
    streamId: string,
    replyTo: string | null
  ): Promise<{ threadId: string; replyTo: string } | null> {
    if (replyTo === null) return null;
    if (!isBlockId(replyTo)) {
      throw new StreamValidationError(
        "replyTo must be a block id from a DISPATCH POST envelope or a post result."
      );
    }
    const target = await this.store.getById(replyTo);
    if (!target || target.streamId !== streamId) {
      throw new StreamValidationError(
        "replyTo must name a block on this stream."
      );
    }
    return { threadId: await this.threadHostFor(target), replyTo: target.id };
  }

  /**
   * Send a post that never arrived to its agent again. The same block, not
   * a new one: the words keep their place in the stream and the row's
   * state goes back to pending.
   *
   * The envelope is rebuilt from what the block itself records rather than
   * from the send that first made it — who else it named, the files it
   * carries, the ask it answers. Each is derivable, and getting one wrong
   * is quiet (an answer that never says what it answers), so this is the
   * one place that knows how to reconstruct all of them.
   */
  async controlQueuedMessage(
    streamId: string,
    blockId: string,
    action: "delete" | "send-now"
  ): Promise<{ ok: true }> {
    const block = await this.store.getById(blockId);
    if (
      !block ||
      block.streamId !== streamId ||
      block.author.kind !== "user" ||
      !block.toAgentId ||
      block.origin
    ) {
      throw new StreamValidationError("Queued user message not found.");
    }
    if (
      block.delivered !== null ||
      !this.delivery().controlQueuedPrompt?.(
        addressedTo(block),
        blockId,
        action
      )
    ) {
      throw new StreamConflictError(
        "This message is no longer queued. Refresh and try again."
      );
    }
    if (action === "delete") await this.store.deleteQueuedMessage(blockId);
    this.publishChanged(streamId);
    if (block.threadId) await this.publishEntry(streamId, block.threadId);
    return { ok: true };
  }

  async retryDelivery(
    streamId: string,
    blockId: string
  ): Promise<{ block: Block; held: boolean }> {
    const block = await this.store.getById(blockId);
    if (!block || block.streamId !== streamId) {
      throw new StreamValidationError("Block not found.");
    }
    if (!block.toAgentId) {
      throw new StreamValidationError("That post was not addressed to anyone.");
    }
    if (block.delivered !== false) {
      throw new StreamConflictError(
        block.delivered === true
          ? "That post was already delivered."
          : "That post is still being delivered."
      );
    }
    const mentioned =
      block.kind === "text" ? (block.data?.mentions ?? []) : undefined;
    const named = addressedTo(block);
    // Only the agents that never took it. A post to three agents where one
    // engine died is sent again to that one alone; the other two have read
    // it, and a second copy would read as the person repeating themselves.
    const missed = (block.delivery ?? [])
      .filter((entry) => entry.state === "failed")
      .map((entry) => entry.agentId);
    const recipients = missed.length > 0 ? missed : named;
    // The first send persisted this intent. Retrying must not reclassify it
    // against the host's current command list: it may be unavailable while
    // the host reconnects, and wrapping the prompt would change its meaning.
    const rawCommand =
      block.kind === "text" &&
      block.author.kind === "user" &&
      block.data?.acpCommand === true &&
      block.attachments.length === 0 &&
      !mentioned?.length &&
      named.length === 1 &&
      recipients.length === 1;
    const agents = await Promise.all(named.map((id) => this.requireAgent(id)));
    // An agent that cannot take a prompt gets the reason now rather than a
    // second spinner: a retry is for a message that missed, not a way to
    // wake something that is not running.
    for (const id of recipients) await this.canDeliver(id, false);
    const lines = new Map(
      agents.map((agent) => [
        agent.id,
        block.attachments.length > 0
          ? this.describeAttachments(agent, block.attachments)
          : [],
      ])
    );
    // The ask this post answers, from the ask's own record of who answered
    // it — not from the fact that the post replies to a question, which a
    // plain comment in the same thread also does.
    const answered = block.replyTo
      ? await this.store.getById(block.replyTo)
      : null;
    let answers: { blockId: string; kind: BlockKind } | null = null;
    if (answered?.kind === "question") {
      if (answered.state?.answer?.blockId === block.id) {
        answers = { blockId: answered.id, kind: "question" };
      }
    } else if (answered?.kind === "form") {
      if (answered.state?.submission?.blockId === block.id) {
        answers = { blockId: answered.id, kind: "form" };
      }
    }
    const names = new Map(agents.map((agent) => [agent.id, agent.name]));
    const from = await this.senderOf(block.author);
    if (!(await this.store.markDelivering(block.id, recipients))) {
      throw new StreamValidationError("Block not found.");
    }
    const pending = { ...block, delivered: null };
    await this.publishEntry(streamId, block.id);
    const { held } = await this.deliverBlockTo(
      pending,
      recipients,
      from,
      (agentId) => ({
        ...(rawCommand ? { rawPrompt: block.text, alone: true } : {}),
        attachmentLines: lines.get(agentId) ?? [],
        answers,
        // "also to" names everyone the post was addressed to, not just the
        // ones being sent again: that is who is in the conversation.
        mention:
          mentioned && mentioned.length > 0
            ? {
                alsoTo: named
                  .filter((id) => id !== agentId)
                  .map((id) => names.get(id) ?? id),
              }
            : null,
      })
    );
    return { block: pending, held };
  }

  /**
   * Run a failed turn again: the agent's latest turn, failed on an error a
   * later attempt could clear. The turn's entry says "retried" at once; a
   * retry that never reaches the agent is offered again.
   */
  async retryTurn(streamId: string, blockId: string): Promise<void> {
    const block = await this.store.getById(blockId);
    const turnId = block ? turnAnchorOf(block) : null;
    if (
      !block ||
      block.streamId !== streamId ||
      turnId === null ||
      block.author.kind !== "agent"
    ) {
      throw new StreamValidationError("Turn not found.");
    }
    const agentId = block.author.agentId;
    if ((await loadNewestTurnBlockId(this.store.db, agentId)) !== blockId) {
      throw new StreamConflictError(
        "The agent has had a turn since; only its latest turn can be retried."
      );
    }
    await this.canDeliver(agentId, false);
    const taken = await this.turns.takeRetry(agentId, turnId);
    if (!taken) {
      throw new StreamConflictError("That turn can't be retried.");
    }
    const error = (taken.payload as TurnPayload).error ?? "";
    await this.publishBlockEntry(streamId, blockId);
    this.injectDetached({
      agentId,
      envelope: buildRetryTurnEnvelope(error),
      record: async (delivered) => {
        if (delivered) return;
        await this.turns.reopenRetry(agentId, turnId);
        await this.publishBlockEntry(streamId, blockId);
      },
      logContext: { blockId, reason: "retry-turn" },
      // Not the failed turn's block being delivered: a prompt of
      // Dispatch's own, which the feed shows as the notice above the
      // turn it opens.
      source: { source: "system", text: RETRY_TURN_NOTICE },
    });
  }

  /**
   * The finding a post is about, for its envelope: the one whose thread it
   * is in. Null for a post anywhere else.
   */
  private async findingOf(block: Block): Promise<{
    id: string;
    title: string;
    authorAgentId: string | null;
  } | null> {
    if (!block.threadId) return null;
    const host = await this.store.getById(block.threadId);
    if (host?.kind !== "finding") return null;
    return {
      id: host.id,
      title: host.data.title,
      authorAgentId: host.author.kind === "agent" ? host.author.agentId : null,
    };
  }

  private async requireAgent(agentId: string): Promise<StreamAgent> {
    const agent = await this.deps.getAgent(agentId);
    if (!agent) throw new StreamValidationError(`Agent ${agentId} not found.`);
    return agent;
  }

  /** Attachments as an agent gives them: a `path` is uploaded first. */
  private async resolveAgentAttachments(
    agent: StreamAgent,
    inputs: BlockAttachmentInput[]
  ): Promise<ChatAttachment[]> {
    const out: ChatAttachment[] = [];
    for (const input of inputs) {
      if (input.type === "file" && input.path) {
        if (!this.deps.uploadFile) {
          throw new StreamValidationError(
            "File uploads are not available here."
          );
        }
        const uploaded = await this.deps.uploadFile(agent.id, {
          filePath: input.path,
          description: input.description ?? path.basename(input.path),
        });
        out.push(
          await this.resolveFile(agent.id, { fileName: uploaded.fileName })
        );
        continue;
      }
      out.push(...(await this.resolveAttachmentsFor(agent, [input])));
    }
    return out;
  }

  private async resolveAttachmentsFor(
    agent: StreamAgent,
    inputs: Array<ChatUserAttachmentInput | BlockAttachmentInput>
  ): Promise<ChatAttachment[]> {
    const out: ChatAttachment[] = [];
    for (const input of inputs) {
      if (input.type === "file") {
        out.push(await this.resolveFile(agent.id, input));
      } else if (input.type === "link" || input.type === "pr") {
        const url = chatUrlSchema.safeParse(input.url);
        if (!url.success) {
          throw new StreamValidationError(
            "url must be an absolute http or https URL."
          );
        }
        out.push({
          type: input.type,
          url: url.data,
          ...(input.title ? { title: input.title } : {}),
        });
      } else {
        out.push(input);
      }
    }
    return out;
  }

  /**
   * One envelope line per resolved attachment: `file: <abs path> (<mime>,
   * <size>)`, `link: <url>`, `code: …`. File paths use the
   * recipient agent's files directory when the file is its own; otherwise
   * the file is described by name and the agent fetches it by URL.
   */
  private describeAttachments(
    agent: StreamAgent,
    attachments: ChatAttachment[]
  ): string[] {
    const filesDir = resolveFilesDir(
      agent.id,
      agent.filesDir,
      this.deps.filesRoot
    );
    const lines: string[] = [];
    for (const attachment of attachments) {
      switch (attachment.type) {
        case "file": {
          const mime = attachment.mimeType ?? "application/octet-stream";
          lines.push(
            `- file: ${path.join(filesDir, attachment.fileName)} (${mime}, ${formatAttachmentSize(attachment.sizeBytes)})`
          );
          break;
        }
        case "link":
        case "pr":
          lines.push(
            `- ${attachment.type}: ${attachment.url}${attachment.title ? ` — ${attachment.title}` : ""}`
          );
          break;
        case "code":
          lines.push(
            `- code${attachment.path ? ` (${attachment.path})` : ""}:\n${attachment.code}`
          );
          break;
      }
    }
    return lines;
  }

  private async resolveFile(
    agentId: string,
    input: { fileName?: string; fileId?: number }
  ): Promise<ChatAttachment> {
    const fileName = input.fileName?.trim();
    const fileId =
      typeof input.fileId === "number" && Number.isInteger(input.fileId)
        ? input.fileId
        : undefined;
    if (!fileName && fileId === undefined) {
      throw new StreamValidationError(
        "file attachments need fileName, fileId or path."
      );
    }
    if (fileName && fileId !== undefined) {
      throw new StreamValidationError(
        "file attachments take either fileName or fileId, not both."
      );
    }
    const result = await this.deps.pool.query<{
      id: number;
      file_name: string;
      size_bytes: number;
      mime_type: string;
    }>(
      `SELECT id, file_name, size_bytes, mime_type FROM files
        WHERE agent_id = $1
          AND CASE WHEN $2::text IS NOT NULL THEN file_name = $2::text ELSE id = $3::int END`,
      [agentId, fileName ?? null, fileId ?? null]
    );
    const match = result.rows[0];
    if (!match) {
      throw new StreamValidationError(
        `Unknown file ${fileName ? `"${fileName}"` : `#${fileId}`} — attach it by path to upload it first.`
      );
    }
    return {
      type: "file",
      fileId: match.id,
      fileName: match.file_name,
      sizeBytes: match.size_bytes,
      mimeType: match.mime_type,
      ownerAgentId: agentId,
    };
  }
}

/**
 * A finding's change, as the wire carries it: `{ status }` with a word
 * (`open`, `fixed`, `dismissed`; `resolved` means fixed unless the
 * resolution says otherwise) and an optional note, or the word alone. It
 * ends up as the stored record: `open`, or `resolved` with a resolution.
 */
function parseFindingPatch(value: unknown): {
  status: BlockFindingStatus;
  resolution?: BlockFindingResolution;
  note?: string;
} {
  const bad = () =>
    new StreamValidationError(
      'A finding\'s state is { status: "open" | "fixed" | "dismissed", note? }.'
    );
  const word =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as { status?: unknown }).status
        : undefined;
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  let status: BlockFindingStatus;
  let resolution: BlockFindingResolution | undefined;
  if (word === "open") {
    status = "open";
  } else if (word === "fixed" || word === "dismissed") {
    status = "resolved";
    resolution = word;
  } else if (word === "resolved") {
    status = "resolved";
    const given = record.resolution;
    if (given !== undefined && given !== "fixed" && given !== "dismissed") {
      throw bad();
    }
    resolution = (given as BlockFindingResolution | undefined) ?? "fixed";
  } else {
    throw bad();
  }
  const note = record.note;
  if (note !== undefined && typeof note !== "string") throw bad();
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (trimmed.length > BLOCK_TEXT_MAX_CHARS) {
    throw new StreamValidationError(
      `A finding's note must be ${BLOCK_TEXT_MAX_CHARS} characters or fewer.`
    );
  }
  return {
    status,
    ...(resolution ? { resolution } : {}),
    ...(trimmed ? { note: trimmed } : {}),
  };
}

/** A state patch with `by`/`at` stamped onto what it touches. */
function stampState(
  kind: "finding" | "tasks",
  patch: Record<string, unknown>,
  by: BlockAuthor
): Record<string, unknown> {
  const at = new Date().toISOString();
  if (kind === "finding") {
    const stamped: BlockFindingState = { ...parseFindingPatch(patch), by, at };
    return stamped;
  }
  const items = patch.items;
  if (!items || typeof items !== "object") {
    throw new StreamValidationError("state.items is required for tasks.");
  }
  const stamped: Record<string, string> = {};
  for (const [id, value] of Object.entries(items as Record<string, unknown>)) {
    if (!["todo", "now", "done"].includes(value as string)) {
      throw new StreamValidationError(
        `task "${id}" status must be todo, now or done.`
      );
    }
    stamped[id] = value as string;
  }
  return { items: stamped };
}

/** "Finding "title" fixed: note" / "… dismissed" / "… reopened". */
function describeFindingChange(
  title: string,
  state: BlockFindingState
): string {
  const what =
    state.status === "open"
      ? "reopened"
      : state.resolution === "dismissed"
        ? "dismissed"
        : "fixed";
  return `Finding "${title}" ${what}${state.note ? `: ${state.note}` : "."}`;
}

/**
 * The line under a finding change that says whose move it is. `side` is
 * who reads it: the finding's author (the reviewer) or the agent it is for
 * (whose work it is). The reviewer decides when a finding is settled.
 */
function findingMoveHint(
  finding: Extract<Block, { kind: "finding" }>,
  side: "author" | "addressee"
): string {
  const reopened = finding.state.status === "open";
  if (side === "addressee") {
    return reopened
      ? `It is yours to address again: make the change and say what you changed under it, post({ replyTo: "${finding.id}", text }). Its reviewer resolves it.`
      : "Nothing to do on your side unless it is reopened.";
  }
  return reopened
    ? "The agent whose work it is will answer under it."
    : "Nothing to do unless you disagree; reopen it with a note if so.";
}

function describeStateChange(
  block: Block,
  patch: Record<string, unknown>
): string {
  if (block.kind === "finding") {
    return describeFindingChange(block.data.title, block.state);
  }
  if (block.kind === "tasks") {
    return Object.entries(patch.items as Record<string, string>)
      .map(([id, v]) => `Task ${id} is now ${v}.`)
      .join("\n");
  }
  return "";
}

function describeInput(block: Block): string {
  if (block.kind === "question") {
    return block.data.options.map((o) => o.label).join(" / ");
  }
  if (block.kind === "form") return block.data.title ?? "Form";
  return block.text;
}
