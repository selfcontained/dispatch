import { describe, expect, it, vi } from "vitest";

import {
  deliverUserPrompt,
  routesUserPromptThroughChat,
} from "../src/chat/user-prompt.js";

describe("routesUserPromptThroughChat", () => {
  const base = {
    chatSurfaceEnabled: true,
    agentType: "claude" as string | null | undefined,
    submit: true,
  };

  it("sends a submitted prompt through Chat when the surface is on", () => {
    expect(routesUserPromptThroughChat(base)).toBe(true);
  });

  it("keeps the pane path with the surface off", () => {
    // Nothing about these controls changes until the flag is on.
    expect(
      routesUserPromptThroughChat({ ...base, chatSurfaceEnabled: false })
    ).toBe(false);
  });

  it("keeps the pane path for a phrase pasted to be edited", () => {
    // `submit: false` puts text in the CLI's composer for the user to finish;
    // there is no message yet, so there is nothing to post.
    expect(routesUserPromptThroughChat({ ...base, submit: false })).toBe(false);
  });

  it("keeps the pane path for a terminal session", () => {
    // No CLI behind it to read the envelope or answer with dispatch_chat_post.
    expect(
      routesUserPromptThroughChat({ ...base, agentType: "terminal" })
    ).toBe(false);
  });

  it("treats a typeless agent as chat-capable", () => {
    // Only a terminal session is excluded; an older row with no type is a
    // CLI agent like any other.
    expect(routesUserPromptThroughChat({ ...base, agentType: null })).toBe(
      true
    );
    expect(routesUserPromptThroughChat({ ...base, agentType: undefined })).toBe(
      true
    );
  });
});

describe("deliverUserPrompt", () => {
  function fakeDeps(
    overrides: {
      chatSurfaceEnabled?: boolean;
      agent?: { type?: string | null } | null;
      getAgentRejects?: boolean;
    } = {}
  ) {
    const sendUserMessage = vi.fn(async () => ({}));
    return {
      sendUserMessage,
      deps: {
        isChatSurfaceEnabled: async () => overrides.chatSurfaceEnabled ?? true,
        getAgent: async () => {
          if (overrides.getAgentRejects) throw new Error("boom");
          return overrides.agent === undefined
            ? { type: "claude" }
            : overrides.agent;
        },
        sendUserMessage,
      },
    };
  }

  it("sends the prompt as a Chat message and reports it delivered", async () => {
    const { deps, sendUserMessage } = fakeDeps();
    await expect(
      deliverUserPrompt(deps, "agt_1", "run the tests", true)
    ).resolves.toBe(true);
    // The user's words, verbatim: the service wraps them in the envelope.
    expect(sendUserMessage).toHaveBeenCalledWith("agt_1", "run the tests");
  });

  it("leaves it to the pane when the surface is off", async () => {
    const { deps, sendUserMessage } = fakeDeps({ chatSurfaceEnabled: false });
    await expect(
      deliverUserPrompt(deps, "agt_1", "run the tests", true)
    ).resolves.toBe(false);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("leaves it to the pane for a terminal session", async () => {
    const { deps, sendUserMessage } = fakeDeps({ agent: { type: "terminal" } });
    await expect(
      deliverUserPrompt(deps, "agt_1", "run the tests", true)
    ).resolves.toBe(false);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("leaves it to the pane when the phrase is not being submitted", async () => {
    const { deps, sendUserMessage } = fakeDeps();
    await expect(
      deliverUserPrompt(deps, "agt_1", "half a thought", false)
    ).resolves.toBe(false);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("leaves it to the pane for an agent it cannot read", async () => {
    // The route's own lookup answers with 404/409; Chat must not pre-empt it.
    for (const overrides of [{ agent: null }, { getAgentRejects: true }]) {
      const { deps, sendUserMessage } = fakeDeps(overrides);
      await expect(
        deliverUserPrompt(deps, "agt_missing", "run the tests", true)
      ).resolves.toBe(false);
      expect(sendUserMessage).not.toHaveBeenCalled();
    }
  });

  it("propagates a refused send so the route can map its status", async () => {
    const sendUserMessage = vi.fn(async () => {
      throw new Error("Agent is not running.");
    });
    const deps = {
      isChatSurfaceEnabled: async () => true,
      getAgent: async () => ({ type: "claude" }),
      sendUserMessage,
    };
    await expect(
      deliverUserPrompt(deps, "agt_1", "run the tests", true)
    ).rejects.toThrow(/not running/);
  });
});
