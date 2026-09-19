import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type PersonaInteractionCallbacks,
  registerPersonaInteractionTools,
  resolvePersonaList,
} from "../src/shared/mcp/persona-interaction-tools.js";
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
    };
    registerPersonaInteractionTools(server as any, new Set(), callbacks);
    expect(server.tools).toHaveLength(0);
  });

  it("only registers tools that are in the allowed set AND have a callback", () => {
    const callbacks: PersonaInteractionCallbacks = {
      agentId,
      listPersonas: vi.fn(),
    };
    const allowed = new Set(["list_personas", "persona_upsert"]);
    registerPersonaInteractionTools(server as any, allowed, callbacks);
    const names = server.tools.map((t) => t.name);
    expect(names).toContain("list_personas");
    // persona_upsert needs a workspace root.
    expect(names).not.toContain("persona_upsert");
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
  });
});
