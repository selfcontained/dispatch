import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerStreamTools } from "../src/shared/mcp/stream-tools.js";

type Registered = {
  name: string;
  config: { description: string; inputSchema: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
};

type Schema = { safeParse: (v: unknown) => { success: boolean } };

function createMockServer() {
  const tools: Registered[] = [];
  return {
    registerTool: vi.fn((name, config, handler) => {
      tools.push({ name, config, handler });
    }),
    tools,
  };
}

const AGENT_ID = "agt_stream_tools";
const ALL = new Set(["post", "update", "react"]);
const BLOCK = "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const OTHER = "0f9e8d7c-6b5a-4433-8211-000011112222";

describe("registerStreamTools", () => {
  let server: ReturnType<typeof createMockServer>;
  let post: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let addReaction: ReturnType<typeof vi.fn>;
  let removeReaction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    server = createMockServer();
    post = vi.fn(async (_agentId: string, input: { kind?: string }) => ({
      id: BLOCK,
      kind: input.kind ?? "text",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    update = vi.fn(async () => ({
      id: BLOCK,
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));
    const reactions = {
      blockId: OTHER,
      reactions: [
        {
          id: "r1",
          author: { kind: "user" },
          emoji: "🎉",
          delivered: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "r2",
          author: { kind: "agent", agentId: AGENT_ID },
          emoji: "👍",
          delivered: null,
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    };
    addReaction = vi.fn(async () => reactions);
    removeReaction = vi.fn(async () => ({ blockId: OTHER, reactions: [] }));
    registerStreamTools(server as never, ALL, {
      agentId: AGENT_ID,
      streams: { post, update, addReaction, removeReaction } as never,
    });
  });

  function tool(name: string): Registered {
    const found = server.tools.find((t) => t.name === name);
    if (!found) throw new Error(`tool ${name} not registered`);
    return found;
  }

  it("registers the tools only when allowed and a service is present", () => {
    expect(server.tools.map((t) => t.name)).toEqual(["post", "update", "react"]);
    const none = createMockServer();
    registerStreamTools(none as never, ALL, { agentId: AGENT_ID });
    expect(none.tools).toHaveLength(0);
    const onlyPost = createMockServer();
    registerStreamTools(onlyPost as never, new Set(["post", "chat_post"]), {
      agentId: AGENT_ID,
      streams: { post, update } as never,
    });
    expect(onlyPost.tools.map((t) => t.name)).toEqual(["post"]);
  });

  it("describes post as the one verb: to, kinds, replyTo and notify", () => {
    const description = tool("post").config.description;
    expect(description).toContain("`to: <agentId>`");
    expect(description).toContain("`question`");
    expect(description).toContain("`form`");
    expect(description).toContain("`link`");
    expect(description).toContain("`review`");
    expect(description).toContain("`tasks`");
    expect(description).toContain("replyTo");
    expect(description).toContain("DISPATCH POST envelope");
    expect(description).toContain("`notify: true`");
    expect(description).not.toMatch(/chat_post|share_file|chat_update/);
    expect(Object.keys(tool("post").config.inputSchema)).toEqual([
      "to",
      "text",
      "replyTo",
      "question",
      "form",
      "link",
      "review",
      "tasks",
      "attachments",
      "notify",
    ]);
    expect(Object.keys(tool("update").config.inputSchema)).toEqual([
      "id",
      "text",
      "data",
      "state",
      "attachments",
    ]);
    expect(Object.keys(tool("react").config.inputSchema)).toEqual([
      "id",
      "emoji",
      "remove",
    ]);
  });

  it("posts plain text with every optional field normalized to null or empty", async () => {
    const result = await tool("post").handler({ text: "done" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      id: BLOCK,
      kind: "text",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.content[0]?.text).toBe(
      JSON.stringify(result.structuredContent)
    );
    expect(post).toHaveBeenCalledWith(AGENT_ID, {
      to: null,
      text: "done",
      replyTo: null,
      question: null,
      form: null,
      link: null,
      review: null,
      tasks: null,
      attachments: [],
      notify: undefined,
    });
  });

  it("forwards to, replyTo, notify and each typed payload as given", async () => {
    const question = {
      options: [{ label: "Yes", value: "y" }, { label: "No" }],
      allowFreeform: true,
    };
    await tool("post").handler({
      to: "agt_other",
      text: "Ship?",
      replyTo: OTHER,
      question,
      notify: true,
    });
    expect(post).toHaveBeenLastCalledWith(
      AGENT_ID,
      expect.objectContaining({
        to: "agt_other",
        text: "Ship?",
        replyTo: OTHER,
        question,
        notify: true,
      })
    );
    const form = {
      title: "Details",
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
        {
          id: "size",
          label: "Size",
          type: "select",
          options: [{ label: "S" }, { label: "M" }],
        },
      ],
    };
    await tool("post").handler({ form });
    expect(post).toHaveBeenLastCalledWith(
      AGENT_ID,
      expect.objectContaining({ form, question: null })
    );
    const review = {
      verdict: "request_changes",
      summary: "Two things",
      findings: [
        { id: "f1", severity: "major", title: "Leak", body: "…", path: "a.ts", line: 3 },
      ],
    };
    await tool("post").handler({ to: "agt_builder", review });
    expect(post).toHaveBeenLastCalledWith(
      AGENT_ID,
      expect.objectContaining({ to: "agt_builder", review })
    );
    const tasks = { items: [{ id: "t1", text: "Write tests" }] };
    await tool("post").handler({ tasks });
    expect(post).toHaveBeenLastCalledWith(
      AGENT_ID,
      expect.objectContaining({ tasks })
    );
    const link = { url: "https://example.com/pr/1", title: "PR" };
    await tool("post").handler({ link });
    expect(post).toHaveBeenLastCalledWith(
      AGENT_ID,
      expect.objectContaining({ link })
    );
    const attachments = [
      { type: "file", path: "/tmp/shot.png", description: "the shot" },
      { type: "code", code: "let x = 1", language: "ts", path: "a.ts" },
    ];
    await tool("post").handler({ text: "see", attachments });
    expect(post).toHaveBeenLastCalledWith(
      AGENT_ID,
      expect.objectContaining({ attachments })
    );
  });

  it("returns the kind the service resolved", async () => {
    post.mockResolvedValueOnce({
      id: BLOCK,
      kind: "question",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const result = await tool("post").handler({
      question: { options: [{ label: "a" }] },
    });
    expect(result.structuredContent?.kind).toBe("question");
  });

  it("surfaces service errors (e.g. unknown file) as tool errors", async () => {
    post.mockRejectedValueOnce(new Error('Unknown file "x.png"'));
    const result = await tool("post").handler({
      text: "see",
      attachments: [{ type: "file", fileName: "x.png" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown file");
  });

  it("declares file attachments by path, fileName or mediaId", () => {
    const schema = tool("post").config.inputSchema.attachments as Schema;
    expect(
      schema.safeParse([{ type: "file", path: "/tmp/a.png" }]).success
    ).toBe(true);
    expect(
      schema.safeParse([{ type: "file", fileName: "a.png" }]).success
    ).toBe(true);
    expect(schema.safeParse([{ type: "file", mediaId: 3 }]).success).toBe(true);
    expect(schema.safeParse([{ type: "file", mediaId: 0 }]).success).toBe(false);
    expect(schema.safeParse([{ type: "link", url: "https://x" }]).success).toBe(true);
    expect(schema.safeParse([{ type: "link", url: "javascript:1" }]).success).toBe(false);
    expect(schema.safeParse([{ type: "pr", url: "https://gh/1" }]).success).toBe(true);
    expect(schema.safeParse([{ type: "pin", pinId: "pin_1" }]).success).toBe(true);
    expect(schema.safeParse([{ type: "pin" }]).success).toBe(false);
    expect(schema.safeParse([{ type: "code", code: "" }]).success).toBe(false);
    expect(schema.safeParse([{ type: "image", url: "x" }]).success).toBe(false);
    expect(
      schema.safeParse(
        Array.from({ length: 21 }, () => ({ type: "link", url: "https://x" }))
      ).success
    ).toBe(false);
  });

  it("bounds the typed payloads at the schema", () => {
    const input = tool("post").config.inputSchema;
    const question = input.question as Schema;
    expect(question.safeParse({ options: [] }).success).toBe(false);
    expect(
      question.safeParse({
        options: Array.from({ length: 11 }, (_, i) => ({ label: `o${i}` })),
      }).success
    ).toBe(false);
    expect(question.safeParse({ options: [{ label: "" }] }).success).toBe(false);
    const form = input.form as Schema;
    expect(form.safeParse({ fields: [] }).success).toBe(false);
    expect(
      form.safeParse({ fields: [{ id: "a", label: "A", type: "date" }] })
        .success
    ).toBe(false);
    const review = input.review as Schema;
    expect(
      review.safeParse({ verdict: "lgtm", summary: "s", findings: [] }).success
    ).toBe(false);
    expect(
      review.safeParse({
        verdict: "approve",
        summary: "s",
        findings: [{ id: "f", severity: "huge", title: "t", body: "b" }],
      }).success
    ).toBe(false);
    expect(
      review.safeParse({ verdict: "approve", summary: "s", findings: [] })
        .success
    ).toBe(true);
    const tasks = input.tasks as Schema;
    expect(tasks.safeParse({ items: [] }).success).toBe(false);
    expect(tasks.safeParse({ items: [{ id: "t", text: "x" }] }).success).toBe(true);
    expect((input.replyTo as Schema).safeParse("not-a-uuid").success).toBe(false);
    expect((input.text as Schema).safeParse("x".repeat(20_001)).success).toBe(false);
  });

  it("updates a block and returns id + updatedAt", async () => {
    const result = await tool("update").handler({
      id: BLOCK,
      text: "final",
      state: { items: { t1: "done" } },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      id: BLOCK,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(update).toHaveBeenCalledWith(AGENT_ID, BLOCK, {
      text: "final",
      data: undefined,
      state: { items: { t1: "done" } },
      attachments: undefined,
    });
    expect(tool("update").config.description).toContain("addressed to you");
    expect(tool("update").config.description).toContain(
      '{ state: { findings: { <id>: "resolved" } } }'
    );
  });

  it("returns a tool error when the update is rejected", async () => {
    update.mockRejectedValueOnce(new Error("Block not found."));
    const result = await tool("update").handler({ id: BLOCK, text: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Block not found.");
  });

  it("reacts as the agent and returns the block's reactions", async () => {
    const result = await tool("react").handler({ id: OTHER, emoji: "👍" });
    expect(addReaction).toHaveBeenCalledWith(AGENT_ID, OTHER, "👍", {
      kind: "agent",
      agentId: AGENT_ID,
    });
    expect(result.structuredContent).toEqual({
      blockId: OTHER,
      reactions: [
        expect.objectContaining({ emoji: "🎉" }),
        expect.objectContaining({ emoji: "👍" }),
      ],
    });
    expect(tool("react").config.description).toContain(
      "DISPATCH POST envelope"
    );
    expect(tool("react").config.description).toContain("remove: true");
  });

  it("takes a reaction back with remove: true, and surfaces service errors", async () => {
    const removed = await tool("react").handler({
      id: OTHER,
      emoji: "👍",
      remove: true,
    });
    expect(removeReaction).toHaveBeenCalledWith(AGENT_ID, OTHER, "👍", {
      kind: "agent",
      agentId: AGENT_ID,
    });
    expect(addReaction).not.toHaveBeenCalled();
    expect(removed.structuredContent).toEqual({ blockId: OTHER, reactions: [] });

    addReaction.mockRejectedValueOnce(new Error("Block not found"));
    const failed = await tool("react").handler({ id: OTHER, emoji: "👍" });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]?.text).toBe("Block not found");
  });
});
