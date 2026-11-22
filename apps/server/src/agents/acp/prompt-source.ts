import type { PromptImage as WirePromptImage } from "@dispatch/runner-protocol";

/** Host-side attachment reference. A runner name marks an input to stage before ACP submission. */
export type PromptImage = WirePromptImage & { runnerName?: string };

export function isPromptImageMimeType(mimeType: string): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
    mimeType
  );
}

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
  /** An answer to a specific question or form in the source conversation. */
  correlatedReply?: true;
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

export function isPromptSource(value: unknown): value is PromptSource {
  if (!isSourceRecord(value)) return false;
  const { conversation } = value;
  if (
    conversation !== undefined &&
    (!isSourceRecord(conversation) ||
      typeof conversation.streamId !== "string" ||
      (conversation.threadId !== null &&
        typeof conversation.threadId !== "string"))
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

function isSourceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SYSTEM_MAX = 500;

/** An internal prompt's turn source; never infer a chat post from its text. */
export function systemPromptSource(text: string): PromptSource {
  return { source: "system", text: text.slice(0, SYSTEM_MAX) };
}

/** A prompt waiting its turn in the supervisor's queue, as routes read it. */
export type QueuedPrompt = {
  /** The chat message id for a chat prompt; otherwise a queue-local id. */
  id: string;
  source: PromptSource;
  createdAt: string;
};

export type PromptOptions = {
  alone?: boolean;
  /** Checked immediately before submission, including queued release. */
  beforeSubmit?: () => Promise<boolean>;
  /** A steering attempt was definitively declined and is now queued. */
  onDeferred?: () => Promise<void>;
  signal?: AbortSignal;
  images?: PromptImage[];
  delivery?: "auto" | "queue" | "interrupt";
};
