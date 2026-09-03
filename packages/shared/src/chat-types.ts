/**
 * Runtime-free wire contract for the chat surface — the Chat tab that sits
 * above an agent's terminal. See docs/chat-surface-plan.md.
 */

export type ChatAuthorKind = "agent" | "user";

export type ChatMessageKind = "reply" | "update" | "question" | "summary";

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
      /** Absolute path the agent shared via dispatch_share_file. */
      path: string;
      /** Resolved by the server from the media table. */
      mediaId: number;
      fileName: string;
      sizeBytes: number;
      mimeType?: string;
    }
  | { type: "link"; url: string; title?: string }
  | { type: "pr"; url: string; title?: string }
  | { type: "code"; code: string; language?: string; path?: string }
  | { type: "pin"; pinId: string };

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
  /** User messages only: whether pane injection succeeded. */
  delivered: boolean | null;
  /** Agent messages only: when the user saw it. */
  readAt: string | null;
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
  content: string;
  delivered: boolean;
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
  | ChatMediaEntry;

export type ChatFeedResponse = {
  entries: ChatFeedEntry[];
  hasMore: boolean;
  unreadCount: number;
};

export type ChatSendResponse = {
  message: ChatMessage;
  delivered: boolean;
  held: boolean;
};

export type ChatAnswerResponse = {
  question: ChatMessage;
  reply: ChatMessage;
  delivered: boolean;
};

export type ChatChangedEvent = { type: "chat.changed"; agentId: string };

export const CHAT_MESSAGE_MAX_CHARS = 20_000;
export const CHAT_ATTACHMENTS_MAX = 20;
export const CHAT_QUESTION_OPTIONS_MAX = 10;
