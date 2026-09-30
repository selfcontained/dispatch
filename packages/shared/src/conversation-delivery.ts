/** A conversation is the stream root or one exact thread in it. */
export type PromptConversation = { streamId: string; threadId: string | null };

export function sameConversation(
  left: PromptConversation | null | undefined,
  right: PromptConversation | null | undefined
): boolean {
  return (
    !!left &&
    !!right &&
    left.streamId === right.streamId &&
    left.threadId === right.threadId
  );
}

/** Live supervisor state, rather than a guess from persisted turn rows. */
export type AgentInputState = {
  active: boolean;
  steeringSupported: boolean;
  /** Absent for hosts predating safe targeted cancellation. */
  interruptSupported?: boolean;
  conversation: PromptConversation | null;
};
