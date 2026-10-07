import type { PromptConversation } from "@dispatch/shared";

/**
 * What a prompt sent to the harness was, for the prompt a turn entry
 * renders. The wire text is an envelope Dispatch built; the feed wants the
 * human-facing source behind it, not the envelope.
 */
export type PromptSource = {
  /** Server-resolved answer location, retained through the host journal. */
  conversation?: PromptConversation;
  /**
   * A person's post. With a conversation, a prompt steers only that
   * conversation; another agent's post without one steers any open turn.
   */
  userMessage?: boolean;
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
);

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

/** Server-resolved files, kept out of turn journals and encoded only for ACP. */
export type PromptImage = { path: string; mimeType: string };
export type PromptOptions = {
  alone?: boolean;
  images?: PromptImage[];
  delivery?: "auto" | "queue" | "interrupt";
};
