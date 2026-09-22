/**
 * What a prompt sent to the harness was, for the prompt a turn entry
 * renders. The wire text is an envelope Dispatch built; the feed wants the
 * human-facing source behind it, not the envelope.
 */
export type PromptSource =
  | {
      source: "chat";
      /** The post that opened the turn: the first, when there were several. */
      chatMessageId: string;
      /**
       * Every post the turn was given, in order, when posts that queued up
       * behind a turn were delivered to it together.
       */
      chatMessageIds?: string[];
    }
  | { source: "agent"; senderId: string; senderName: string; text: string }
  | { source: "system"; text: string };

// The id has to be the strict UUID shape, not 36 characters of the same
// alphabet: it is read back through a `::uuid[]` cast, and a value Postgres
// rejects there turns every later read of that agent's turns into a 500. The
// header is matched on every prompt that reaches the queue, and review
// injection prompts embed feedback bodies verbatim, so the text is not
// always Dispatch's own. The sender label may itself hold parentheses
// (`Name (agt_x)`), so it is matched lazily up to the closing marker.
const CHAT_HEADER =
  /^--- DISPATCH POST \(id: ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:, from: [^\n]*?)?\) ---/m;
const SYSTEM_MAX = 500;

export function parsePromptSource(text: string): PromptSource {
  const chat = CHAT_HEADER.exec(text);
  if (chat) return { source: "chat", chatMessageId: chat[1] };
  return { source: "system", text: text.slice(0, SYSTEM_MAX) };
}

/** A prompt waiting its turn in the supervisor's queue, as routes read it. */
export type QueuedPrompt = {
  /** The chat message id for a chat prompt; otherwise a queue-local id. */
  id: string;
  source: PromptSource;
  createdAt: string;
};
