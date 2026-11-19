import type { RunnerEngine } from "./execution.js";
import { isNullableString, isRecord, isSequence } from "./validation.js";

/** The last contiguous position durably received in the named host journal. */
export type ReplayHello = {
  type: "hello";
  fromSeq: number;
  journalId?: string | null;
  replayComplete?: boolean;
};

export type HostWelcome = {
  type: "welcome";
  agentId: string;
  engine: RunnerEngine;
  sessionId: string;
  resumed: boolean;
  running: boolean;
  journalSeq: number;
  journalId?: string;
};

export type JournalEntry<Event> = {
  seq: number;
  at: string;
  event: Event;
  /** Absent on entries written by older hosts. */
  journalId?: string;
};

export type HostEvent<Event = unknown> = {
  type: "event";
} & JournalEntry<Event>;
export type ReplayComplete = { type: "replay_complete" };

export type HostPrompt<Source = unknown, Image = unknown> = {
  type: "prompt";
  id: string;
  text: string;
  journalId?: string;
  source?: Source;
  images?: Image[];
};

export type PromptReceipt =
  | { type: "prompt_accepted"; id: string }
  /** An engine-initiated turn is open and the host did not submit this prompt. */
  | { type: "prompt_deferred"; id: string };

/**
 * What a prompt sent to the harness was, for the prompt a turn entry
 * renders. The wire text is an envelope Dispatch built; the feed wants the
 * human-facing source behind it, not the envelope.
 */
export type PromptSource = {
  /** Source discussion for batching and steering, retained through the host journal.
   * User-thread turns use their validated source discussion for output at turn start. */
  conversation?: { streamId: string; threadId: string | null };
  /**
   * A person's post. With a conversation, a prompt steers only that
   * conversation; another agent's post without one steers any open turn.
   */
  userMessage?: boolean;
  /** Structured answers and commands retain their dedicated delivery policy. */
  steeringExcluded?: boolean;
  /** Agent-authored scheduled content, explicitly eligible for steering. */
  scheduleId?: string;
  scheduleDeliveryId?: string;
  /**
   * The recipient is waiting on this: a review it launched, a finding
   * thread it is a side of, a finding settled or reopened. It joins the
   * active turn whatever conversation that turn is in, rather than
   * waiting behind the very work that is waiting on it.
   */
  awaited?: boolean;
} & (
  | {
      source: "chat";
      /** The post that opened the turn: the first, when there were several. */
      chatMessageId: string;
      /**
       * Every post the turn was given, in order, when posts that queued up
       * behind a turn were delivered to it together.
       */
      chatMessageIds?: string[];
      /**
       * The block whose thread this prompt's answer belongs in, when the
       * prompt says so rather than leaving it to what the post is: a
       * notice that a finding changed is answered under the finding.
       * Retained when prompts from this conversation are delivered together.
       */
      answerIn?: string;
    }
  | { source: "agent"; senderId: string; senderName: string; text: string }
  | { source: "system"; text: string }
  /**
   * A turn the engine started on its own between prompts (a background
   * task finished, a goal continued). `after` is the block that answered
   * the turn before it: this is source context; new ordinary work uses the agent home.
   */
  | { source: "engine"; text: string; after?: string }
);

/** Server-resolved files, kept out of turn journals and encoded only for ACP. */
export type PromptImage = { path: string; mimeType: string };

export type SessionCommand =
  | ReplayHello
  | HostPrompt<PromptSource, PromptImage>
  | { type: "steer"; id: string; text: string; source?: PromptSource }
  | { type: "cancel" }
  | { type: "interrupt"; id: string; turnSeq: number }
  | {
      type: "answer_permission";
      id: string;
      requestId: string;
      optionId: string | null;
    }
  /** Set one of the session's config options (model, effort, mode). */
  | { type: "set_config"; id: string; configId: string; value: string }
  | { type: "shutdown"; force?: boolean }
  | { type: "mcp_inventory"; id: string; sessionId: string }
  | { type: "background_work"; id: string; sessionId: string }
  | { type: "ping" };

function isPromptSource(value: unknown): value is PromptSource {
  if (!isRecord(value)) return false;
  const { conversation } = value;
  if (
    conversation !== undefined &&
    (!isRecord(conversation) ||
      typeof conversation.streamId !== "string" ||
      !isNullableString(conversation.threadId))
  )
    return false;
  if (
    ![value.userMessage, value.steeringExcluded, value.awaited].every(
      (flag) => flag === undefined || typeof flag === "boolean"
    ) ||
    ![value.scheduleId, value.scheduleDeliveryId].every(
      (id) => id === undefined || typeof id === "string"
    )
  )
    return false;
  switch (value.source) {
    case "chat":
      return (
        typeof value.chatMessageId === "string" &&
        (value.chatMessageIds === undefined ||
          (Array.isArray(value.chatMessageIds) &&
            value.chatMessageIds.every((id) => typeof id === "string"))) &&
        (value.answerIn === undefined || typeof value.answerIn === "string")
      );
    case "agent":
      return (
        typeof value.senderId === "string" &&
        typeof value.senderName === "string" &&
        typeof value.text === "string"
      );
    case "system":
      return typeof value.text === "string";
    case "engine":
      return (
        typeof value.text === "string" &&
        (value.after === undefined || typeof value.after === "string")
      );
    default:
      return false;
  }
}

function isPromptImage(value: unknown): value is PromptImage {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.mimeType === "string"
  );
}

function isPromptInput(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    (value.source === undefined || isPromptSource(value.source))
  );
}

export function sessionCommandId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === "string" ? value.id : undefined;
}

function isSessionCommand(value: unknown): value is SessionCommand {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "hello":
      return (
        isSequence(value.fromSeq) &&
        (value.journalId === undefined || isNullableString(value.journalId)) &&
        (value.replayComplete === undefined ||
          typeof value.replayComplete === "boolean")
      );
    case "prompt":
      return (
        isPromptInput(value) &&
        (value.journalId === undefined ||
          typeof value.journalId === "string") &&
        (value.images === undefined ||
          (Array.isArray(value.images) && value.images.every(isPromptImage)))
      );
    case "steer":
      return isPromptInput(value);
    case "interrupt":
      return typeof value.id === "string" && isSequence(value.turnSeq);
    case "answer_permission":
      return (
        typeof value.id === "string" &&
        typeof value.requestId === "string" &&
        isNullableString(value.optionId)
      );
    case "set_config":
      return (
        typeof value.id === "string" &&
        typeof value.configId === "string" &&
        typeof value.value === "string"
      );
    case "shutdown":
      return value.force === undefined || typeof value.force === "boolean";
    case "mcp_inventory":
    case "background_work":
      return (
        typeof value.id === "string" && typeof value.sessionId === "string"
      );
    case "cancel":
    case "ping":
      return true;
    default:
      return false;
  }
}

export function parseSessionCommand(value: unknown): SessionCommand | null {
  return isSessionCommand(value) ? value : null;
}
