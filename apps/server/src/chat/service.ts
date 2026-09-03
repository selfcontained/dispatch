import type { Pool } from "pg";
import type {
  ChatAttachment,
  ChatMessage,
  ChatMessageKind,
  ChatQuestion,
} from "@dispatch/shared";
import {
  CHAT_ATTACHMENTS_MAX,
  CHAT_MESSAGE_MAX_CHARS,
  CHAT_QUESTION_OPTIONS_MAX,
} from "@dispatch/shared";

import type { AgentRecord } from "../agents/types.js";
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

export type ChatServiceDeps = {
  pool: Pool;
  publishUiEvent: (event: { type: "chat.changed"; agentId: string }) => void;
  /** Minimal agent lookup: media dir and pins are all the service needs. */
  getAgent: (
    agentId: string
  ) => Promise<Pick<AgentRecord, "id" | "mediaDir" | "pins"> | null>;
  mediaRoot: string;
};

export class ChatValidationError extends Error {
  statusCode = 400;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

/**
 * Cross-field checks the zod shapes cannot express on their own. Shared by
 * the MCP tools and any future HTTP surface so the rule lives in one place.
 */
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

  constructor(private readonly deps: ChatServiceDeps) {
    this.store = new ChatStore(deps.pool);
  }

  /** Announce a write to `agent_chat_messages` so the Chat tab refetches. */
  publishChanged(agentId: string): void {
    this.deps.publishUiEvent({ type: "chat.changed", agentId });
  }

  /** Agent-authored message from dispatch_chat_post. */
  async post(agentId: string, input: ChatPostInput): Promise<ChatMessage> {
    validateChatContent(input);
    if (input.replyTo != null && !isChatMessageId(input.replyTo)) {
      throw new ChatValidationError(
        "replyTo must be the message id from a DISPATCH CHAT envelope."
      );
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
    this.publishChanged(agentId);
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
    this.publishChanged(agentId);
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
    const agent = await this.deps.getAgent(agentId);
    if (!agent) throw new ChatValidationError("Agent not found.");
    const out: ChatAttachment[] = [];
    for (const input of inputs) {
      if (input.type === "file") {
        out.push(await this.resolveFile(agent.id, input));
      } else if (input.type === "pin") {
        const pins = Array.isArray(agent.pins) ? agent.pins : [];
        if (!pins.some((pin) => pin.id === input.pinId)) {
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
    const dot = match.file_name.lastIndexOf(".");
    const ext = dot >= 0 ? match.file_name.slice(dot).toLowerCase() : "";
    const mimeType = MIME_BY_EXT[ext];
    return {
      type: "file",
      mediaId: match.id,
      fileName: match.file_name,
      sizeBytes: match.size_bytes,
      ...(mimeType ? { mimeType } : {}),
    };
  }
}
