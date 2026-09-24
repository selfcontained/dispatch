import type { BlockKind } from "./block-types.js";
/**
 * Runtime-free wire contract for the chat surface — the Chat tab that sits
 * above an agent's terminal. See docs/design/blocks.md.
 */

export type ChatAuthorKind = "agent" | "user";

export type ChatMessageKind = "reply" | "update" | "question" | "summary";

/** Why a message exists beyond someone typing it; see `ChatMessage.origin`. */
export type ChatMessageOrigin = "launch";

export type ChatQuestionOption = {
  label: string;
  /** Sent back to the agent when chosen. Defaults to the label. */
  value?: string;
};

export type ChatQuestion = {
  options: ChatQuestionOption[];
  /** When true the UI hints that a typed reply is also acceptable. */
  allowFreeform?: boolean;
};

export type ChatAnswer = {
  value: string;
  label?: string;
  /** Id of the user message created to carry the answer to the agent. */
  replyMessageId: string;
  answeredAt: string;
};

export type ChatAttachment =
  | {
      type: "file";
      /**
       * A file previously shared via share_file, referenced by the
       * stored `fileName` (or `fileId`) that tool returned. The server fills
       * these fields from the file row; the agent's local path is never
       * stored.
       */
      fileId: number;
      fileName: string;
      sizeBytes: number;
      /** The file row's `mime_type`, read from its bytes when it was stored. */
      mimeType?: string;
      /**
       * What the file is to a reader, derived from `mimeType` on read (see
       * `fileMedia`): an `image` shows as a picture, and a post's images are
       * laid out together (see `layoutAttachments`).
       */
      media?: FileMedia;
      /**
       * The agent whose files directory holds the file, and so the agent its
       * URL is served under. Not always the post's author: a person's post
       * holds files of the agent it was sent to. Absent on attachments
       * written before it was recorded; readers fall back to what the post
       * implies.
       */
      ownerAgentId?: string;
      /**
       * Natural pixel size of an image, filled in at read time from the live
       * file row. The feed reserves a box of this aspect ratio before the
       * image loads, so an arriving image never pushes the reader's place down
       * the page. Absent for non-images, for a file whose header could not be
       * read, and for a file row that has since been deleted — each of which
       * falls back to a fixed-height box.
       */
      width?: number;
      height?: number;
    }
  | { type: "link"; url: string; title?: string }
  | { type: "pr"; url: string; title?: string }
  | { type: "code"; code: string; language?: string; path?: string };

export type ChatFileAttachment = Extract<ChatAttachment, { type: "file" }>;

/**
 * What a stored file is to a reader, whichever surface shows it: the Files
 * tab, the lightbox, or a post's attachments. Derived from the file row's
 * `mime_type`, which the server reads from the file's bytes, so no reader
 * works it out again from a name.
 */
export type FileMedia = "image" | "video" | "pdf" | "text" | "file";

/** The `media` a file of this MIME type gets. */
export function fileMedia(mimeType: string | undefined): FileMedia {
  if (!mimeType) return "file";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  ) {
    return "text";
  }
  return "file";
}

/** Tiles a gallery shows before its last one stands for the rest as "+N". */
export const CHAT_GALLERY_MAX_TILES = 6;

/**
 * How a post's attachments are laid out, in order: one `gallery` holding
 * every image when there are two or more, placed where the first of them
 * was, and each other attachment (a lone image included) on its own.
 *
 * This is the rule, not a suggestion to renderers: whoever posts attaches
 * the images and every surface that shows the post lays them out the same
 * way, so no agent has to choose between one post and several.
 */
export type ChatAttachmentGroup =
  | { kind: "gallery"; images: ChatFileAttachment[] }
  | { kind: "single"; attachment: ChatAttachment };

export function layoutAttachments(
  attachments: readonly ChatAttachment[]
): ChatAttachmentGroup[] {
  const isImage = (a: ChatAttachment): a is ChatFileAttachment =>
    a.type === "file" && a.media === "image";
  const images = attachments.filter(isImage);
  if (images.length < 2) {
    return attachments.map((attachment) => ({ kind: "single", attachment }));
  }
  const groups: ChatAttachmentGroup[] = [];
  for (const attachment of attachments) {
    if (!isImage(attachment)) {
      groups.push({ kind: "single", attachment });
    } else if (attachment === images[0]) {
      groups.push({ kind: "gallery", images });
    }
  }
  return groups;
}

/**
 * An attachment as the user supplies it from the Chat composer. `file` names
 * a file row uploaded first via `POST /agents/:id/files`; the server resolves
 * it into the stored `ChatAttachment` shape and stores `link` as given.
 */
export type ChatUserAttachmentInput =
  | { type: "file"; fileId: number }
  | { type: "link"; url: string; title?: string };

/** Body of `POST /agents/:id/chat/messages`. */
export type ChatSendRequest = {
  /**
   * The message's id, minted by the client (a UUID). It lets the client's
   * optimistic row and the stored row be one and the same, so the
   * `chat.entry` for the stored row replaces the placeholder however the
   * stream and the response are ordered. Reusing an id is a 409.
   */
  id?: string;
  /** May be blank when at least one attachment is present. */
  text: string;
  /** Up to `CHAT_ATTACHMENTS_MAX`. */
  attachments?: ChatUserAttachmentInput[];
};

/** Body of `POST /agents/:id/chat/messages/:messageId/answer`. */
export type ChatAnswerRequest = {
  /** The reply message's id, minted by the client; see `ChatSendRequest.id`. */
  id?: string;
  value: string;
  /** Only consulted for a freeform answer; an option's label wins otherwise. */
  label?: string;
  /** Up to `CHAT_ATTACHMENTS_MAX`; stored on the reply message. */
  attachments?: ChatUserAttachmentInput[];
};

/**
 * An emoji reaction on a Chat message. Each side reacts to the other's
 * posts: the user to the agent's (the reaction is injected into the agent's
 * pane), the agent to the user's via chat_react (shown only).
 * Removing a reaction only removes the chip.
 */
export type ChatReaction = {
  id: string;
  authorKind: ChatAuthorKind;
  emoji: string;
  /**
   * User reactions only: whether pane injection succeeded; `null` while
   * pending. Always `null` on agent reactions.
   */
  delivered: boolean | null;
  createdAt: string;
};

/** Body of `POST /agents/:id/chat/messages/:messageId/reactions`. */
export type ChatReactionRequest = { emoji: string };

/** Response of the reaction add/remove routes: the message's reactions now. */
export type ChatReactionResponse = {
  messageId: string;
  reactions: ChatReaction[];
};

export type ChatMessage = {
  id: string;
  agentId: string;
  authorKind: ChatAuthorKind;
  kind: ChatMessageKind;
  text: string;
  replyTo: string | null;
  question: ChatQuestion | null;
  answer: ChatAnswer | null;
  attachments: ChatAttachment[];
  /**
   * User messages only: whether pane injection succeeded. `null` means
   * pending — the message is accepted and queued (possibly behind the quiet
   * gate) but delivery has not completed yet; a `chat.changed` event follows
   * once it settles. Always `null` on agent messages.
   */
  delivered: boolean | null;
  /** Agent messages only: when the user saw it. */
  readAt: string | null;
  /**
   * `"launch"` on the user post that records the context an agent was
   * created with (initial prompt, startup files, links). Absent on
   * every other message. Such a post is always `delivered: true` — the
   * prompt reached the CLI through the normal launch path, not the pane.
   */
  origin?: ChatMessageOrigin;
  /**
   * Launch-context posts only: the agent that created this one via
   * launch_agent, when it was not launched by a person. The web
   * attributes the post to that agent instead of to "You". Absent otherwise.
   */
  launchedByAgentId?: string;
  /**
   * Emoji reactions from the other side of the conversation, oldest first.
   * Absent when there are none, and on rows not read through the feed.
   */
  reactions?: ChatReaction[];
  createdAt: string;
  updatedAt: string;
};

export type ChatFileEntry = {
  type: "file";
  id: string;
  fileId: number;
  fileName: string;
  sizeBytes: number;
  description: string | null;
  /** See `ChatAttachment`'s file variant — same meaning, same fallback. */
  width?: number;
  height?: number;
  at: string;
};

export type ChatTurnStepStatus = "running" | "ok" | "error";

/**
 * One unit of work inside a turn's trace: a tool call, a thought, or a
 * piece of assistant text that was not the turn's answer.
 */
export type ChatTurnStep = {
  id: string;
  /** execute | edit | read | search | fetch | think | note | other */
  kind: string;
  label: string;
  status: ChatTurnStepStatus;
  startedAt: string;
  endedAt?: string;
  durMs?: number;
  detail: {
    toolKind?: string;
    locations?: { path: string; line?: number }[];
    diff?: { path: string; oldText: string | null; newText: string } | null;
    terminalOutput?: string | null;
    truncated?: boolean;
    /** The tool call's raw input (the harness sends the model's arguments). */
    input?: unknown;
    /** note and think steps: the full text. */
    text?: string;
    /** A `subagent` step: the child session it started. */
    subagentSessionId?: string;
    /** A nested call: the toolCallId of the step it runs under. */
    parentToolCallId?: string;
  };
  /** Steps a subagent ran under this one (Claude Task calls). */
  children?: ChatTurnStep[];
};

export type ChatTurnPlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
};

/** What opened a turn, in the reader's terms rather than the wire envelope's. */
export type ChatTurnPrompt = {
  source: "chat" | "launch" | "agent" | "system";
  text: string;
  /** The block behind a chat or launch prompt. */
  chatMessageId?: string;
  /**
   * That block's kind. A text post is drawn by the turn it opened; any other
   * kind (a review left by hand, a question) stays a block of its own and
   * the turn draws no prompt post for it.
   */
  kind?: BlockKind;
  /** A launch prompt written by another agent (launch_agent): which one. */
  launchedByAgentId?: string;
  /**
   * A chat prompt that is a thread reply (an answer to a question, a reply
   * under a block): the thread's root. The block already shows the reply
   * (an answered question, a reply count), so the turn draws no prompt post.
   */
  threadId?: string;
  /** A prompt from another agent: who sent it. */
  senderName?: string;
  /**
   * A prompt from another agent: which one. The child-agent filter needs the
   * id, not the name, to decide whether a turn belongs to a child.
   */
  senderAgentId?: string;
  attachments: ChatAttachment[];
};

export type ChatTurnQuestionRef = { messageId: string; answered: boolean };

/**
 * One turn of a stream-driven harness, whole: the prompt that opened it, the
 * activity behind it, the answer it ended with. It takes the position of its
 * anchor `turn` row and grows in place while the turn runs, so it belongs
 * wholly to the page that anchor falls on and no page boundary splits it.
 */
export type ChatTurnEntry = {
  type: "turn";
  id: string;
  agentId: string;
  /** The anchor row's `created_at`: the turn's place in the feed, fixed for its life. */
  at: string;
  updatedAt: string;
  prompt: ChatTurnPrompt;
  trace: {
    startedAt: string;
    endedAt?: string;
    finalResult?: "ok" | "error" | "interrupted";
    steps: ChatTurnStep[];
  };
  result: {
    text: string;
    streaming: boolean;
    truncated?: boolean;
    /**
     * The start of `text` written before the turn's last tool call: what the
     * agent said while it worked. The rest of `text` is its final reply.
     * Absent when there is no such split (no tool call, or none followed by text).
     */
    lead?: string;
  } | null;
  /** False while the turn is open: the step list is live and the result may grow. */
  settled: boolean;
  /** Cut rather than finished: Stop, Ctrl+C, Send now, or a service restart. */
  interrupted: boolean;
  error?: string;
  /**
   * A failed turn a later attempt could clear: `open` while it is the
   * agent's latest turn, `retried` once the user retried it.
   */
  retry?: "open" | "retried";
  plan?: ChatTurnPlanEntry[];
  usage?: { used: number; size: number; costUsd: number | null };
  questions?: ChatTurnQuestionRef[];
};

export type ChatMessageEntry = {
  type: "chat";
  id: string;
  at: string;
  message: ChatMessage;
};

export type ChatFeedEntry = ChatMessageEntry | ChatFileEntry | ChatTurnEntry;

export type ChatFeedResponse = {
  entries: ChatFeedEntry[];
  hasMore: boolean;
  /**
   * Opaque cursor for the next (older) page: pass it back as `?cursor=` to
   * `GET /agents/:id/chat`. `null` when `hasMore` is false.
   */
  nextCursor: string | null;
  unreadCount: number;
};

/**
 * `GET /api/v1/chat/unread`: per-agent counts for every non-deleted agent
 * with a non-zero value. `unread` = agent messages the user has not seen;
 * `pendingQuestions` = agent questions with no answer yet.
 */
export type ChatUnreadSummary = {
  agents: Record<string, { unread: number; pendingQuestions: number }>;
};

export type ChatSendResponse = {
  message: ChatMessage;
  /** Mirrors `message.delivered`: `null` while delivery is still pending. */
  delivered: boolean | null;
  /** True when the injection is waiting out the terminal quiet gate. */
  held: boolean;
};

export type ChatAnswerResponse = {
  question: ChatMessage;
  reply: ChatMessage;
  /** Mirrors `reply.delivered`: `null` while delivery is still pending. */
  delivered: boolean | null;
};

export type ChatChangedEvent = { type: "chat.changed"; agentId: string };

/**
 * An ACP runtime stream write: an assistant chunk, a tool call, a
 * turn boundary, a queue change. The turn it changed is published as its
 * own `chat.entry`, so this event only refetches the queue; `config`
 * marks the writes that also change the session's model, effort, or
 * running state (a session start, a settle, a switch), so a client
 * refetches that only then, not on every chunk.
 */
export type RuntimeChangedEvent = {
  type: "runtime.changed";
  agentId: string;
  config?: boolean;
};

/**
 * One feed row, exactly as `GET /agents/:id/chat` would return it, published
 * when that row is written or edited so a mounted feed can put it in place
 * instead of refetching every loaded page. Stream blocks
 * are published this way; other sources still announce themselves with
 * the coarse `chat.changed`, which stays the fallback for anything a client
 * cannot place.
 */
export type ChatEntryEvent = {
  type: "chat.entry";
  agentId: string;
  entry: ChatFeedEntry;
};

/**
 * A mark-read landed: the new count, plus what it marked so a cached feed
 * can set `readAt` on the same rows — every unread agent message created
 * at or before `upToAt` (all of them when null).
 */
export type ChatReadEvent = {
  type: "chat.read";
  agentId: string;
  unreadCount: number;
  readAt: string;
  upToAt: string | null;
};

export const CHAT_MESSAGE_MAX_CHARS = 20_000;
export const CHAT_ATTACHMENTS_MAX = 20;
export const CHAT_QUESTION_OPTIONS_MAX = 10;
/** Distinct emoji one message can carry. */
export const CHAT_REACTIONS_MAX = 20;
