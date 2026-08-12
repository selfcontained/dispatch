import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type PersonaInteractionCallbacks,
  buildLaunchPersonaResponseText,
  registerPersonaInteractionTools,
  resolvePersonaList,
} from "../src/shared/mcp/persona-interaction-tools.js";
import { AGENT_REVIEW_SUMMARY_MAX_CHARS } from "../src/shared/review-limits.js";
import {
  BUILT_IN_PERSONA_SUMMARIES,
  GENERIC_REVIEW_PERSONA_SLUG,
} from "../src/personas/built-in.js";

// ─── resolvePersonaList ───────────────────────────────────────────────────────

describe("resolvePersonaList", () => {
  const builtInSlugs = new Set(BUILT_IN_PERSONA_SUMMARIES.map((p) => p.slug));
  // Built-ins ride along on every listing; these cases assert the repo-defined
  // slice, and the built-in cases live at the bottom of the block.
  const defined = <T extends { slug: string }>(personas: T[]): T[] =>
    personas.filter((p) => !builtInSlugs.has(p.slug));

  const security = { slug: "security", name: "Security", description: "sec" };
  const perf = { slug: "perf", name: "Perf", description: "perf" };
  const ux = { slug: "ux", name: "UX", description: "ux" };

  it("returns worktree personas when repoRoot is null", async () => {
    const listPersonas = vi.fn(async () => [security, perf]);
    const result = await resolvePersonaList(listPersonas, "/wt", null);
    expect(defined(result)).toEqual([security, perf]);
    expect(listPersonas).toHaveBeenCalledTimes(1);
    expect(listPersonas).toHaveBeenCalledWith("/wt");
  });

  it("returns repo personas when worktreeRoot is null", async () => {
    const listPersonas = vi.fn(async () => [security]);
    const result = await resolvePersonaList(listPersonas, null, "/repo");
    expect(defined(result)).toEqual([security]);
    expect(listPersonas).toHaveBeenCalledTimes(1);
    expect(listPersonas).toHaveBeenCalledWith("/repo");
  });

  it("merges with worktree precedence", async () => {
    const worktreeSecurity = {
      slug: "security",
      name: "Custom Security",
      description: "override",
    };
    const listPersonas = vi.fn(async (root: string) => {
      if (root === "/wt") return [worktreeSecurity, perf];
      return [security, ux];
    });

    const result = await resolvePersonaList(listPersonas, "/wt", "/repo");
    expect(defined(result)).toEqual([worktreeSecurity, perf, ux]);
  });

  it("skips repo when repoRoot equals worktreeRoot", async () => {
    const listPersonas = vi.fn(async () => [security]);
    const result = await resolvePersonaList(listPersonas, "/same", "/same");
    expect(listPersonas).toHaveBeenCalledTimes(1);
    expect(defined(result)).toEqual([security]);
  });

  it("returns only the built-ins when both roots are null", async () => {
    const listPersonas = vi.fn(async () => []);
    const result = await resolvePersonaList(listPersonas, null, null);
    expect(result.map((p) => p.slug)).toEqual([GENERIC_REVIEW_PERSONA_SLUG]);
    expect(listPersonas).not.toHaveBeenCalled();
  });

  it("handles worktree listPersonas failure gracefully", async () => {
    const listPersonas = vi.fn(async (root: string) => {
      if (root === "/wt") throw new Error("ENOENT");
      return [security];
    });
    const result = await resolvePersonaList(listPersonas, "/wt", "/repo");
    expect(defined(result)).toEqual([security]);
  });

  it("handles repo listPersonas failure gracefully", async () => {
    const listPersonas = vi.fn(async (root: string) => {
      if (root === "/repo") throw new Error("ENOENT");
      return [security];
    });
    const result = await resolvePersonaList(listPersonas, "/wt", "/repo");
    expect(defined(result)).toEqual([security]);
  });

  it("appends the built-in reviewer to every listing", async () => {
    const listPersonas = vi.fn(async () => [security]);
    const result = await resolvePersonaList(listPersonas, "/wt", null);
    expect(result.map((p) => p.slug)).toEqual([
      "security",
      GENERIC_REVIEW_PERSONA_SLUG,
    ]);
  });
});

// ─── buildLaunchPersonaResponseText ───────────────────────────────────────────

describe("buildLaunchPersonaResponseText", () => {
  it("includes the persona name and agent ID", () => {
    const text = buildLaunchPersonaResponseText(
      "security-review",
      "agt_test123"
    );
    expect(text).toContain('"security-review"');
    expect(text).toContain("agt_test123");
  });

  it("explains the unified review flow", () => {
    const text = buildLaunchPersonaResponseText("ux", "agt_abc");
    expect(text).toContain("dispatch_review_submit");
    expect(text).toContain("dispatch_review_list_feedback");
    expect(text).toContain("dispatch_review_resolve");
    expect(text).toContain("clean approval");
  });

  it("includes the reviewer agent ID", () => {
    const text = buildLaunchPersonaResponseText("perf", "agt_xyz789");
    expect(text).toContain("agt_xyz789");
  });
});

// ─── registerPersonaInteractionTools ──────────────────────────────────────────

type RegisteredTool = {
  name: string;
  config: { description: string; inputSchema: unknown };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function createMockServer() {
  const tools: RegisteredTool[] = [];
  return {
    registerTool: vi.fn((name: string, config: unknown, handler: unknown) => {
      tools.push({ name, config: config as any, handler: handler as any });
    }),
    tools,
  };
}

describe("registerPersonaInteractionTools", () => {
  let server: ReturnType<typeof createMockServer>;
  const agentId = "agt_persona_test";

  beforeEach(() => {
    server = createMockServer();
  });

  it("registers no tools when allowed set is empty", () => {
    const callbacks: PersonaInteractionCallbacks = {
      agentId,
      listPersonas: vi.fn(),
      launchPersona: vi.fn(),
    };
    registerPersonaInteractionTools(server as any, new Set(), callbacks);
    expect(server.tools).toHaveLength(0);
  });

  it("only registers tools that are in the allowed set AND have a callback", () => {
    const callbacks: PersonaInteractionCallbacks = {
      agentId,
      listPersonas: vi.fn(),
    };
    const allowed = new Set(["list_personas", "dispatch_launch_persona"]);
    registerPersonaInteractionTools(server as any, allowed, callbacks);
    const names = server.tools.map((t) => t.name);
    expect(names).toContain("list_personas");
    expect(names).not.toContain("dispatch_launch_persona");
  });

  it("registers dispatch_launch_persona when allowed and callback provided", () => {
    const callbacks: PersonaInteractionCallbacks = {
      agentId,
      launchPersona: vi.fn(async () => ({
        persona: "sec",
        agentId: "agt_reviewer",
      })),
    };
    const allowed = new Set(["dispatch_launch_persona"]);
    registerPersonaInteractionTools(server as any, allowed, callbacks);
    expect(server.tools).toHaveLength(1);
    expect(server.tools[0].name).toBe("dispatch_launch_persona");
  });

  it("registers all review tools when allowed and callbacks present", () => {
    const callbacks: PersonaInteractionCallbacks = {
      agentId,
      parentAgentId: "agt_parent",
      getParentContext: vi.fn(async () => ({ pins: [], media: [] })),
      listReviewFeedback: vi.fn(async () => []),
      submitReview: vi.fn(async () => ({ review: { id: 1 } })),
      addReviewFeedback: vi.fn(async () => ({ item: { id: 2 } })),
      resolveReviewFeedback: vi.fn(async () => ({
        item: { id: 1 },
        reviewId: 1,
        reviewStatus: "resolved",
      })),
      addReviewThreadMessage: vi.fn(async () => ({
        message: { id: 1 },
        reviewId: 1,
      })),
      reopenReviewFeedback: vi.fn(async () => ({
        item: { id: 1 },
        reviewId: 1,
        reviewStatus: "open",
      })),
    };
    const allowed = new Set([
      "dispatch_review_list_feedback",
      "dispatch_review_submit",
      "dispatch_review_add_feedback",
      "dispatch_review_resolve",
      "dispatch_review_reopen",
      "dispatch_review_add_message",
      "get_parent_context",
    ]);
    registerPersonaInteractionTools(server as any, allowed, callbacks);
    const names = server.tools.map((t) => t.name);
    expect(names).toContain("dispatch_review_list_feedback");
    expect(names).toContain("dispatch_review_submit");
    expect(names).toContain("dispatch_review_add_feedback");
    expect(names).toContain("dispatch_review_resolve");
    expect(names).toContain("dispatch_review_reopen");
    expect(names).toContain("dispatch_review_add_message");
    expect(names).toContain("get_parent_context");
  });

  it("normalizes summary whitespace before enforcing its length", () => {
    const callbacks: PersonaInteractionCallbacks = {
      agentId,
      submitReview: vi.fn(),
    };
    registerPersonaInteractionTools(
      server as any,
      new Set(["dispatch_review_submit"]),
      callbacks
    );

    const tool = server.tools[0];
    const inputSchema = tool.config.inputSchema as {
      summary: {
        safeParse: (value: unknown) => {
          success: boolean;
          data?: string;
        };
      };
    };
    expect(inputSchema.summary.safeParse(undefined).success).toBe(true);
    const padded = inputSchema.summary.safeParse(
      `  ${"a".repeat(AGENT_REVIEW_SUMMARY_MAX_CHARS)}  `
    );
    expect(padded).toMatchObject({
      success: true,
      data: "a".repeat(AGENT_REVIEW_SUMMARY_MAX_CHARS),
    });
    expect(
      inputSchema.summary.safeParse(
        ` ${"a".repeat(AGENT_REVIEW_SUMMARY_MAX_CHARS + 1)} `
      ).success
    ).toBe(false);
    expect(tool.config.description).toContain("required for a clean approval");
  });

  it("caps dispatch_review_add_message input at 600 characters", () => {
    const callbacks: PersonaInteractionCallbacks = {
      agentId,
      addReviewThreadMessage: vi.fn(async () => ({
        message: { id: 1 },
        reviewId: 1,
      })),
    };
    registerPersonaInteractionTools(
      server as any,
      new Set(["dispatch_review_add_message"]),
      callbacks
    );

    const inputSchema = server.tools[0].config.inputSchema as {
      body: {
        safeParse: (value: string) => { success: boolean };
      };
    };
    expect(inputSchema.body.safeParse("a".repeat(600)).success).toBe(true);
    expect(inputSchema.body.safeParse("a".repeat(601)).success).toBe(false);
    expect(server.tools[0].config.description).toContain("max 600 characters");
  });

  describe("tool handlers", () => {
    it("get_parent_context returns the parent's pins and media", async () => {
      const getParentContext = vi.fn(async () => ({
        pins: [{ label: "Dev", value: "http://localhost", type: "url" }],
        media: [
          {
            fileName: "screen.png",
            filePath: "/tmp/screen.png",
            description: "Current UI",
            source: "screenshot",
            sizeBytes: 42,
            createdAt: "2026-07-16T00:00:00Z",
          },
        ],
      }));
      registerPersonaInteractionTools(
        server as any,
        new Set(["get_parent_context"]),
        { agentId, parentAgentId: "agt_parent", getParentContext }
      );

      const result = (await server.tools[0].handler({})) as any;
      expect(getParentContext).toHaveBeenCalledWith("agt_parent");
      expect(result.content[0].text).toContain("Dev (url)");
      expect(result.content[0].text).toContain("screen.png");
      expect(result.structuredContent.media).toHaveLength(1);
    });

    it("requires a summary only when dispatch_review_submit has no feedback", async () => {
      const submitReview = vi.fn(async () => ({
        review: {
          id: 3,
          status: "open",
          summary: null,
          items: [{ id: 5 }],
        },
      }));
      registerPersonaInteractionTools(
        server as any,
        new Set(["dispatch_review_submit"]),
        { agentId, submitReview }
      );
      const tool = server.tools[0];

      const withFeedback = (await tool.handler({
        summary: "   ",
        feedback: [{ comment: "Actionable issue" }],
      })) as any;
      expect(withFeedback.isError).not.toBe(true);
      expect(submitReview).toHaveBeenCalledWith(agentId, {
        summary: undefined,
        feedback: [{ comment: "Actionable issue" }],
      });

      submitReview.mockClear();
      const cleanWithoutSummary = (await tool.handler({
        summary: "   ",
        feedback: [],
      })) as any;
      expect(cleanWithoutSummary.isError).toBe(true);
      expect(cleanWithoutSummary.content[0].text).toContain(
        "summary is required for a clean approval"
      );
      expect(submitReview).not.toHaveBeenCalled();
    });

    it("list_personas calls resolvePersonaList with correct roots", async () => {
      const personas = [
        { slug: "sec", name: "Security", description: "review" },
      ];
      const listPersonas = vi.fn(async () => personas);
      const callbacks: PersonaInteractionCallbacks = {
        agentId,
        worktreeRoot: "/wt",
        repoRoot: "/repo",
        listPersonas,
      };
      registerPersonaInteractionTools(
        server as any,
        new Set(["list_personas"]),
        callbacks
      );

      const result = await server.tools[0].handler({});
      expect(result).toHaveProperty("structuredContent");
      expect((result as any).structuredContent.personas).toEqual([
        ...personas,
        ...BUILT_IN_PERSONA_SUMMARIES,
      ]);
    });

    it("registers persona authoring tools for a workspace", async () => {
      const callbacks: PersonaInteractionCallbacks = {
        agentId,
        worktreeRoot: "/workspace",
      };
      registerPersonaInteractionTools(
        server as any,
        new Set(["persona_templates", "persona_upsert", "persona_validate"]),
        callbacks
      );

      expect(server.tools.map((tool) => tool.name)).toEqual([
        "persona_templates",
        "persona_upsert",
        "persona_validate",
      ]);
      const result = (await server.tools[0].handler({})) as any;
      expect(result.structuredContent.templates).toHaveLength(3);
    });

    it("dispatch_review_list_feedback returns 'no items' when empty", async () => {
      const listReviewFeedback = vi.fn(async () => []);
      const callbacks: PersonaInteractionCallbacks = {
        agentId,
        listReviewFeedback,
      };
      registerPersonaInteractionTools(
        server as any,
        new Set(["dispatch_review_list_feedback"]),
        callbacks
      );

      const result = (await server.tools[0].handler({})) as any;
      expect(result.content[0].text).toContain(
        "No review feedback items found"
      );
    });

    it("dispatch_review_list_feedback replaces threads with a count", async () => {
      const listReviewFeedback = vi.fn(async () => [
        {
          id: 7,
          reviewId: 2,
          filePath: "src/a.ts",
          status: "open",
          diffSnapshot: "@@ -1 +1 @@\n-old\n+new",
          messages: [
            { id: 1, authorType: "agent", content: { body: "first" } },
            { id: 2, authorType: "agent", content: { body: "second" } },
          ],
        },
      ]);
      const callbacks: PersonaInteractionCallbacks = {
        agentId,
        listReviewFeedback: listReviewFeedback as never,
      };
      registerPersonaInteractionTools(
        server as any,
        new Set(["dispatch_review_list_feedback"]),
        callbacks
      );

      const result = (await server.tools[0].handler({})) as any;
      const item = result.structuredContent.items[0];
      expect(item.messageCount).toBe(2);
      expect(item.messages).toBeUndefined();
      expect(item.diffSnapshot).toBeUndefined();
      expect(item.filePath).toBe("src/a.ts");
    });

    it("dispatch_review_get_feedback returns one item in full", async () => {
      const item = {
        id: 7,
        reviewId: 2,
        filePath: "src/a.ts",
        status: "open",
        diffSnapshot: "@@ -1 +1 @@",
        messages: [{ id: 1, authorType: "agent", content: { body: "first" } }],
      };
      const getReviewFeedbackItem = vi.fn(
        async (_agentId: string, id: number) => (id === 7 ? item : null)
      );
      const callbacks: PersonaInteractionCallbacks = {
        agentId,
        getReviewFeedbackItem: getReviewFeedbackItem as never,
      };
      registerPersonaInteractionTools(
        server as any,
        new Set(["dispatch_review_get_feedback"]),
        callbacks
      );

      const found = (await server.tools[0].handler({ itemId: 7 })) as any;
      expect(found.structuredContent.item).toEqual(item);
      // Fetched by id, not by scanning the agent's whole feedback list.
      expect(getReviewFeedbackItem).toHaveBeenCalledWith(agentId, 7);

      const missing = (await server.tools[0].handler({ itemId: 99 })) as any;
      expect(missing.isError).toBe(true);
    });

    it("dispatch_review_resolve calls resolveReviewFeedback", async () => {
      const resolveReviewFeedback = vi.fn(async () => ({
        item: { id: 7 },
        reviewId: 2,
        reviewStatus: "partially_resolved",
      }));
      const callbacks: PersonaInteractionCallbacks = {
        agentId,
        resolveReviewFeedback,
      };
      registerPersonaInteractionTools(
        server as any,
        new Set(["dispatch_review_resolve"]),
        callbacks
      );

      const result = (await server.tools[0].handler({
        itemId: 7,
        resolution: "dismissed",
        note: "by design",
      })) as any;

      expect(resolveReviewFeedback).toHaveBeenCalledWith(
        agentId,
        7,
        "dismissed",
        { note: "by design" }
      );
      expect(result.content[0].text).toContain("Review feedback #7");
      expect(result.content[0].text).toContain("partially_resolved");
    });

    it("dispatch_review_add_message calls addReviewThreadMessage", async () => {
      const addReviewThreadMessage = vi.fn(async () => ({
        message: { id: 12 },
        reviewId: 3,
      }));
      const callbacks: PersonaInteractionCallbacks = {
        agentId,
        addReviewThreadMessage,
      };
      registerPersonaInteractionTools(
        server as any,
        new Set(["dispatch_review_add_message"]),
        callbacks
      );

      const result = (await server.tools[0].handler({
        itemId: 9,
        body: "Looks good to me",
      })) as any;

      expect(addReviewThreadMessage).toHaveBeenCalledWith(
        agentId,
        9,
        "Looks good to me"
      );
      expect(result.content[0].text).toContain("message #12");
    });
  });
});
