import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type PersonaInteractionCallbacks,
  buildLaunchPersonaResponseText,
  registerPersonaInteractionTools,
  resolvePersonaList,
} from "../src/shared/mcp/persona-interaction-tools.js";

// ─── resolvePersonaList ───────────────────────────────────────────────────────

describe("resolvePersonaList", () => {
  const security = { slug: "security", name: "Security", description: "sec" };
  const perf = { slug: "perf", name: "Perf", description: "perf" };
  const ux = { slug: "ux", name: "UX", description: "ux" };

  it("returns worktree personas when repoRoot is null", async () => {
    const listPersonas = vi.fn(async () => [security, perf]);
    const result = await resolvePersonaList(listPersonas, "/wt", null);
    expect(result).toEqual([security, perf]);
    expect(listPersonas).toHaveBeenCalledTimes(1);
    expect(listPersonas).toHaveBeenCalledWith("/wt");
  });

  it("returns repo personas when worktreeRoot is null", async () => {
    const listPersonas = vi.fn(async () => [security]);
    const result = await resolvePersonaList(listPersonas, null, "/repo");
    expect(result).toEqual([security]);
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
    expect(result).toEqual([worktreeSecurity, perf, ux]);
  });

  it("skips repo when repoRoot equals worktreeRoot", async () => {
    const listPersonas = vi.fn(async () => [security]);
    const result = await resolvePersonaList(listPersonas, "/same", "/same");
    expect(listPersonas).toHaveBeenCalledTimes(1);
    expect(result).toEqual([security]);
  });

  it("returns empty array when both roots are null", async () => {
    const listPersonas = vi.fn(async () => []);
    const result = await resolvePersonaList(listPersonas, null, null);
    expect(result).toEqual([]);
    expect(listPersonas).not.toHaveBeenCalled();
  });

  it("handles worktree listPersonas failure gracefully", async () => {
    const listPersonas = vi.fn(async (root: string) => {
      if (root === "/wt") throw new Error("ENOENT");
      return [security];
    });
    const result = await resolvePersonaList(listPersonas, "/wt", "/repo");
    expect(result).toEqual([security]);
  });

  it("handles repo listPersonas failure gracefully", async () => {
    const listPersonas = vi.fn(async (root: string) => {
      if (root === "/repo") throw new Error("ENOENT");
      return [security];
    });
    const result = await resolvePersonaList(listPersonas, "/wt", "/repo");
    expect(result).toEqual([security]);
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

  it("includes instructions about the round-trip review", () => {
    const text = buildLaunchPersonaResponseText("ux", "agt_abc");
    expect(text).toContain("round-trip review");
    expect(text).toContain("dispatch_get_feedback");
    expect(text).toContain("dispatch_resolve_feedback");
    expect(text).toContain("dispatch_submit_resolution");
  });

  it("includes the personaAgentId in the tool call example", () => {
    const text = buildLaunchPersonaResponseText("perf", "agt_xyz789");
    expect(text).toContain('personaAgentId="agt_xyz789"');
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
    const allowed = new Set([
      "list_personas",
      "dispatch_launch_persona",
      "dispatch_get_feedback",
    ]);
    registerPersonaInteractionTools(server as any, allowed, callbacks);
    const names = server.tools.map((t) => t.name);
    expect(names).toContain("list_personas");
    expect(names).not.toContain("dispatch_launch_persona");
    expect(names).not.toContain("dispatch_get_feedback");
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
      listReviewFeedback: vi.fn(async () => []),
      resolveReviewFeedback: vi.fn(async () => ({
        item: { id: 1 },
        reviewId: 1,
        reviewStatus: "resolved",
      })),
      addReviewThreadMessage: vi.fn(async () => ({
        message: { id: 1 },
        reviewId: 1,
      })),
      submitResolution: vi.fn(async () => ({
        review: { id: 1 },
        resolution: { roundNumber: 2 },
      })),
    };
    const allowed = new Set([
      "dispatch_review_list_feedback",
      "dispatch_review_resolve",
      "dispatch_review_add_message",
      "dispatch_submit_resolution",
    ]);
    registerPersonaInteractionTools(server as any, allowed, callbacks);
    const names = server.tools.map((t) => t.name);
    expect(names).toContain("dispatch_review_list_feedback");
    expect(names).toContain("dispatch_review_resolve");
    expect(names).toContain("dispatch_review_add_message");
    expect(names).toContain("dispatch_submit_resolution");
  });

  describe("tool handlers", () => {
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
      expect((result as any).structuredContent.personas).toEqual(personas);
    });

    it("dispatch_get_feedback returns summary with item counts", async () => {
      const getFeedback = vi.fn(async () => ({
        personas: [
          { slug: "sec", feedback: [{ id: 1 }, { id: 2 }] },
          { slug: "perf", feedback: [{ id: 3 }] },
        ],
      }));
      const callbacks: PersonaInteractionCallbacks = {
        agentId,
        getFeedback,
      };
      registerPersonaInteractionTools(
        server as any,
        new Set(["dispatch_get_feedback"]),
        callbacks
      );

      const result = (await server.tools[0].handler({
        limit: 100,
      })) as any;
      expect(result.content[0].text).toContain("3 feedback item(s)");
      expect(result.content[0].text).toContain("2 persona(s)");
    });

    it("dispatch_get_feedback returns 'no feedback' when empty", async () => {
      const getFeedback = vi.fn(async () => ({ personas: [] }));
      const callbacks: PersonaInteractionCallbacks = {
        agentId,
        getFeedback,
      };
      registerPersonaInteractionTools(
        server as any,
        new Set(["dispatch_get_feedback"]),
        callbacks
      );

      const result = (await server.tools[0].handler({
        limit: 100,
      })) as any;
      expect(result.content[0].text).toContain("No persona feedback found");
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

    it("dispatch_resolve_feedback calls resolveFeedback with correct args", async () => {
      const resolveFeedback = vi.fn(async () => ({
        id: 5,
        status: "fixed",
      }));
      const callbacks: PersonaInteractionCallbacks = {
        agentId,
        resolveFeedback,
      };
      registerPersonaInteractionTools(
        server as any,
        new Set(["dispatch_resolve_feedback"]),
        callbacks
      );

      const result = (await server.tools[0].handler({
        feedbackId: 5,
        status: "fixed",
        reason: "addressed",
      })) as any;

      expect(resolveFeedback).toHaveBeenCalledWith(agentId, 5, "fixed", {
        reason: "addressed",
      });
      expect(result.content[0].text).toContain("Feedback #5 marked as fixed");
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
        resolution: "wont_fix",
        note: "by design",
      })) as any;

      expect(resolveReviewFeedback).toHaveBeenCalledWith(
        agentId,
        7,
        "wont_fix",
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

    it("dispatch_submit_resolution calls submitResolution", async () => {
      const submitResolution = vi.fn(async () => ({
        review: { id: 4 },
        resolution: { roundNumber: 2 },
      }));
      const callbacks: PersonaInteractionCallbacks = {
        agentId,
        submitResolution,
      };
      registerPersonaInteractionTools(
        server as any,
        new Set(["dispatch_submit_resolution"]),
        callbacks
      );

      const result = (await server.tools[0].handler({
        personaAgentId: "agt_reviewer",
        summary: "Fixed all issues",
      })) as any;

      expect(submitResolution).toHaveBeenCalledWith(agentId, {
        personaAgentId: "agt_reviewer",
        summary: "Fixed all issues",
      });
      expect(result.content[0].text).toContain("review #4");
      expect(result.content[0].text).toContain("round 2");
    });
  });
});
