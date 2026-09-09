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
      /**
       * Natural pixel size of an image, filled in at read time from the live
       * media row. The feed reserves a box of this aspect ratio before the
       * image loads, so an arriving image never pushes the reader's place down
       * the page. Absent for non-images, for a file whose header could not be
       * read, and for a media row that has since been deleted — each of which
       * falls back to a fixed-height box.
       */
      width?: number;
      height?: number;
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
  /** See `ChatAttachment`'s file variant — same meaning, same fallback. */
  width?: number;
  height?: number;
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

/** One assistant message from a stream-driven harness (over ACP). */
export type ChatAssistantEntry = {
  type: "assistant";
  id: string;
  text: string;
  /** True while chunks are still arriving for this message. */
  streaming: boolean;
  /** The text hit the server's per-message size bound and was cut. */
  truncated?: boolean;
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
  /** Output or diff hit the server's per-row size bound and was cut. */
  truncated?: boolean;
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

/** One entry of the agent's task list, as ACP `plan` carries it. */
export type ChatTurnPlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
};

/** What opened a turn, in the reader's terms rather than the wire envelope's. */
export type ChatTurnPrompt = {
  source: "chat" | "launch" | "agent" | "system";
  text: string;
  /** The `agent_chat_messages` row behind a chat or launch prompt. */
  chatMessageId?: string;
  /** A prompt from another agent: who sent it. */
  senderName?: string;
  attachments: ChatAttachment[];
};

/** A question asked during the turn. Its card is a `chat` entry of its own. */
export type ChatTurnQuestionRef = { messageId: string; answered: boolean };

/**
 * One turn of a stream-driven harness, whole: the prompt that opened it, the
 * activity behind it, the answer it ended with. It takes the position of its
 * anchor `turn` row and grows in place while the turn runs, so it belongs
 * wholly to the page that anchor falls on and no page boundary splits it.
 */
export type ChatTurnEntry = {
  type: "turn";
  /** `turn:<stream row id>`, or `turn:pre:<first row id>` for a pre-turn group. */
  id: string;
  agentId: string;
  /** The anchor row's `created_at`: the turn's place in the feed, fixed for its life. */
  at: string;
  /** The newest row folded in so far; moves while the turn streams. */
  updatedAt: string;
  prompt: ChatTurnPrompt;
  trace: {
    startedAt: string;
    endedAt?: string;
    finalResult?: "ok" | "error" | "interrupted";
    steps: ChatTurnStep[];
  };
  result: { text: string; streaming: boolean; truncated?: boolean } | null;
  /** False while the turn is open: the rail is live and the result may grow. */
  settled: boolean;
  /** Cut rather than finished: Stop, Ctrl+C, Send now, or a service restart. */
  interrupted: boolean;
  error?: string;
  /** The turn in the agent's own words: its last `dispatch_event` message. */
  label?: string;
  plan?: ChatTurnPlanEntry[];
  usage?: { used: number; size: number; costUsd: number | null };
  questions?: ChatTurnQuestionRef[];
};

/**
 * Pins the agent created, updated, or deleted in one write (`pin_events`),
 * surfaced as a post in the feed. Entries carry ids, not values: the web
 * renders each pin live from the agent's current pins, exactly as a pin
 * attachment does, so a later update refreshes every earlier entry and a
 * shortcut in the stream stays runnable. `label` is the one snapshot, so an
 * entry can still name a pin that has since been deleted.
 */
export type ChatPinEntry = {
  type: "pin";
  id: string;
  action: "created" | "updated" | "deleted";
  pins: Array<{ id: string; label: string }>;
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
  | ChatActivityEntry
  | ChatTurnEntry
  | ChatPinEntry;

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
 * A Dispatch Harness stream write: an assistant chunk, a tool call, a
 * turn boundary, a queue change. The feed and the Harness turns refetch;
 * `config` marks the writes that also change the session's model,
 * effort, or running state (a session start, a settle, a switch), so a
 * client refetches that only then, not on every chunk.
 */
export type HarnessChangedEvent = {
  type: "harness.changed";
  agentId: string;
  config?: boolean;
};

/**
 * One feed row, exactly as `GET /agents/:id/chat` would return it, published
 * when that row is written or edited so a mounted feed can put it in place
 * instead of refetching every loaded page. Chat messages and status events
 * are published this way; the other sources still announce themselves with
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
