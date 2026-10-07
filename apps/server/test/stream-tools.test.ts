import { beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
const ALL = new Set(["post", "update", "react", "get_review"]);
const BLOCK = "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const OTHER = "0f9e8d7c-6b5a-4433-8211-000011112222";

describe("registerStreamTools", () => {
  let server: ReturnType<typeof createMockServer>;
  let post: ReturnType<typeof vi.fn>;
  let getReview: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let addReaction: ReturnType<typeof vi.fn>;
  let removeReaction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    server = createMockServer();
    getReview = vi.fn(async () => ({
      id: BLOCK,
      summary: "Clean",
      findings: [],
    }));
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
      streams: {
        post,
        update,
        getReview,
        addReaction,
        removeReaction,
      } as never,
    });
  });

  function tool(name: string): Registered {
    const found = server.tools.find((t) => t.name === name);
    if (!found) throw new Error(`tool ${name} not registered`);
    return found;
  }

  function shape(name: string): Record<string, Schema> {
    return (
      tool(name).config.inputSchema as unknown as {
        shape: Record<string, Schema>;
      }
    ).shape;
  }

  it("registers the tools only when allowed and a service is present", () => {
    expect(server.tools.map((t) => t.name)).toEqual([
      "get_review",
      "post",
      "update",
      "react",
    ]);
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

  it("fetches the latest review or an explicit id within the calling agent's scope", async () => {
    const latest = await tool("get_review").handler({});
    expect(getReview).toHaveBeenCalledWith(AGENT_ID, undefined);
    expect(latest.structuredContent).toEqual({
      id: BLOCK,
      summary: "Clean",
      findings: [],
    });
    await tool("get_review").handler({ id: BLOCK });
    expect(getReview).toHaveBeenLastCalledWith(AGENT_ID, BLOCK);
    const schema = tool("get_review").config.inputSchema.id as Schema;
    expect(schema.safeParse("not-a-uuid").success).toBe(false);
  });

  it("returns a useful error when a review cannot be fetched", async () => {
    getReview.mockRejectedValueOnce(new Error("Review not found."));
    expect(await tool("get_review").handler({ id: BLOCK })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Review not found." }],
    });
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
    expect(Object.keys(shape("post"))).toEqual([
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
      "delivery",
    ]);
    expect(Object.keys(shape("update"))).toEqual([
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
        {
          id: "f1",
          severity: "major",
          title: "Leak",
          body: "…",
          path: "a.ts",
          line: 3,
        },
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

  it("declares file attachments by path, fileName or fileId", () => {
    const schema = shape("post").attachments;
    expect(
      schema.safeParse([{ type: "file", path: "/tmp/a.png" }]).success
    ).toBe(true);
    expect(
      schema.safeParse([{ type: "file", fileName: "a.png" }]).success
    ).toBe(true);
    expect(schema.safeParse([{ type: "file", fileId: 3 }]).success).toBe(true);
    expect(schema.safeParse([{ type: "file", fileId: 0 }]).success).toBe(false);
    expect(schema.safeParse([{ type: "link", url: "https://x" }]).success).toBe(
      true
    );
    expect(
      schema.safeParse([{ type: "link", url: "javascript:1" }]).success
    ).toBe(false);
    expect(
      schema.safeParse([{ type: "pr", url: "https://gh/1" }]).success
    ).toBe(true);
    expect(schema.safeParse([{ type: "pin", pinId: "pin_1" }]).success).toBe(
      false
    );
    expect(schema.safeParse([{ type: "code", code: "" }]).success).toBe(false);
    expect(schema.safeParse([{ type: "image", url: "x" }]).success).toBe(false);
    expect(
      schema.safeParse(
        Array.from({ length: 21 }, () => ({ type: "link", url: "https://x" }))
      ).success
    ).toBe(false);
  });

  it("bounds the typed payloads at the schema", () => {
    const input = shape("post");
    const question = input.question as Schema;
    expect(question.safeParse({ options: [] }).success).toBe(false);
    expect(
      question.safeParse({
        options: Array.from({ length: 11 }, (_, i) => ({ label: `o${i}` })),
      }).success
    ).toBe(false);
    expect(question.safeParse({ options: [{ label: "" }] }).success).toBe(
      false
    );
    const form = input.form as Schema;
    expect(form.safeParse({ fields: [] }).success).toBe(false);
    expect(
      form.safeParse({ fields: [{ id: "a", label: "A", type: "date" }] })
        .success
    ).toBe(false);
    const review = input.review as Schema;
    // A review is its summary and its findings: no verdict, and a finding
    // is given no id by its author (it becomes a block with one).
    expect(review.safeParse({ findings: [] }).success).toBe(false);
    expect(review.safeParse({ summary: "", findings: [] }).success).toBe(false);
    expect(
      review.safeParse({
        summary: "s",
        findings: [{ severity: "huge", title: "t", body: "b" }],
      }).success
    ).toBe(false);
    expect(
      review.safeParse({
        summary: "s",
        findings: [{ severity: "minor", title: "", body: "b" }],
      }).success
    ).toBe(false);
    expect(review.safeParse({ summary: "s", findings: [] }).success).toBe(true);
    expect(
      review.safeParse({
        summary: "s",
        findings: [
          { severity: "major", title: "t", body: "b", path: "a.ts", line: 3 },
        ],
      }).success
    ).toBe(true);
    const tasks = input.tasks as Schema;
    expect(tasks.safeParse({ items: [] }).success).toBe(false);
    expect(tasks.safeParse({ items: [{ id: "t", text: "x" }] }).success).toBe(
      true
    );
    expect((input.replyTo as Schema).safeParse("not-a-uuid").success).toBe(
      false
    );
    expect((input.text as Schema).safeParse("x".repeat(20_001)).success).toBe(
      false
    );
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
      'resolve a finding you raised, by its id: { state: { status: "fixed" } }'
    );
    expect(tool("update").config.description).not.toContain("findings:");
  });

  it("returns a review's finding ids with the post", async () => {
    const F1 = "11111111-2222-4333-8444-555555555555";
    const F2 = "22222222-2222-4333-8444-555555555555";
    post.mockResolvedValueOnce({
      id: BLOCK,
      kind: "review",
      createdAt: "2026-01-01T00:00:00.000Z",
      blocks: [
        { id: F1, kind: "finding", data: { title: "One" } },
        { id: F2, kind: "finding", data: { title: "Two" } },
      ],
    });
    const review = {
      summary: "Two things.",
      findings: [
        { severity: "major", title: "One", body: "b" },
        { severity: "nit", title: "Two", body: "b" },
      ],
    };
    const result = await tool("post").handler({ to: "agt_builder", review });
    expect(result.structuredContent).toEqual({
      id: BLOCK,
      kind: "review",
      createdAt: "2026-01-01T00:00:00.000Z",
      findings: [
        { id: F1, title: "One" },
        { id: F2, title: "Two" },
      ],
    });
    expect(post).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ to: "agt_builder", review })
    );
    expect(tool("update").config.description).toContain(
      "{ state: { cancellation: true } }"
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
    expect(removed.structuredContent).toEqual({
      blockId: OTHER,
      reactions: [],
    });

    addReaction.mockRejectedValueOnce(new Error("Block not found"));
    const failed = await tool("react").handler({ id: OTHER, emoji: "👍" });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]?.text).toBe("Block not found");
  });
});

describe("post and update reject fields they do not declare", () => {
  const post = vi.fn(async () => ({
    id: BLOCK,
    kind: "question",
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  const update = vi.fn(async () => ({
    id: BLOCK,
    updatedAt: "2026-01-02T00:00:00.000Z",
  }));

  // Through a real client and server, so the SDK's own argument parsing is
  // what rejects the call, before the handler (and the stream) sees it.
  async function call(name: string, args: Record<string, unknown>) {
    const server = new McpServer({ name: "stream-tools-test", version: "1" });
    registerStreamTools(server, ALL, {
      agentId: AGENT_ID,
      streams: { post, update } as never,
    });
    const client = new Client({ name: "stream-tools-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
    } finally {
      await client.close();
      await server.close();
    }
  }

  beforeEach(() => {
    post.mockClear();
    update.mockClear();
  });

  it("rejects an invented top-level key instead of posting the text alone", async () => {
    const result = await call("post", {
      text: "How far should this go?",
      blocks: [
        {
          question: "How far should this go?",
          options: [{ label: "Minimal", description: "Just the fix" }],
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unknown field "blocks"');
    for (const field of [
      "question",
      "form",
      "link",
      "review",
      "tasks",
      "attachments",
    ]) {
      expect(result.content[0]?.text).toContain(field);
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects unknown keys inside the typed payloads", async () => {
    const option = await call("post", {
      text: "Pick",
      question: {
        options: [{ label: "Minimal", description: "Just the fix" }],
      },
    });
    expect(option.isError).toBe(true);
    expect(option.content[0]?.text).toContain('Unknown field "description"');
    expect(option.content[0]?.text).toContain(
      "valid fields here: label, value"
    );
    expect(option.content[0]?.text).toContain("question.options[0]");

    const review = await call("post", {
      to: "agt_builder",
      review: { verdict: "approve", summary: "Clean", findings: [] },
    });
    expect(review.isError).toBe(true);
    expect(review.content[0]?.text).toContain('Unknown field "verdict"');

    const attachment = await call("post", {
      attachments: [{ type: "link", url: "https://x", label: "x" }],
    });
    expect(attachment.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects unknown keys on update but leaves data and state open", async () => {
    const unknown = await call("update", { id: BLOCK, status: "fixed" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]?.text).toContain('Unknown field "status"');
    expect(update).not.toHaveBeenCalled();

    const ok = await call("update", {
      id: BLOCK,
      state: { status: "dismissed", note: "n/a" },
      data: { anything: true },
    });
    expect(ok.isError).toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("still posts a well-formed question", async () => {
    const result = await call("post", {
      text: "How far should this go?",
      question: {
        options: [{ label: "Minimal" }, { label: "Full", value: "full" }],
        allowFreeform: true,
      },
    });
    expect(result.isError).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("advertises additionalProperties: false so clients see the contract", async () => {
    const server = new McpServer({ name: "stream-tools-test", version: "1" });
    registerStreamTools(server, ALL, {
      agentId: AGENT_ID,
      streams: { post, update } as never,
    });
    const client = new Client({ name: "stream-tools-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const postSchema = tools.find((t) => t.name === "post")?.inputSchema as {
        additionalProperties?: boolean;
        properties: Record<string, { additionalProperties?: boolean }>;
      };
      expect(postSchema.additionalProperties).toBe(false);
      expect(postSchema.properties.question?.additionalProperties).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
