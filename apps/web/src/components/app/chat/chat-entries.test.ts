import { mentionSpans } from "@/lib/mentions";
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { STREAM_ID, block, turnBlock } from "@/test-utils/blocks";

import {
  historicalMentionablesOf,
  blockRecipients,
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
  it("renders trusted system authors without agent metadata", () => {
    expect(
      blockAuthor(block({ author: { kind: "system" }, text: "Notice" }), ctx)
    ).toEqual({ key: "system", kind: "system", name: "Dispatch system" });
  });
  it("does not reinterpret legacy or agent-authored notice text", () => {
    const message = block({
      author: { kind: "agent", agentId: STREAM_ID },
      text: "Dispatch system: tracked PR status changed Open → Merged",
    });
    expect(blockAuthor(message, ctx).kind).toBe("agent");
    expect(
      blockAuthor(
        block({ author: { kind: "user" }, text: "Dispatch system: hello" }),
        ctx
      ).kind
    ).toBe("user");
  });
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

describe("task card recipients", () => {
  it("reads task card thread recipients and recorded mentions", () => {
    const card = block({
      author: { kind: "user" },
      body: {
        kind: "task",
        data: {
          taskId: "tsk_012345abcdef",
          recipients: ["builder", "reviewer"],
        },
        state: null,
      },
    });
    expect(blockRecipients(card)).toEqual(["builder", "reviewer"]);
    const mentioned = block({
      author: { kind: "user" },
      body: {
        kind: "task",
        data: { taskId: "tsk_012345abcdef", mentions: ["external"] },
        state: null,
      },
    });
    expect(blockRecipients(mentioned)).toEqual(["external"]);
    expect(
      historicalMentionablesOf(mentioned, {
        ...ctx,
        names: { external: "Former reviewer" },
      })[0]
    ).toMatchObject({ id: "external", name: "Former reviewer" });
  });
});

describe("historical silent references", () => {
  it.each(["Review", "Review fix"])(
    "keeps mixed-mode identity with an external %s collision",
    (externalName) => {
      const text = `@${externalName} [external] compare !@Review fix the test`;
      const post = block({
        author: { kind: "user" },
        text,
        body: {
          kind: "text",
          data: { mentions: ["external"], references: [STREAM_ID] },
          state: null,
        },
      });
      const spans = mentionSpans(
        text,
        historicalMentionablesOf(post, {
          ...ctx,
          agentName: "Review",
          names: { external: externalName },
        })
      ).filter((span) => span.kind === "mention");
      expect(spans).toMatchObject([
        { text: `@${externalName} [external]`, agent: { id: "external" } },
        { text: "!@Review", silent: true, agent: { id: STREAM_ID } },
      ]);
    }
  );

  it("keeps a reference-only archived agent as a chip with its exact identity", () => {
    const post = block({
      author: { kind: "user" },
      text: "!@Former peer [archived]",
      body: { kind: "text", data: { references: ["archived"] }, state: null },
    });
    expect(
      mentionSpans(
        post.text,
        historicalMentionablesOf(post, {
          ...ctx,
          peers: {},
          names: { archived: "Former peer" },
        })
      )
    ).toMatchObject([
      {
        kind: "mention",
        silent: true,
        agent: { id: "archived", name: "Former peer" },
      },
    ]);
  });

  it("allows the same identity to be both mentioned and referenced", () => {
    const post = block({
      author: { kind: "user" },
      text: "@builder and !@builder",
      body: {
        kind: "text",
        data: { mentions: [STREAM_ID], references: [STREAM_ID] },
        state: null,
      },
    });
    const spans = mentionSpans(post.text, historicalMentionablesOf(post, ctx));
    expect(spans.filter((span) => span.kind === "mention")).toMatchObject([
      { agent: { id: STREAM_ID } },
      { silent: true, agent: { id: STREAM_ID } },
    ]);
  });
});
