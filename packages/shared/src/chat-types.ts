/**
 * Runtime-free wire contract for the chat surface — the Chat tab that sits
 * above an agent's terminal. See docs/chat-surface-plan.md.
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
       * A file previously shared via dispatch_share_file, referenced by the
       * stored `fileName` (or `mediaId`) that tool returned. The server fills
       * these fields from the media row; the agent's local path is never
       * stored.
       */
      mediaId: number;
      fileName: string;
      sizeBytes: number;
      mimeType?: string;
    }
  | { type: "link"; url: string; title?: string }
  | { type: "pr"; url: string; title?: string }
  | { type: "code"; code: string; language?: string; path?: string }
  | { type: "pin"; pinId: string };

/**
 * An attachment as the user supplies it from the Chat composer. `file` names
 * a media row uploaded first via `POST /agents/:id/media`; the server resolves
 * it into the stored `ChatAttachment` shape, verifies `pin` on the agent, and
 * stores `link` as given.
 */
export type ChatUserAttachmentInput =
  | { type: "file"; mediaId: number }
  | { type: "pin"; pinId: string }
  | { type: "link"; url: string; title?: string };

/** Body of `POST /agents/:id/chat/messages`. */
export type ChatSendRequest = {
  /** May be blank when at least one attachment is present. */
  text: string;
  /** Up to `CHAT_ATTACHMENTS_MAX`. */
  attachments?: ChatUserAttachmentInput[];
};

/** Body of `POST /agents/:id/chat/messages/:messageId/answer`. */
export type ChatAnswerRequest = {
  value: string;
  /** Only consulted for a freeform answer; an option's label wins otherwise. */
  label?: string;
  /** Up to `CHAT_ATTACHMENTS_MAX`; stored on the reply message. */
  attachments?: ChatUserAttachmentInput[];
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
   * created with (initial prompt, startup files, links, pins). Absent on
   * every other message. Such a post is always `delivered: true` — the
   * prompt reached the CLI through the normal launch path, not the pane.
   */
  origin?: ChatMessageOrigin;
  /**
   * Launch-context posts only: the agent that created this one via
   * dispatch_launch_agent, when it was not launched by a person. The web
   * attributes the post to that agent instead of to "You". Absent otherwise.
   */
  launchedByAgentId?: string;
  createdAt: string;
  updatedAt: string;
};

/** A row from `agent_events`, surfaced as a compact feed line. */
export type ChatStatusEntry = {
  type: "status";
  id: string;
  eventType: string;
  message: string;
  at: string;
};

/** A cross-agent message (`agent_messages`) in either direction. */
export type ChatAgentMessageEntry = {
  type: "agent_message";
  id: string;
  direction: "in" | "out";
  senderAgentId: string;
  senderName: string;
  recipientAgentId: string;
  recipientName: string;
  /** True when either endpoint is a direct child of this feed's agent. */
  involvesChildAgent?: boolean;
  content: string;
  /** `null` while the pane delivery is still pending (see `agent_messages`). */
  delivered: boolean | null;
  at: string;
};

/** A file the agent shared via dispatch_share_file. */
export type ChatMediaEntry = {
  type: "media";
  id: string;
  mediaId: number;
  fileName: string;
  sizeBytes: number;
  description: string | null;
  at: string;
};

/**
 * A review submitted against this agent's work (`reviews`), surfaced as a
 * card in the feed. Derived at read time, so the counts and the status are
 * always the review's current ones — the card is a live link to the review
 * in the Reviews sidebar, not a snapshot of when it landed.
 */
export type ChatReviewEntry = {
  type: "review";
  id: string;
  reviewId: number;
  /** Who left it: an agent reviewer, or a person using the Changes tab. */
  reviewerType: "human" | "agent";
  reviewerAgentId: string | null;
  /** The reviewer agent's persona or name; null for a human review. */
  reviewerName: string | null;
  summary: string | null;
  status: string;
  itemCount: number;
  resolvedCount: number;
  at: string;
};

/** One assistant message from a stream-driven harness (dsh over ACP). */
export type ChatAssistantEntry = {
  type: "assistant";
  id: string;
  text: string;
  /** True while chunks are still arriving for this message. */
  streaming: boolean;
  at: string;
};

export type ChatActivityStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

/**
 * One tool call from a stream-driven harness, rewritten in place as it
 * settles. `toolKind` follows the Agent Client Protocol vocabulary (read,
 * edit, delete, move, search, execute, think, fetch, other).
 */
export type ChatActivityEntry = {
  type: "activity";
  id: string;
  toolKind: string;
  title: string;
  status: ChatActivityStatus;
  locations: { path: string; line?: number }[];
  diff: { path: string; oldText: string | null; newText: string } | null;
  terminalOutput: string | null;
  at: string;
};

export type ChatMessageEntry = {
  type: "chat";
  id: string;
  at: string;
  message: ChatMessage;
};

export type ChatFeedEntry =
  | ChatMessageEntry
  | ChatStatusEntry
  | ChatAgentMessageEntry
  | ChatMediaEntry
  | ChatReviewEntry
  | ChatAssistantEntry
  | ChatActivityEntry;

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

export const CHAT_MESSAGE_MAX_CHARS = 20_000;
export const CHAT_ATTACHMENTS_MAX = 20;
export const CHAT_QUESTION_OPTIONS_MAX = 10;
