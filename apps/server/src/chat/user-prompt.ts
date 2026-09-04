/**
 * Prompts the user fires from a UI control rather than typing into the Chat
 * composer: a quick phrase, a shortcut pin. They inject the same kind of
 * thing a composed message does — the user's words, addressed to the agent —
 * so with the Chat surface on they take the same path: a user row, the
 * envelope carrying its id, and a post in the feed the agent's reply can
 * thread onto. See docs/chat-surface-plan.md, "Injection envelope".
 */

export type UserPromptRouting = {
  /** Whether the Chat surface is switched on for this installation. */
  chatSurfaceEnabled: boolean;
  /**
   * The target agent's type. Only `"terminal"` is excluded; an older row
   * with no type is a CLI agent like any other. A caller that could not
   * find the agent at all does not reach here — it keeps the pane path so
   * its own 404 stands.
   */
  agentType: string | null | undefined;
  /**
   * Whether the prompt is being submitted. A quick phrase pasted for the
   * user to edit first (`submit: false`) is not a message yet — there is
   * nothing to post, and the text still has to land in the pane's composer.
   */
  submit: boolean;
};

/**
 * Whether a user-fired prompt goes out as a Chat message instead of straight
 * into the pane. Everything this decision needs is in `UserPromptRouting`, so
 * the rule lives in one place rather than being restated at each route.
 *
 * A terminal session is excluded for the same reason it gets no launch post:
 * there is no CLI behind it to read the envelope or to answer with
 * `dispatch_chat_post`, so the envelope would be noise in the pane.
 */
export function routesUserPromptThroughChat(
  routing: UserPromptRouting
): boolean {
  if (!routing.chatSurfaceEnabled) return false;
  if (!routing.submit) return false;
  return routing.agentType !== "terminal";
}

/** What `deliverUserPrompt` needs; a subset of the agent routes' deps. */
export type UserPromptDeps = {
  isChatSurfaceEnabled: () => Promise<boolean>;
  getAgent: (agentId: string) => Promise<{ type?: string | null } | null>;
  sendUserMessage: (agentId: string, text: string) => Promise<unknown>;
};

/**
 * Deliver a prompt the user fired from a UI control, returning whether Chat
 * took it. `false` means the caller writes to the pane itself, which is all
 * that ever happened before the surface existed.
 *
 * The failure modes line up with the pane path's on purpose: an agent with
 * no live session makes `sendUserMessage` throw before any row is written,
 * so a click that could not be delivered leaves nothing behind in the feed.
 */
export async function deliverUserPrompt(
  deps: UserPromptDeps,
  agentId: string,
  text: string,
  submit: boolean
): Promise<boolean> {
  if (!(await deps.isChatSurfaceEnabled())) return false;
  // A missing agent keeps the pane path so the route's own 404 stands.
  const agent = await deps.getAgent(agentId).catch(() => null);
  if (!agent) return false;
  if (
    !routesUserPromptThroughChat({
      chatSurfaceEnabled: true,
      agentType: agent.type,
      submit,
    })
  ) {
    return false;
  }
  await deps.sendUserMessage(agentId, text);
  return true;
}
