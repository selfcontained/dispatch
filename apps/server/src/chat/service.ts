import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Pool } from "pg";
import type {
  ChatAnswerResponse,
  ChatAttachment,
  ChatMessage,
  ChatMessageKind,
  ChatQuestion,
  ChatSendResponse,
  ChatUserAttachmentInput,
  ChatChangedEvent,
  ChatEntryEvent,
  ChatMessageEntry,
  ChatReadEvent,
} from "@dispatch/shared";
import {
  CHAT_ATTACHMENTS_MAX,
  CHAT_MESSAGE_MAX_CHARS,
  CHAT_QUESTION_OPTIONS_MAX,
} from "@dispatch/shared";

import type { AgentRecord, AgentTerminalAccess } from "../agents/types.js";
import { mimeType, resolveMediaDir } from "../shared/media.js";
import { buildChatEnvelope, formatAttachmentSize } from "./envelope.js";
import { loadChatMessageEntry } from "./feed.js";
import {
  ChatStore,
  isChatMessageId,
  type UpdateChatMessageInput,
} from "./store.js";

/**
 * An attachment as an agent supplies it to dispatch_chat_post: `file` carries
 * only the path; the server fills in the media row fields.
 */
export type ChatAttachmentInput =
  | {
      type: "file";
      /** Stored name returned by dispatch_share_file. */
      fileName?: string;
      /** Media row id, as an alternative to fileName. */
      mediaId?: number;
    }
  | Exclude<ChatAttachment, { type: "file" }>;

export type ChatPostInput = {
  text: string;
  kind?: ChatMessageKind;
  replyTo?: string | null;
  question?: ChatQuestion | null;
  attachments?: ChatAttachmentInput[];
};

export type ChatUpdateInput = {
  text?: string;
  kind?: ChatMessageKind;
  question?: ChatQuestion | null;
  attachments?: ChatAttachmentInput[];
};

/**
 * How user text reaches an agent's pane. The service owns the workflow (row,
 * envelope, outcome, events); this adapter owns the terminal, so tests can
 * stand in a fake and the service never imports tmux.
 */
export type ChatDeliveryAdapter = {
  /**
   * Whether the agent can receive text right now. Throws `AgentError` for a
   * missing/stopped agent; resolves to `mode: "inert"` when there is no pane.
   */
  access: (agentId: string) => Promise<AgentTerminalAccess>;
  /** Write `text` into the pane, behind the quiet gate; resolves when done. */
  inject: (agentId: string, sessionName: string, text: string) => Promise<void>;
  /** Whether the quiet gate is holding deliveries for this agent right now. */
  held: (agentId: string) => boolean;
};

type ChatAgent = Pick<AgentRecord, "id" | "mediaDir" | "pins">;

export type ChatServiceDeps = {
  pool: Pool;
  publishUiEvent: (
    event: ChatChangedEvent | ChatEntryEvent | ChatReadEvent
  ) => void;
  /** Minimal agent lookup: media dir and pins are all the service needs. */
  getAgent: (agentId: string) => Promise<ChatAgent | null>;
  /**
   * Root of per-agent media directories (config.mediaRoot), so the envelope
   * can hand the agent an absolute path for a file attachment — the same
   * resolution `GET /media/:file` serves from.
   */
  mediaRoot: string;
  /** Required for the user-side workflows (send, answer). */
  delivery?: ChatDeliveryAdapter;
  log?: {
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
};

/** Base for the domain errors the HTTP layer maps to a status code. */
export abstract class ChatServiceError extends Error {
  abstract readonly statusCode: number;
}

export class ChatValidationError extends ChatServiceError {
  readonly statusCode = 400;
}

export class ChatNotFoundError extends ChatServiceError {
  readonly statusCode = 404;
}

export class ChatConflictError extends ChatServiceError {
  readonly statusCode = 409;
}

/**
 * What an agent was created with, as `AgentManager.createAgent` hands it to
 * the recorder once the agent row and its media rows exist. Files are the
 * seeded media rows; links are the raw startup URLs; pins are the initial
 * pins (a url pin made from one of `links` is skipped, so the same URL is
 * not shown twice).
 */
export type ChatLaunchContextInput = {
  /**
   * The post's id, when the caller needs it before the write — the launch
   * path fixes it so the CLI's first turn can carry it in its envelope.
   */
  id?: string;
  agentId: string;
  /** The initial prompt as the person (or launching agent) wrote it. */
  text?: string;
  files?: Array<{ mediaId: number }>;
  links?: string[];
  pins?: Array<{ id: string; type: string; value: string }>;
  /** The agent that created this one via dispatch_launch_agent, if any. */
  launchedByAgentId?: string | null;
};

/** A launch post resolved but not yet written; see `prepareLaunchContext`. */
export type PreparedLaunchContext = {
  /** The post's id, known before the write. */
  id: string;
  /**
   * One envelope line per resolved startup attachment — *every* one, not
   * the capped set the row stores. The CLI's first turn must still describe
   * all the startup files, links and pins it used to get from
   * `buildStartupPrompt`; only the post is capped.
   */
  attachmentLines: string[];
  /**
   * Exactly what the row will store: the prompt, truncated to the chat
   * limit and marked as truncated when it did not fit, plus a line naming
   * the attachments the cap left off. Exposed so a caller can see what the
   * feed will say without waiting for the write.
   */
  postText: string;
  /** Write the post and announce the feed change. */
  record: () => Promise<ChatMessage>;
};

/**
 * Appended to a launch post whose prompt did not fit in
 * `CHAT_MESSAGE_MAX_CHARS`. The CLI's first turn always carries the full
 * prompt, so the post must say plainly that it is showing less rather than
 * quietly disagreeing with what the agent was told.
 */
export const LAUNCH_POST_TRUNCATED_NOTE =
  "[Truncated for Chat — the agent's first turn received the full prompt.]";

/** Appended when the attachment cap left startup context off the post. */
function launchPostAttachmentNote(hidden: number): string {
  return `[${hidden} more startup attachment${hidden === 1 ? "" : "s"} not listed here — all of them were delivered to the agent.]`;
}

/**
 * The launch post's stored text, normalized once so the row and the first
 * turn cannot disagree without saying so. The prompt is trimmed to fit
 * `CHAT_MESSAGE_MAX_CHARS` (a launched agent's prompt may be five times
 * that), and each thing the row is showing less of gets its own note.
 */
export function buildLaunchPostText(
  text: string,
  hiddenAttachments = 0
): string {
  const notes: string[] = [];
  if (hiddenAttachments > 0) {
    notes.push(launchPostAttachmentNote(hiddenAttachments));
  }
  // Reserve room for the notes before deciding how much prompt fits, so a
  // note is never itself truncated away.
  const reserved = notes.reduce((sum, note) => sum + note.length + 2, 0);
  let body = text;
  if (body.length + reserved > CHAT_MESSAGE_MAX_CHARS) {
    const budget =
      CHAT_MESSAGE_MAX_CHARS -
      reserved -
      (LAUNCH_POST_TRUNCATED_NOTE.length + 2);
    body = body.slice(0, Math.max(0, budget));
    notes.unshift(LAUNCH_POST_TRUNCATED_NOTE);
  }
  return [body, ...notes].filter((part) => part.length > 0).join("\n\n");
}

export type ChatAnswerInput = {
  value: string;
  /** Only consulted for a freeform answer; an option's label wins otherwise. */
  label?: string;
  /** Ride along on the reply message, resolved like sendUserMessage's. */
  attachments?: ChatUserAttachmentInput[];
};

const ANSWER_LABEL_MAX = 200;
const NO_OP_LOG = { warn() {}, error() {} };

/** Cross-field checks the zod shapes cannot express on their own. */
export function validateChatContent(input: {
  text?: string;
  kind?: ChatMessageKind;
  question?: ChatQuestion | null;
  attachments?: ChatAttachmentInput[];
}): void {
  if (input.text !== undefined) {
    if (input.text.trim().length === 0) {
      throw new ChatValidationError("text must not be empty.");
    }
    if (input.text.length > CHAT_MESSAGE_MAX_CHARS) {
      throw new ChatValidationError(
        `text must be ${CHAT_MESSAGE_MAX_CHARS} characters or fewer.`
      );
    }
  }
  const kind = input.kind ?? "reply";
  if (kind === "question") {
    if (!input.question || input.question.options.length === 0) {
      throw new ChatValidationError(
        'question (with at least one option) is required when kind is "question".'
      );
    }
  } else if (input.question) {
    throw new ChatValidationError(
      'question is only accepted when kind is "question".'
    );
  }
  if (
    input.question &&
    input.question.options.length > CHAT_QUESTION_OPTIONS_MAX
  ) {
    throw new ChatValidationError(
      `question.options must have ${CHAT_QUESTION_OPTIONS_MAX} entries or fewer.`
    );
  }
  if (input.attachments && input.attachments.length > CHAT_ATTACHMENTS_MAX) {
    throw new ChatValidationError(
      `attachments must have ${CHAT_ATTACHMENTS_MAX} entries or fewer.`
    );
  }
}

export class ChatService {
  readonly store: ChatStore;
  /** Detached pane deliveries that have not recorded their outcome yet. */
  private readonly inFlightDeliveries = new Set<Promise<unknown>>();
  private readonly log: NonNullable<ChatServiceDeps["log"]>;

  constructor(private readonly deps: ChatServiceDeps) {
    this.store = new ChatStore(deps.pool);
    this.log = deps.log ?? NO_OP_LOG;
  }

  // -------------------------------------------------------------------------
  // User-side workflows (HTTP)
  // -------------------------------------------------------------------------

  /**
   * A user message typed in the Chat tab: persist it, enqueue pane delivery
   * when a terminal exists, and return at once. In inert mode the post still
   * belongs in the feed, but starts at `delivered: false` because there is no
   * pane to receive it. The quiet gate can hold a real delivery far longer
   * than a request should wait, so those rows stay null until injection
   * settles; `held` reports whether the gate is holding right now.
   *
   * `text` may be blank when at least one attachment is present. Attachments
   * are resolved (file by mediaId, pin verified on the agent, link as given)
   * before anything is written, so a bad one is a 400 with no row behind it.
   */
  async sendUserMessage(
    agentId: string,
    text: string,
    attachments: ChatUserAttachmentInput[] = [],
    options: { allowInert?: boolean } = {}
  ): Promise<ChatSendResponse> {
    if (!text.trim() && attachments.length === 0) {
      throw new ChatValidationError("text is required.");
    }
    if (text.length > CHAT_MESSAGE_MAX_CHARS) {
      throw new ChatValidationError(
        `text must be ${CHAT_MESSAGE_MAX_CHARS} characters or fewer.`
      );
    }
    if (attachments.length > CHAT_ATTACHMENTS_MAX) {
      throw new ChatValidationError(
        `attachments must have ${CHAT_ATTACHMENTS_MAX} entries or fewer.`
      );
    }
    let resolved: ChatAttachment[] = [];
    let attachmentLines: string[] = [];
    if (attachments.length > 0) {
      const agent = await this.requireAgent(agentId);
      resolved = await this.resolveAttachmentsFor(agent, attachments);
      attachmentLines = this.describeAttachments(agent, resolved);
    }
    const sessionName = await this.deliverySession(
      agentId,
      options.allowInert ?? false
    );
    const delivered = sessionName === null ? false : null;
    const message = await this.store.insert({
      agentId,
      authorKind: "user",
      kind: "reply",
      text,
      attachments: resolved,
      delivered,
    });
    if (sessionName === null) {
      await this.publishEntry(agentId, message.id);
      return { message, delivered: false, held: false };
    }
    const { held } = this.deliverDetached(
      agentId,
      sessionName,
      message,
      attachmentLines
    );
    await this.publishEntry(agentId, message.id);
    return { message, delivered: null, held };
  }

  /**
   * Answer an agent question. The stored question decides what `value`
   * means: an option's label is the reply text, and a client label only
   * matters for a freeform answer. Attachments are resolved before anything
   * is written and stored on the reply, exactly as for a plain user message.
   * The reply row and the answer land in one transaction, so racing answers
   * leave exactly one reply.
   */
  async answerQuestion(
    agentId: string,
    messageId: string,
    input: ChatAnswerInput
  ): Promise<ChatAnswerResponse> {
    if (!isChatMessageId(messageId)) {
      throw new ChatValidationError("messageId must be a UUID.");
    }
    if (!input.value.trim()) {
      throw new ChatValidationError("value is required.");
    }
    const attachments = input.attachments ?? [];
    if (attachments.length > CHAT_ATTACHMENTS_MAX) {
      throw new ChatValidationError(
        `attachments must have ${CHAT_ATTACHMENTS_MAX} entries or fewer.`
      );
    }
    const question = await this.store.getById(messageId);
    if (
      !question ||
      question.agentId !== agentId ||
      question.authorKind !== "agent" ||
      question.kind !== "question"
    ) {
      throw new ChatNotFoundError("Question not found.");
    }
    if (question.answer) {
      throw new ChatConflictError("Question already answered.");
    }
    const { value } = input;
    const options = question.question?.options ?? [];
    const option = options.find((o) => (o.value ?? o.label) === value);
    let label: string | undefined;
    if (option) {
      label = option.label;
    } else if (question.question?.allowFreeform) {
      const supplied = input.label?.trim() ?? "";
      label = supplied ? supplied.slice(0, ANSWER_LABEL_MAX) : undefined;
    } else {
      throw new ChatValidationError(
        "value does not match one of the question's options."
      );
    }
    const text = option ? option.label : value;
    if (text.length > CHAT_MESSAGE_MAX_CHARS) {
      throw new ChatValidationError(
        `value must be ${CHAT_MESSAGE_MAX_CHARS} characters or fewer.`
      );
    }
    let resolved: ChatAttachment[] = [];
    let attachmentLines: string[] = [];
    if (attachments.length > 0) {
      const agent = await this.requireAgent(agentId);
      resolved = await this.resolveAttachmentsFor(agent, attachments);
      attachmentLines = this.describeAttachments(agent, resolved);
    }

    const sessionName = await this.deliverySession(agentId, true);
    const delivered = sessionName === null ? false : null;

    // Reply row and answer land together or not at all: a concurrent answer
    // makes recordAnswer match nothing, and the rollback takes the orphan
    // reply with it.
    const client = await this.deps.pool.connect();
    let replyMessage: ChatMessage;
    let answered: ChatMessage | null;
    try {
      await client.query("BEGIN");
      const tx = this.store.withClient(client);
      replyMessage = await tx.insert({
        agentId,
        authorKind: "user",
        kind: "reply",
        text,
        replyTo: question.id,
        attachments: resolved,
        delivered,
      });
      answered = await tx.recordAnswer(question.id, {
        value,
        ...(label !== undefined ? { label } : {}),
        replyMessageId: replyMessage.id,
        answeredAt: new Date().toISOString(),
      });
      if (!answered) {
        await client.query("ROLLBACK");
        throw new ChatConflictError("Question already answered.");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (sessionName !== null) {
      this.deliverDetached(agentId, sessionName, replyMessage, attachmentLines);
    }
    await this.publishEntry(agentId, answered.id);
    await this.publishEntry(agentId, replyMessage.id);
    return { question: answered, reply: replyMessage, delivered };
  }

  /** A real pane's session name, or null when this Chat flow permits inert. */
  private async deliverySession(
    agentId: string,
    allowInert: boolean
  ): Promise<string | null> {
    const access = await this.delivery().access(agentId);
    if (access.mode === "tmux") return access.sessionName;
    if (!allowInert) throw new ChatConflictError(access.message);
    return null;
  }

  private delivery(): ChatDeliveryAdapter {
    if (!this.deps.delivery) {
      throw new Error("ChatService: no delivery adapter configured.");
    }
    return this.deps.delivery;
  }

  /**
   * Enqueue the envelope and return at once. The detached continuation
   * records true/false on the row and publishes `chat.changed`; graceful
   * shutdown waits (briefly) for it, and a restart sweeps whatever it could
   * not wait for to delivered=false.
   */
  private deliverDetached(
    agentId: string,
    sessionName: string,
    message: ChatMessage,
    attachmentLines: string[] = []
  ): { held: boolean } {
    const delivery = this.delivery();
    const envelope = buildChatEnvelope(
      message.id,
      message.text,
      attachmentLines
    );
    const settlement = delivery
      .inject(agentId, sessionName, envelope)
      .then(
        () => true,
        (error: unknown) => {
          this.log.warn(
            { err: error, agentId, messageId: message.id },
            "chat: pane delivery failed — agent may have exited"
          );
          return false;
        }
      )
      .then(async (delivered) => {
        await this.store.setDelivered(message.id, delivered);
        await this.publishEntry(agentId, message.id);
      })
      .catch((error: unknown) => {
        this.log.error(
          { err: error, agentId, messageId: message.id },
          "chat: failed to record delivery outcome"
        );
      });
    this.trackDelivery(settlement);
    return { held: delivery.held(agentId) };
  }

  /**
   * Resolve a launch's context without writing it: the attachments (file
   * by mediaId, pin verified on the agent, link as given) and the envelope
   * lines that describe them — the same lines `sendUserMessage` injects, so
   * the pane and the post agree — plus a `record` that performs the write.
   * The launch path builds the CLI's first turn from `id` and
   * `attachmentLines` while `record` runs alongside the runtime start.
   * A launch with no context at all resolves to null and records nothing.
   */
  async prepareLaunchContext(
    input: ChatLaunchContextInput
  ): Promise<PreparedLaunchContext | null> {
    const text = input.text ?? "";
    const links = (input.links ?? []).filter((url) => url.trim().length > 0);
    const linkSet = new Set(links);
    const files = input.files ?? [];
    const pins = (input.pins ?? []).filter(
      (pin) => !(pin.type === "url" && linkSet.has(pin.value))
    );
    if (
      !text.trim() &&
      files.length === 0 &&
      links.length === 0 &&
      pins.length === 0
    ) {
      return null;
    }
    const inputs: ChatUserAttachmentInput[] = [
      ...files.map((file) => ({
        type: "file" as const,
        mediaId: file.mediaId,
      })),
      ...links.map((url) => ({ type: "link" as const, url })),
      ...pins.map((pin) => ({ type: "pin" as const, pinId: pin.id })),
    ];
    // Everything is resolved and described, because the CLI's first turn has
    // to list all of it. Only the row is capped: a launch can seed more pins
    // than a post may carry, and refusing the launch over that would be
    // worse than a post that says how much it left off.
    let attachments: ChatAttachment[] = [];
    let attachmentLines: string[] = [];
    if (inputs.length > 0) {
      const agent = await this.requireAgent(input.agentId);
      attachments = await this.resolveAttachmentsFor(agent, inputs);
      attachmentLines = this.describeAttachments(agent, attachments);
    }
    const storedAttachments =
      attachments.length > CHAT_ATTACHMENTS_MAX
        ? attachments.slice(0, CHAT_ATTACHMENTS_MAX)
        : attachments;
    const postText = buildLaunchPostText(
      text,
      attachments.length - storedAttachments.length
    );
    const id = input.id ?? randomUUID();
    return {
      id,
      attachmentLines,
      postText,
      record: async () => {
        // Collision-safe: an id that is already taken means this call did not
        // write the post, and the caller must not name it in an envelope.
        const message = await this.store.insertIfAbsent({
          id,
          agentId: input.agentId,
          authorKind: "user",
          kind: "reply",
          text: postText,
          attachments: storedAttachments,
          delivered: true,
          origin: "launch",
          launchedByAgentId: input.launchedByAgentId ?? null,
        });
        if (!message) {
          throw new ChatConflictError(
            `A chat message with id ${id} already exists; the launch post was not written.`
          );
        }
        await this.publishEntry(input.agentId, message.id);
        return message;
      },
    };
  }

  /**
   * Record the context an agent was launched with as one user post at the
   * top of its feed: the initial prompt as text, plus a file attachment per
   * startup file, a link per startup link, and a pin per initial pin. The
   * prompt reaches the CLI through the normal launch path (wrapped in the
   * Chat envelope when the chat surface is on), so the post is
   * `delivered: true` and nothing is injected. A launch with no context at
   * all records nothing and returns null.
   *
   * When another agent did the launching, `launchedByAgentId` is stored so
   * the web can attribute the post to it; the row stays a user post so the
   * unread and question counts (agent posts only) are unaffected.
   */
  async recordLaunchContext(
    input: ChatLaunchContextInput
  ): Promise<ChatMessage | null> {
    const prepared = await this.prepareLaunchContext(input);
    return prepared ? prepared.record() : null;
  }

  // -------------------------------------------------------------------------
  // Delivery lifecycle (startup recovery, shutdown drain)
  // -------------------------------------------------------------------------

  /**
   * Announce a write to `agent_chat_messages` the coarse way: the Chat tab
   * refetches every page it has. Kept for writes with no single row to
   * carry (a mark-read sweep, startup recovery) and as `publishEntry`'s
   * fallback.
   */
  publishChanged(agentId: string): void {
    this.deps.publishUiEvent({ type: "chat.changed", agentId });
  }

  /** Mark-read moved the count; the rows on screen do not change. */
  publishRead(agentId: string, unreadCount: number): void {
    this.deps.publishUiEvent({ type: "chat.read", agentId, unreadCount });
  }

  /**
   * Announce one message as the feed row it now is, read back through the
   * feed's own query so the wire entry is exactly what a refetch would
   * return. A row that cannot be read back falls back to `chat.changed`.
   */
  private async publishEntry(
    agentId: string,
    messageId: string
  ): Promise<void> {
    let entry: ChatMessageEntry | null = null;
    try {
      entry = await loadChatMessageEntry(this.store.db, agentId, messageId);
    } catch (error) {
      this.log.warn(
        { err: error, agentId, messageId },
        "chat: could not read a message back for its feed event"
      );
    }
    if (entry) this.deps.publishUiEvent({ type: "chat.entry", agentId, entry });
    else this.publishChanged(agentId);
  }

  /**
   * Startup recovery for deliveries the previous process never settled: the
   * quiet-gate queue is in-memory, so a restart abandons them while their
   * rows still say pending. Mark them not-delivered (no replay — a resend
   * is the user's call, a duplicate injection is not) and announce each
   * affected feed. Returns the agent ids touched.
   */
  async recoverPendingDeliveries(): Promise<string[]> {
    const agentIds = await this.store.sweepPendingDeliveries();
    for (const agentId of agentIds) this.publishChanged(agentId);
    return agentIds;
  }

  /**
   * Register a detached delivery's settlement chain so graceful shutdown can
   * wait for it. The promise must never reject (the route already handles
   * outcomes); it is dropped from the set once it settles.
   */
  private trackDelivery(settlement: Promise<unknown>): void {
    this.inFlightDeliveries.add(settlement);
    void settlement.finally(() => {
      this.inFlightDeliveries.delete(settlement);
    });
  }

  get inFlightDeliveryCount(): number {
    return this.inFlightDeliveries.size;
  }

  /**
   * Bounded wait for in-flight deliveries to record their outcome, so a
   * graceful shutdown does not leave rows pending that were about to settle.
   * Resolves true when everything settled, false on timeout — whatever is
   * still pending then is swept to not-delivered by the next startup.
   */
  async waitForInFlightDeliveries(timeoutMs: number): Promise<boolean> {
    if (this.inFlightDeliveries.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      // Snapshot: deliveries enqueued after shutdown began are not waited on.
      const pending = Promise.allSettled([...this.inFlightDeliveries]).then(
        () => true as const
      );
      return await Promise.race([pending, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Agent-side workflows (MCP)
  // -------------------------------------------------------------------------

  /** Agent-authored message from dispatch_chat_post. */
  async post(agentId: string, input: ChatPostInput): Promise<ChatMessage> {
    validateChatContent(input);
    if (input.replyTo != null) {
      if (!isChatMessageId(input.replyTo)) {
        throw new ChatValidationError(
          "replyTo must be the message id from a DISPATCH CHAT envelope."
        );
      }
      // A syntactically valid id is not enough: the envelope's id is the only
      // thing that entitles an agent to thread onto a message, and a launching
      // agent knows real ids from other feeds. Anything that is not a message
      // on this agent's own feed is refused rather than silently threaded.
      const target = await this.store.getById(input.replyTo);
      if (!target || target.agentId !== agentId) {
        throw new ChatValidationError(
          "replyTo must name a message on this agent's own Chat feed — use the id from a DISPATCH CHAT envelope."
        );
      }
    }
    const kind = input.kind ?? "reply";
    const attachments = await this.resolveAttachments(
      agentId,
      input.attachments ?? []
    );
    const message = await this.store.insert({
      agentId,
      authorKind: "agent",
      kind,
      text: input.text,
      replyTo: input.replyTo ?? null,
      question: kind === "question" ? (input.question ?? null) : null,
      attachments,
    });
    await this.publishEntry(agentId, message.id);
    return message;
  }

  /** Edit an agent-authored message from dispatch_chat_update. */
  async update(
    agentId: string,
    messageId: string,
    input: ChatUpdateInput
  ): Promise<ChatMessage> {
    if (!isChatMessageId(messageId)) {
      throw new ChatValidationError(
        "messageId must be an id returned by dispatch_chat_post."
      );
    }
    const existing = await this.store.getById(messageId);
    if (
      !existing ||
      existing.agentId !== agentId ||
      existing.authorKind !== "agent"
    ) {
      throw new ChatValidationError(
        "Message not found — dispatch_chat_update only edits your own agent messages."
      );
    }
    if (
      existing.answer &&
      ((input.kind !== undefined && input.kind !== existing.kind) ||
        input.question !== undefined)
    ) {
      // The answer references these options; swapping or dropping them would
      // leave it pointing at nothing.
      throw new ChatValidationError(
        "This question has already been answered, so its kind and options are fixed — edit the text or attachments, or post a new question."
      );
    }
    const kind = input.kind ?? existing.kind;
    // Moving away from kind=question clears the stored question, so only a
    // question supplied in this call counts against the "rejected otherwise"
    // rule; staying on a question keeps the stored one.
    const question =
      input.question !== undefined
        ? input.question
        : kind === "question"
          ? existing.question
          : null;
    validateChatContent({
      text: input.text,
      kind,
      question,
      attachments: input.attachments,
    });
    const patch: UpdateChatMessageInput = {};
    if (input.text !== undefined) patch.text = input.text;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (kind !== "question") {
      if (existing.question) patch.question = null;
    } else if (input.question !== undefined) {
      patch.question = input.question;
    }
    if (input.attachments !== undefined) {
      patch.attachments = await this.resolveAttachments(
        agentId,
        input.attachments
      );
    }
    const updated = await this.store.update(messageId, patch);
    if (!updated) throw new ChatValidationError("Message not found.");
    await this.publishEntry(agentId, updated.id);
    return updated;
  }

  /**
   * Turn agent-supplied attachments into their stored form: `file` resolves
   * to this agent's media row by the stored fileName (or mediaId) that
   * dispatch_share_file returned — never by a local path, so an unshared
   * file cannot masquerade as an earlier share — and `pin` must name a pin
   * on this agent.
   */
  async resolveAttachments(
    agentId: string,
    inputs: ChatAttachmentInput[]
  ): Promise<ChatAttachment[]> {
    if (inputs.length === 0) return [];
    return this.resolveAttachmentsFor(await this.requireAgent(agentId), inputs);
  }

  private async requireAgent(agentId: string): Promise<ChatAgent> {
    const agent = await this.deps.getAgent(agentId);
    if (!agent) throw new ChatValidationError("Agent not found.");
    return agent;
  }

  private async resolveAttachmentsFor(
    agent: ChatAgent,
    inputs: ChatAttachmentInput[]
  ): Promise<ChatAttachment[]> {
    const out: ChatAttachment[] = [];
    for (const input of inputs) {
      if (input.type === "file") {
        out.push(await this.resolveFile(agent.id, input));
      } else if (input.type === "pin") {
        if (!this.findPin(agent, input.pinId)) {
          throw new ChatValidationError(
            `Unknown pin "${input.pinId}" — dispatch_list_pins shows the ids on this agent.`
          );
        }
        out.push({ type: "pin", pinId: input.pinId });
      } else {
        out.push(input);
      }
    }
    return out;
  }

  private findPin(agent: ChatAgent, pinId: string) {
    const pins = Array.isArray(agent.pins) ? agent.pins : [];
    return pins.find((pin) => pin.id === pinId);
  }

  /**
   * One envelope line per resolved attachment, in the documented format:
   * `file: <abs path> (<mime>, <size>)`, `pin: <label> — <value>`,
   * `link: <url>`. File paths use the agent's media directory — the same
   * resolution the media download route uses — so the agent can open them.
   */
  private describeAttachments(
    agent: ChatAgent,
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
        case "pin": {
          const pin = this.findPin(agent, attachment.pinId);
          lines.push(
            pin
              ? `- pin: ${pin.label} — ${pin.value}`
              : `- pin: ${attachment.pinId}`
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
      throw new ChatValidationError(
        "file attachments need fileName (from dispatch_share_file) or mediaId."
      );
    }
    if (fileName && mediaId !== undefined) {
      // Two identifiers could name two different rows; refuse rather than
      // pick one.
      throw new ChatValidationError(
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
          AND CASE WHEN $2::text IS NOT NULL THEN file_name = $2::text
                   ELSE id = $3::int END`,
      [agentId, fileName ?? null, mediaId ?? null]
    );
    const match = result.rows[0];
    if (!match) {
      throw new ChatValidationError(
        `Unknown file ${fileName ? `"${fileName}"` : `#${mediaId}`} — share it first with dispatch_share_file and attach the fileName it returns.`
      );
    }
    // The same lookup GET /media serves the file with.
    return {
      type: "file",
      mediaId: match.id,
      fileName: match.file_name,
      sizeBytes: match.size_bytes,
      mimeType: mimeType(match.file_name),
      // No dimensions here on purpose. The feed fills them in from the live
      // media row when it reads the page, which is the only thing that can be
      // right: dispatch_share_file replaces a file's bytes under an unchanged
      // URL, so a shape frozen at write time can describe bytes the post no
      // longer serves.
    };
  }
}
