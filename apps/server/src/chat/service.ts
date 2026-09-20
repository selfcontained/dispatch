import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Pool } from "pg";
import type {
  Block,
  BlockAuthor,
  BlockFindingResolution,
  BlockFindingState,
  BlockFindingStatus,
  BlockFormData,
  BlockKind,
  BlockLinkData,
  BlockQuestionData,
  BlockReviewData,
  BlockReviewState,
  BlockTasksData,
  ChatAttachment,
  ChatUserAttachmentInput,
  StreamAnswerResponse,
  StreamBlockEntry,
  StreamChangedEvent,
  StreamEntryEvent,
  StreamPostResponse,
  StreamReactionResponse,
  StreamReadEvent,
} from "@dispatch/shared";
import {
  BLOCK_ATTACHMENTS_MAX,
  BLOCK_FORM_FIELDS_MAX,
  BLOCK_OPTION_LABEL_MAX_CHARS,
  BLOCK_OPTIONS_MAX,
  BLOCK_REACTIONS_MAX,
  BLOCK_REVIEW_FINDINGS_MAX,
  BLOCK_TASKS_MAX,
  BLOCK_TEXT_MAX_CHARS,
  reviewStatus,
} from "@dispatch/shared";

import type { AgentRecord, AgentTerminalAccess } from "../agents/types.js";
import { mimeType, resolveMediaDir } from "../shared/media.js";
import { parentAgentId, rootAgentId } from "../agents/tree.js";
import {
  buildPostEnvelope,
  describeReview,
  buildReactionEnvelope,
  type EnvelopeSender,
  formatAttachmentSize,
} from "./envelope.js";
import { loadBlockEntry } from "./feed.js";
import { loadLatestTurnEntry } from "./turns.js";
import {
  BlockStore,
  isBlockId,
  sameAuthor,
  type UpdateBlockInput,
} from "./store.js";
import { chatUrlSchema, normalizeReactionEmoji } from "./validation.js";

/**
 * An attachment as an agent supplies it to `post`: `file` names a file it
 * shared before (by `fileName` or `mediaId`) or a `path` on disk that the
 * server uploads first; the server fills in the media row fields.
 */
export type BlockAttachmentInput =
  | {
      type: "file";
      fileName?: string;
      mediaId?: number;
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
  /** With `replyTo` naming a review (or a reply in its thread): the finding this is about. */
  finding?: string | null;
  question?: BlockQuestionData | null;
  form?: BlockFormData | null;
  link?: BlockLinkData | null;
  review?: BlockReviewData | null;
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
export type StreamDeliveryAdapter = {
  /**
   * Whether the agent can receive a prompt right now. Throws `AgentError`
   * for a missing/stopped agent; resolves to `mode: "inert"` when there is
   * no engine.
   */
  access: (agentId: string) => Promise<AgentTerminalAccess>;
  /** Queue `text` as a prompt for the agent; resolves when accepted. */
  inject: (agentId: string, text: string) => Promise<void>;
  /** Whether a turn is holding deliveries for this agent right now. */
  held: (agentId: string) => boolean;
};

export type StreamAgent = Pick<
  AgentRecord,
  "id" | "name" | "mediaDir" | "status"
>;

export type StreamServiceDeps = {
  pool: Pool;
  publishUiEvent: (
    event: StreamChangedEvent | StreamEntryEvent | StreamReadEvent
  ) => void;
  /** Minimal agent lookup: name, media dir and status are all the service needs. */
  getAgent: (agentId: string) => Promise<StreamAgent | null>;
  /**
   * Root of per-agent media directories (config.mediaRoot), so the envelope
   * can hand the agent an absolute path for a file attachment — the same
   * resolution `GET /media/:file` serves from.
   */
  mediaRoot: string;
  /**
   * Whether any browser is listening. Composing a turn entry reads the whole
   * open turn and the recorder asks for one about ten times a second, so an
   * unattended agent would pay for an announcement nobody receives. Absent
   * means assume someone is listening.
   */
  hasUiClient?: () => boolean;
  /** An agent posted a question or form for people: it is waiting now. */
  onInputPosted?: (agentId: string, text: string) => Promise<void>;
  /** Copy a file from the agent's disk into its media; for `path` attachments. */
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
 * the recorder once the agent row and its media rows exist. Files are the
 * seeded media rows; links are the raw startup URLs.
 */
export type LaunchContextInput = {
  /**
   * The block's id, when the caller needs it before the write — the launch
   * path fixes it so the engine's first turn can carry it in its envelope.
   */
  id?: string;
  agentId: string;
  /** The initial prompt as the person (or launching agent) wrote it. */
  text?: string;
  files?: Array<{ mediaId: number }>;
  links?: string[];
  /** The agent that created this one via launch_agent, if any. */
  launchedByAgentId?: string | null;
};

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
  const kind = input.kind ?? given[0] ?? "text";
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
            `Each option label must be 1–${BLOCK_OPTION_LABEL_MAX_CHARS} characters: a button, not a sentence. Put the explanation in the text.`
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
      if (!r || !Array.isArray(r.findings)) {
        throw new StreamValidationError(
          "review needs verdict, summary and findings."
        );
      }
      if (!["approve", "request_changes", "comment"].includes(r.verdict)) {
        throw new StreamValidationError(
          "review.verdict must be approve, request_changes or comment."
        );
      }
      if (r.findings.length > BLOCK_REVIEW_FINDINGS_MAX) {
        throw new StreamValidationError(
          `review.findings must have ${BLOCK_REVIEW_FINDINGS_MAX} entries or fewer.`
        );
      }
      uniqueIds(r.findings, "finding");
      for (const finding of r.findings) {
        if (!["blocker", "major", "minor", "nit"].includes(finding.severity)) {
          throw new StreamValidationError(
            `finding "${finding.id}" has an unknown severity.`
          );
        }
      }
      return { kind, data: r };
    }
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

/** The initial state a kind starts with. */
function initialState(kind: BlockKind, data: unknown): unknown {
  switch (kind) {
    case "question":
    case "form":
      return {};
    case "review": {
      const findings: Record<string, unknown> = {};
      for (const f of (data as BlockReviewData).findings) {
        findings[f.id] = {
          status: "open",
          by: USER,
          at: new Date().toISOString(),
        };
      }
      return { findings };
    }
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
  if (block.kind === "review" && block.data) {
    const review = describeReview(
      block.id,
      block.data as BlockReviewData,
      (block.state as BlockReviewState | null) ?? null
    );
    return block.text.trim() ? `${block.text.trim()}\n\n${review}` : review;
  }
  return block.text;
}

export class StreamService {
  readonly store: BlockStore;
  private readonly inFlightDeliveries = new Set<Promise<unknown>>();
  private readonly turnPublishes = new Map<string, TurnPublish>();
  private readonly log: NonNullable<StreamServiceDeps["log"]>;

  constructor(private readonly deps: StreamServiceDeps) {
    this.store = new BlockStore(deps.pool);
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
   * The agent a reply in a thread is for when the writer named none: the
   * agent on the other side of the thread's root (its author, or the agent
   * it was addressed to). Null when the thread has no agent on it.
   */
  /**
   * Who a reply in a thread is for. A thread has two sides: the root's
   * author and whoever it was addressed to (on a review: the reviewer and
   * the agent whose work it is). Each reply goes to exactly one of them,
   * never to everyone in the thread:
   *
   * - answering a particular comment goes to that comment's author;
   * - one side writing goes to the other side;
   * - a person writing goes to whoever's move it is: on an open finding
   *   (or an open review) the agent that has to act on it, on a resolved
   *   one the reviewer who checks it.
   *
   * Falls back to any other agent in the thread, then null.
   */
  private async threadCounterpart(
    thread: { threadId: string; replyTo: string },
    author: BlockAuthor,
    finding: { id: string } | null
  ): Promise<string | null> {
    const root = await this.store.getById(thread.threadId);
    if (!root) return null;
    const agentOf = (candidate: BlockAuthor | null | undefined) =>
      candidate?.kind === "agent" && !sameAuthor(candidate, author)
        ? candidate.agentId
        : null;
    if (thread.replyTo !== thread.threadId) {
      const target = await this.store.getById(thread.replyTo);
      const direct = agentOf(target?.author);
      if (direct) return direct;
    }
    const reviewer = agentOf(root.author);
    const requester =
      root.toAgentId &&
      !(author.kind === "agent" && author.agentId === root.toAgentId)
        ? root.toAgentId
        : null;
    if (author.kind === "agent") {
      if (sameAuthor(root.author, author)) return requester;
      if (author.agentId === root.toAgentId) return reviewer;
    } else if (root.kind === "review" && reviewer && requester) {
      const data = root.data as BlockReviewData;
      const state = root.state as BlockReviewState | null;
      const open = finding
        ? (state?.findings?.[finding.id]?.status ?? "open") === "open"
        : reviewStatus(data, state) !== "resolved";
      return open ? requester : reviewer;
    }
    if (requester) return requester;
    if (reviewer) return reviewer;
    const others = await this.store.threadParticipants(thread.threadId, author);
    const agent = others.find(
      (p): p is { kind: "agent"; agentId: string } => p.kind === "agent"
    );
    return agent?.agentId ?? null;
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
      /** With `replyTo` on a review: the finding this reply is about. */
      finding?: string | null;
      attachments?: ChatUserAttachmentInput[];
      /** A review left by hand: the block is a `review` with these findings. */
      review?: BlockReviewData | null;
      allowInert?: boolean;
    }
  ): Promise<StreamPostResponse> {
    const attachments = input.attachments ?? [];
    const text = requireText(input.text);
    const review = input.review
      ? (resolveKindAndData({ review: input.review }).data as BlockReviewData)
      : null;
    if (!text.trim() && attachments.length === 0 && !review) {
      throw new StreamValidationError("text is required.");
    }
    if (attachments.length > BLOCK_ATTACHMENTS_MAX) {
      throw new StreamValidationError(
        `attachments must have ${BLOCK_ATTACHMENTS_MAX} entries or fewer.`
      );
    }
    const thread = review
      ? null
      : await this.resolveThread(streamId, input.replyTo ?? null);
    const finding = await this.resolveFinding(thread, input.finding ?? null);
    // A reply in a thread goes to the agent on the other side of it; a
    // top-level post goes to the stream's agent unless addressed elsewhere.
    const toAgentId =
      input.to ??
      (thread ? await this.threadCounterpart(thread, USER, finding) : null) ??
      streamId;
    const recipient = await this.requireAgent(toAgentId);
    let resolved: ChatAttachment[] = [];
    let attachmentLines: string[] = [];
    if (attachments.length > 0) {
      resolved = await this.resolveAttachmentsFor(recipient, attachments);
      attachmentLines = this.describeAttachments(recipient, resolved);
    }
    const live = await this.canDeliver(toAgentId, input.allowInert ?? true);
    const row = {
      streamId,
      author: USER,
      toAgentId,
      kind: review ? ("review" as const) : ("text" as const),
      threadId: thread?.threadId ?? null,
      replyTo: thread?.replyTo ?? null,
      text,
      ...(review
        ? { data: review, state: initialState("review", review) }
        : finding
          ? { data: { findingId: finding.id } }
          : {}),
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
    if (thread) await this.publishEntry(streamId, thread.threadId);
    if (!live) return { block, delivered: false, held: false };
    const { held } = await this.deliverBlock(
      block,
      { kind: "user" },
      attachmentLines
    );
    return { block, delivered: null, held };
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
   * Change a block's state: a finding resolved, a task ticked. The author
   * and the recipient may; people always may. The author is told when
   * someone else changed it.
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
    if (
      by.kind === "agent" &&
      !sameAuthor(block.author, by) &&
      block.toAgentId !== by.agentId
    ) {
      throw new StreamForbiddenError(
        "Only the block's author or the agent it is addressed to may change its state."
      );
    }
    if (block.kind !== "review" && block.kind !== "tasks") {
      throw new StreamValidationError(
        `A ${block.kind} block has no state to change this way.`
      );
    }
    const kind = block.kind;
    const stamped = stampState(kind, patch, by);
    const updated = await this.store.mergeState(block.id, stamped);
    if (!updated) throw new StreamNotFoundError("Block not found.");
    await this.publishEntry(streamId, updated.id);
    // The two sides of the block hear about a change the other made: the
    // author (a reviewer) when the recipient or a person resolves a
    // finding, the recipient (the one whose work it is) when the author or
    // a person reopens or dismisses one.
    const sides = new Set<string>();
    if (updated.author.kind === "agent") sides.add(updated.author.agentId);
    if (updated.toAgentId) sides.add(updated.toAgentId);
    if (by.kind === "agent") sides.delete(by.agentId);
    const summary = describeStateChange(kind, stamped);
    const from = await this.senderOf(by);
    for (const agentId of sides) {
      if (!(await this.canDeliver(agentId, true))) continue;
      // Whose move it is: a reopened finding is the builder's to fix and
      // the reviewer's to wait on; a resolved one is the reviewer's to
      // check. Said outright, so neither side takes the other's turn.
      const role =
        kind === "review"
          ? reviewMoveHint(
              stamped,
              updated.author.kind === "agent" &&
                updated.author.agentId === agentId
                ? "reviewer"
                : "builder"
            )
          : null;
      this.injectDetached({
        agentId,
        envelope: buildPostEnvelope({
          blockId: updated.id,
          from,
          text: role ? `${summary}\n${role}` : summary,
          threadId: updated.threadId,
        }),
        record: async () => undefined,
        logContext: { blockId: updated.id, side: agentId },
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
    let data = resolved.data;
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
    // A review is a thread of its own (its findings are discussed under
    // it), so it is never a reply: a reviewer answering its briefing in
    // the launch thread still posts the review top-level.
    const thread =
      kind === "review" ? null : await this.resolveThread(streamId, replyTo);
    const finding = await this.resolveFinding(thread, input.finding ?? null);
    if (finding && kind === "text") data = { findingId: finding.id };
    if (finding && kind === "question") {
      data = { ...(data as BlockQuestionData), findingId: finding.id };
    }
    if (toAgentId === null && thread) {
      toAgentId = await this.threadCounterpart(thread, author, finding);
    }
    const attachments = await this.resolveAgentAttachments(
      agent,
      attachmentInputs
    );
    const live = toAgentId ? await this.canDeliver(toAgentId, true) : false;
    const block = await this.store.insert({
      streamId,
      author,
      toAgentId,
      kind,
      threadId: thread?.threadId ?? null,
      replyTo: thread?.replyTo ?? null,
      text,
      data,
      state: initialState(kind, data),
      attachments,
      delivered: toAgentId ? (live ? null : false) : null,
    });
    await this.publishEntry(streamId, block.id);
    if (thread) await this.publishEntry(streamId, thread.threadId);
    // An agent's reply to a question asked of it is the answer: the
    // question closes with the reply's text (an option's label when the
    // reply is one), the way a person's click would close it.
    const answered =
      kind === "text" && thread && text.trim()
        ? await this.answerByReply(agentId, thread.replyTo, block)
        : null;
    // File paths in the envelope are the author's: that is where the file
    // is, and every agent on this machine can read it.
    const attachmentLines = this.describeAttachments(agent, attachments);
    const from: EnvelopeSender = { kind: "agent", agentId, name: agent.name };
    if (toAgentId && live) {
      await this.deliverBlock(
        block,
        from,
        attachmentLines,
        answered ? { answers: { blockId: answered.id, kind: "question" } } : {}
      );
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
    const patch: UpdateBlockInput = {};
    if (input.text !== undefined) patch.text = requireText(input.text);
    if (input.data !== undefined) {
      patch.data = resolveKindAndData({
        kind: block.kind,
        ...(block.kind === "question"
          ? { question: input.data as BlockQuestionData }
          : {}),
        ...(block.kind === "form" ? { form: input.data as BlockFormData } : {}),
        ...(block.kind === "link" ? { link: input.data as BlockLinkData } : {}),
        ...(block.kind === "review"
          ? { review: input.data as BlockReviewData }
          : {}),
        ...(block.kind === "tasks"
          ? { tasks: input.data as BlockTasksData }
          : {}),
        attachments: block.attachments.map((a) =>
          a.type === "file" ? { type: "file" as const, mediaId: a.mediaId } : a
        ),
      }).data;
    }
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
      if (block.kind === "review" || block.kind === "tasks") {
        updated = await this.setState(
          block.streamId,
          block.id,
          input.state,
          author
        );
      } else {
        updated =
          (await this.store.mergeState(block.id, input.state)) ?? updated;
      }
    }
    await this.publishEntry(updated.streamId, updated.id);
    return updated;
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
      return null;
    }
    const inputs: ChatUserAttachmentInput[] = [
      ...files.map((file) => ({
        type: "file" as const,
        mediaId: file.mediaId,
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
    const id = input.id ?? randomUUID();
    const streamId = await this.streamOf(input.agentId);
    return {
      id,
      attachmentLines,
      postText,
      record: async () => {
        const block = await this.store.insertIfAbsent({
          id,
          streamId,
          author: USER,
          toAgentId: input.agentId,
          kind: "text",
          text: postText,
          attachments: stored,
          delivered: true,
          origin: "launch",
          launchedByAgentId: input.launchedByAgentId ?? null,
        });
        if (!block) {
          throw new StreamConflictError(
            `A block with id ${id} already exists; the launch post was not written.`
          );
        }
        await this.publishEntry(streamId, block.id);
        return block;
      },
    };
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

  private async composeTurnEntry(agentId: string): Promise<void> {
    try {
      const entry = await loadLatestTurnEntry(this.store.db, agentId);
      if (entry) {
        const streamId = await this.streamOf(agentId);
        this.deps.publishUiEvent({
          type: "stream.entry",
          agentId: streamId,
          entry,
        });
      }
    } catch (error) {
      this.log.warn(
        { err: error, agentId },
        "stream: could not compose the turn for its feed event"
      );
    }
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
      entry = await loadBlockEntry(this.store.db, streamId, blockId);
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
    return this.injectDetached({
      agentId: toAgentId,
      envelope: buildPostEnvelope({
        blockId: block.id,
        from,
        text: envelopeText(block),
        attachmentLines,
        threadId: block.threadId,
        finding: await this.findingOf(block),
        answers: extra.answers ?? null,
      }),
      record: async (delivered) => {
        await this.store.setDelivered(block.id, delivered);
        await this.publishEntry(block.streamId, block.id);
      },
      logContext: { blockId: block.id },
    });
  }

  private injectDetached(input: {
    agentId: string;
    envelope: string;
    record: (delivered: boolean) => Promise<void>;
    logContext: Record<string, string>;
  }): { held: boolean } {
    const { agentId, logContext } = input;
    const delivery = this.delivery();
    const settlement = delivery
      .inject(agentId, input.envelope)
      .then(
        () => true,
        (error: unknown) => {
          this.log.warn(
            { err: error, agentId, ...logContext },
            "stream: delivery failed — agent may have exited"
          );
          return false;
        }
      )
      .then(input.record)
      .catch((error: unknown) => {
        this.log.error(
          { err: error, agentId, ...logContext },
          "stream: failed to record delivery outcome"
        );
      });
    this.trackDelivery(settlement);
    return { held: delivery.held(agentId) };
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
   * Where a reply lands: `replyTo` may name a top-level block (the thread's
   * root) or a reply inside one (then the root is that reply's thread).
   * Must be on this stream.
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
    return { threadId: target.threadId ?? target.id, replyTo: target.id };
  }

  /**
   * The finding a thread reply is about: named by id, it has to exist on
   * the review the thread is under. Returns its id and title, or null when
   * no finding was named.
   */
  /** The finding a reply names (its id and title), for the envelope. */
  private async findingOf(
    block: Block
  ): Promise<{ id: string; title: string } | null> {
    const findingId =
      (block.kind === "text" || block.kind === "question") &&
      block.data &&
      "findingId" in block.data
        ? (block.data as { findingId?: string }).findingId
        : undefined;
    if (!findingId || !block.threadId) return null;
    const root = await this.store.getById(block.threadId);
    if (!root || root.kind !== "review") return null;
    const match = (root.data as BlockReviewData).findings.find(
      (candidate) => candidate.id === findingId
    );
    return match ? { id: match.id, title: match.title } : null;
  }

  /**
   * Close a question with the reply the agent it was asked of just made.
   * Returns the answered question, or null when the reply answers nothing
   * (not a question, not asked of this agent, or already answered).
   */
  private async answerByReply(
    agentId: string,
    replyTo: string,
    reply: Block
  ): Promise<Block | null> {
    const target = await this.store.getById(replyTo);
    if (
      !target ||
      target.kind !== "question" ||
      target.toAgentId !== agentId ||
      target.state?.answer
    ) {
      return null;
    }
    const text = reply.text.trim();
    const option = target.data.options.find(
      (o) => o.label.trim() === text || (o.value ?? o.label) === text
    );
    const answered = await this.store.recordAnswer(target.id, {
      value: option ? (option.value ?? option.label) : text,
      ...(option ? { label: option.label } : {}),
      by: { kind: "agent", agentId },
      blockId: reply.id,
      at: new Date().toISOString(),
    });
    if (answered) await this.publishEntry(answered.streamId, answered.id);
    return answered;
  }

  private async resolveFinding(
    thread: { threadId: string; replyTo: string } | null,
    finding: string | null
  ): Promise<{ id: string; title: string } | null> {
    if (finding === null || finding.trim() === "") {
      // Unnamed, a reply to a comment about a finding is about that
      // finding too: the discussion stays under the item it started on.
      if (!thread || thread.replyTo === thread.threadId) return null;
      const parent = await this.store.getById(thread.replyTo);
      return parent ? this.findingOf(parent) : null;
    }
    if (!thread) {
      throw new StreamValidationError(
        "finding needs replyTo: the review the finding is on."
      );
    }
    const root = await this.store.getById(thread.threadId);
    if (!root || root.kind !== "review") {
      throw new StreamValidationError(
        "finding only applies to a reply in a review's thread."
      );
    }
    const match = (root.data as BlockReviewData).findings.find(
      (candidate) => candidate.id === finding
    );
    if (!match) {
      throw new StreamValidationError(
        `finding "${finding}" is not on that review.`
      );
    }
    return { id: match.id, title: match.title };
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
   * recipient agent's media directory when the file is its own; otherwise
   * the file is described by name and the agent fetches it by URL.
   */
  private describeAttachments(
    agent: StreamAgent,
    attachments: ChatAttachment[]
  ): string[] {
    const mediaDir = resolveMediaDir(
      agent.id,
      agent.mediaDir,
      this.deps.mediaRoot
    );
    const lines: string[] = [];
    for (const attachment of attachments) {
      switch (attachment.type) {
        case "file": {
          const mime = attachment.mimeType ?? mimeType(attachment.fileName);
          lines.push(
            `- file: ${path.join(mediaDir, attachment.fileName)} (${mime}, ${formatAttachmentSize(attachment.sizeBytes)})`
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
    input: { fileName?: string; mediaId?: number }
  ): Promise<ChatAttachment> {
    const fileName = input.fileName?.trim();
    const mediaId =
      typeof input.mediaId === "number" && Number.isInteger(input.mediaId)
        ? input.mediaId
        : undefined;
    if (!fileName && mediaId === undefined) {
      throw new StreamValidationError(
        "file attachments need fileName, mediaId or path."
      );
    }
    if (fileName && mediaId !== undefined) {
      throw new StreamValidationError(
        "file attachments take either fileName or mediaId, not both."
      );
    }
    const result = await this.deps.pool.query<{
      id: number;
      file_name: string;
      size_bytes: number;
    }>(
      `SELECT id, file_name, size_bytes FROM media
        WHERE agent_id = $1
          AND CASE WHEN $2::text IS NOT NULL THEN file_name = $2::text ELSE id = $3::int END`,
      [agentId, fileName ?? null, mediaId ?? null]
    );
    const match = result.rows[0];
    if (!match) {
      throw new StreamValidationError(
        `Unknown file ${fileName ? `"${fileName}"` : `#${mediaId}`} — attach it by path to upload it first.`
      );
    }
    return {
      type: "file",
      mediaId: match.id,
      fileName: match.file_name,
      sizeBytes: match.size_bytes,
      mimeType: mimeType(match.file_name),
    };
  }
}

/**
 * One finding's change, as the wire carries it: a word or a record. Both
 * end up as the stored record: `open`, or `resolved` with a resolution
 * (`fixed` unless it says `dismissed`) and an optional note.
 */
function parseFindingPatch(
  id: string,
  value: unknown
): {
  status: BlockFindingStatus;
  resolution?: BlockFindingResolution;
  note?: string;
} {
  const bad = () =>
    new StreamValidationError(
      `finding "${id}" must be open, fixed or dismissed (or { status, resolution?, note? }).`
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
      `finding "${id}" note must be ${BLOCK_TEXT_MAX_CHARS} characters or fewer.`
    );
  }
  return {
    status,
    ...(resolution ? { resolution } : {}),
    ...(trimmed ? { note: trimmed } : {}),
  };
}

/** A state patch with `by`/`at` stamped onto each item it touches. */
function stampState(
  kind: "review" | "tasks",
  patch: Record<string, unknown>,
  by: BlockAuthor
): Record<string, unknown> {
  const at = new Date().toISOString();
  if (kind === "review") {
    const findings = patch.findings;
    if (!findings || typeof findings !== "object") {
      throw new StreamValidationError(
        "state.findings is required for a review."
      );
    }
    const stamped: Record<string, BlockFindingState> = {};
    for (const [id, value] of Object.entries(
      findings as Record<string, unknown>
    )) {
      stamped[id] = { ...parseFindingPatch(id, value), by, at };
    }
    return { findings: stamped };
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

/** "Finding f1 fixed: note" / "Finding f2 dismissed" / "Finding f3 reopened". */
function describeFindingChange(id: string, state: BlockFindingState): string {
  const what =
    state.status === "open"
      ? "reopened"
      : state.resolution === "dismissed"
        ? "dismissed"
        : "fixed";
  return `Finding ${id} ${what}${state.note ? `: ${state.note}` : "."}`;
}

/**
 * The line under a finding change that says whose move it is. `side` is
 * who reads it: the review's author (reviewer) or the agent it is
 * addressed to (builder).
 */
function reviewMoveHint(
  patch: Record<string, unknown>,
  side: "reviewer" | "builder"
): string {
  const findings = Object.values(
    patch.findings as Record<string, BlockFindingState>
  );
  const reopened = findings.some((f) => f.status === "open");
  if (side === "builder") {
    return reopened
      ? "A reopened finding is yours to address: make the change, say what changed under the finding, then mark it fixed on this block."
      : "Nothing to do on your side unless a finding is reopened.";
  }
  return reopened
    ? "The agent whose work this is will address it; you will hear when it is marked fixed. Do not make the change yourself."
    : "Verify the resolution when you can; reopen the finding with a note if it falls short.";
}

function describeStateChange(
  kind: "review" | "tasks",
  patch: Record<string, unknown>
): string {
  if (kind === "review") {
    return Object.entries(patch.findings as Record<string, BlockFindingState>)
      .map(([id, v]) => describeFindingChange(id, v))
      .join("\n");
  }
  return Object.entries(patch.items as Record<string, string>)
    .map(([id, v]) => `Task ${id} is now ${v}.`)
    .join("\n");
}

function describeInput(block: Block): string {
  if (block.kind === "question") {
    return block.data.options.map((o) => o.label).join(" / ");
  }
  if (block.kind === "form") return block.data.title ?? "Form";
  return block.text;
}
