import { mentionSpans } from "@/lib/mentions";
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { STREAM_ID, block, turnBlock } from "@/test-utils/blocks";

import {
  historicalMentionablesOf,
  blockAuthor,
  type FeedContext,
} from "./chat-entries";

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

describe("historical mentions", () => {
  const peer = { name: "Peer", agentType: "codex", relation: "agent" as const };
  const post = block({
    author: { kind: "user" },
    text: "@Peer [external] help",
    body: { kind: "text", data: { mentions: ["external"] }, state: null },
  });
  it("keeps a recorded external mention after the session stops or is archived", () => {
    const directories: Array<Pick<FeedContext, "peers" | "names">> = [
      { peers: { external: { ...peer, mentionable: true } } },
      { peers: { external: peer } },
      { peers: {}, names: { external: "Peer" } },
    ];
    for (const directory of directories) {
      const spans = mentionSpans(
        post.text,
        historicalMentionablesOf(post, { ...ctx, ...directory })
      );
      expect(spans[0]).toMatchObject({
        kind: "mention",
        agent: { id: "external" },
      });
    }
  });
  it("does not highlight old unaddressed text when another session starts", () => {
    const unaddressed = block({
      author: { kind: "user" },
      text: "@Peer is just text",
    });
    expect(
      mentionSpans(
        unaddressed.text,
        historicalMentionablesOf(unaddressed, {
          ...ctx,
          peers: { external: { ...peer, mentionable: true } },
        })
      )
    ).toEqual([{ kind: "text", text: unaddressed.text }]);
  });
});
