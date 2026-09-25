// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { STREAM_ID, turnBlock } from "@/test-utils/blocks";

import { blockAuthor, type FeedContext } from "./chat-entries";

const ctx: FeedContext = {
  agentId: STREAM_ID,
  onOpenFile: () => {},
  agentName: "builder",
  agentType: "claude",
  // The agent runs Sonnet now.
  agentModel: "sonnet",
  modelLabel: (_type, model) =>
    ({ sonnet: "Sonnet 5", haiku: "Haiku 4.5" })[model] ?? model,
};

describe("blockAuthor", () => {
  it("labels a turn with the model it ran on, not the agent's current one", () => {
    const earlier = blockAuthor(turnBlock({ turn: { model: "haiku" } }), ctx);
    expect(earlier.model).toBe("haiku");
    expect(earlier.modelLabel).toBe("Haiku 4.5");
  });

  it("falls back to the agent's model for a turn that recorded none", () => {
    const author = blockAuthor(turnBlock(), ctx);
    expect(author.model).toBe("sonnet");
    expect(author.modelLabel).toBe("Sonnet 5");
  });
});
