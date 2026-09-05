import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerChatTools } from "../src/shared/mcp/chat-tools.js";

type Registered = {
  name: string;
  config: { description: string; inputSchema: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
};

function createMockServer() {
  const tools: Registered[] = [];
  return {
    registerTool: vi.fn((name, config, handler) => {
      tools.push({ name, config, handler });
    }),
    tools,
  };
}

const AGENT_ID = "agt_chat_tools";
const ALL = new Set(["dispatch_chat_post", "dispatch_chat_update"]);

describe("registerChatTools", () => {
  let server: ReturnType<typeof createMockServer>;
  let post: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    server = createMockServer();
    post = vi.fn(async (_agentId: string, input: { text: string }) => ({
      id: "msg_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      text: input.text,
    }));
    update = vi.fn(async () => ({
      id: "msg_1",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));
    registerChatTools(server as never, ALL, {
      agentId: AGENT_ID,
      chat: { post, update } as never,
    });
  });

  function tool(name: string): Registered {
    const found = server.tools.find((t) => t.name === name);
    if (!found) throw new Error(`tool ${name} not registered`);
    return found;
  }

  it("registers both tools only when allowed and a service is present", () => {
    expect(server.tools.map((t) => t.name)).toEqual([
      "dispatch_chat_post",
      "dispatch_chat_update",
    ]);
    const none = createMockServer();
    registerChatTools(none as never, ALL, { agentId: AGENT_ID });
    expect(none.tools).toHaveLength(0);
    const onlyPost = createMockServer();
    registerChatTools(onlyPost as never, new Set(["dispatch_chat_post"]), {
      agentId: AGENT_ID,
      chat: { post, update } as never,
    });
    expect(onlyPost.tools.map((t) => t.name)).toEqual(["dispatch_chat_post"]);
  });

  it("describes the mechanics without asserting the user is reading Chat", () => {
    const description = tool("dispatch_chat_post").config.description;
    // With the flag off the tool is still registered, so the wording stays
    // capability-neutral and the directive lives in the launch rule alone.
    expect(description).not.toMatch(/user reads the Chat tab/i);
    expect(description).toContain("optional Chat tab");
    expect(description).toContain("replyTo");
    expect(description).toMatch(/"question"/);
    expect(description).toContain("dispatch_share_file");
    expect(description).toContain("dispatch_chat_update");
    expect(Object.keys(tool("dispatch_chat_post").config.inputSchema)).toEqual([
      "text",
      "kind",
      "replyTo",
      "question",
      "attachments",
    ]);
  });

  it("asserts Chat is where the user is when the surface flag is on", () => {
    const on = createMockServer();
    registerChatTools(on as never, ALL, {
      agentId: AGENT_ID,
      chat: { post, update } as never,
      chatSurface: true,
    });
    const description = on.tools.find((t) => t.name === "dispatch_chat_post")
      ?.config.description as string;
    expect(description).toContain("where the user is reading this session");
    expect(description).toMatch(/never reaches them/);
    expect(description).toMatch(/do not end a turn without one/);
    // The neutral hedge is gone — it is the half this flag replaces.
    expect(description).not.toContain("optional Chat tab");
    expect(description).not.toContain("this tool only describes the mechanics");
    // …while everything after the lead-in is unchanged.
    expect(description).toContain("DISPATCH CHAT envelope");
    expect(description).toContain("dispatch_share_file");
    expect(description).toContain("dispatch_chat_update");
  });

  it("keeps the neutral description for an explicit false and for the default", () => {
    const off = createMockServer();
    registerChatTools(off as never, ALL, {
      agentId: AGENT_ID,
      chat: { post, update } as never,
      chatSurface: false,
    });
    const offDescription = off.tools.find(
      (t) => t.name === "dispatch_chat_post"
    )?.config.description as string;
    expect(offDescription).toBe(tool("dispatch_chat_post").config.description);
    expect(offDescription).toContain("optional Chat tab");
  });

  it("leaves dispatch_chat_update's description alone either way", () => {
    const on = createMockServer();
    registerChatTools(on as never, ALL, {
      agentId: AGENT_ID,
      chat: { post, update } as never,
      chatSurface: true,
    });
    expect(
      on.tools.find((t) => t.name === "dispatch_chat_update")?.config
        .description
    ).toBe(tool("dispatch_chat_update").config.description);
  });

  it("posts a reply and returns id + createdAt", async () => {
    const result = await tool("dispatch_chat_post").handler({ text: "done" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      id: "msg_1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(post).toHaveBeenCalledWith(AGENT_ID, {
      text: "done",
      kind: undefined,
      replyTo: null,
      question: null,
      attachments: [],
    });
  });

  it("forwards a well-formed question with its options", async () => {
    const question = {
      options: [{ label: "Yes", value: "y" }, { label: "No" }],
      allowFreeform: true,
    };
    const result = await tool("dispatch_chat_post").handler({
      text: "Ship?",
      kind: "question",
      replyTo: "user_msg",
      question,
    });
    expect(result.isError).toBeUndefined();
    expect(post).toHaveBeenCalledWith(AGENT_ID, {
      text: "Ship?",
      kind: "question",
      replyTo: "user_msg",
      question,
      attachments: [],
    });
  });

  it("surfaces service errors (e.g. unknown file) as tool errors", async () => {
    post.mockRejectedValueOnce(new Error('Unknown file "x.png"'));
    const result = await tool("dispatch_chat_post").handler({
      text: "see",
      attachments: [{ type: "file", fileName: "x.png" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown file");
  });

  it("declares file attachments by fileName or mediaId, not path", () => {
    const schema = tool("dispatch_chat_post").config.inputSchema
      .attachments as { safeParse: (v: unknown) => { success: boolean } };
    expect(
      schema.safeParse([{ type: "file", fileName: "a.png" }]).success
    ).toBe(true);
    expect(schema.safeParse([{ type: "file", mediaId: 3 }]).success).toBe(true);
    expect(
      schema.safeParse([{ type: "file", path: "/tmp/a.png" }]).success
    ).toBe(false);
    expect(schema.safeParse([{ type: "file" }]).success).toBe(false);
    expect(
      schema.safeParse([{ type: "file", fileName: "a.png", mediaId: 3 }])
        .success
    ).toBe(false);
  });

  it("updates a message and returns id + updatedAt", async () => {
    const result = await tool("dispatch_chat_update").handler({
      messageId: "msg_1",
      text: "final",
      kind: "summary",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      id: "msg_1",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(update).toHaveBeenCalledWith(AGENT_ID, "msg_1", {
      text: "final",
      kind: "summary",
      question: undefined,
      attachments: undefined,
    });
  });

  it("returns a tool error when the update is rejected", async () => {
    update.mockRejectedValueOnce(new Error("Message not found"));
    const result = await tool("dispatch_chat_update").handler({
      messageId: "nope",
      text: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Message not found");
  });
});
