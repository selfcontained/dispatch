import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { CLI_AGENT_TYPES } from "../src/agent-type-settings.js";
import { registerPersonaRoutes } from "../src/routes/personas.js";

vi.mock("../src/personas/loader.js", () => ({
  loadPersonasFromRoots: vi.fn(async () => []),
}));

vi.mock("../src/shared/git/git-context.js", () => ({
  resolveRepoRoot: vi.fn(async (cwd: string) => cwd),
  resolveWorktreeRoot: vi.fn(async (cwd: string) => cwd),
}));

function createMockDeps() {
  return {
    agentManager: {
      getAgent: vi.fn(async () => ({
        id: "agt_parent",
        name: "test-agent",
        cwd: "/tmp",
      })),
    },
    launchPersonaAgent: vi.fn(
      async (_parentId: string, opts: { persona: string }) => ({
        agentId: `agt_${opts.persona}`,
        name: `${opts.persona}-parent`,
        persona: opts.persona,
      })
    ),
    handleAgentError: vi.fn((reply: FastifyReply, error: unknown) =>
      reply.code(500).send({ error: String(error) })
    ),
  };
}

let app: FastifyInstance;
let deps: ReturnType<typeof createMockDeps>;

beforeAll(async () => {
  app = Fastify();
  deps = createMockDeps();
  await registerPersonaRoutes(
    app,
    deps as unknown as Parameters<typeof registerPersonaRoutes>[1]
  );
  await app.ready();
});

afterAll(async () => app.close());

beforeEach(() => {
  vi.clearAllMocks();
  deps.agentManager.getAgent.mockResolvedValue({
    id: "agt_parent",
    name: "test-agent",
    cwd: "/tmp",
  });
});

describe("GET /api/v1/personas", () => {
  it("requires cwd", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/personas",
    });
    expect(response.statusCode).toBe(400);
  });

  it("loads personas from the worktree and repo roots", async () => {
    const { loadPersonasFromRoots } = await import("../src/personas/loader.js");
    vi.mocked(loadPersonasFromRoots).mockResolvedValueOnce([
      { slug: "security-review", name: "Security Review" },
    ] as never);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/personas?cwd=/tmp",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().personas[0].slug).toBe("security-review");
    expect(loadPersonasFromRoots).toHaveBeenCalledWith({
      worktreeRoot: "/tmp",
      repoRoot: "/tmp",
    });
  });
});

describe("POST /api/v1/agents/:id/launch-persona", () => {
  it("validates persona, agent type, and includeDiff", async () => {
    const invalidPayloads = [
      { agentType: "codex" },
      { persona: "bad slug!", agentType: "codex" },
      { persona: "security-review", agentType: "invalid" },
      { persona: "security-review", agentType: "codex", includeDiff: "yes" },
      { personas: [], agentType: "codex" },
    ];
    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents/agt_parent/launch-persona",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(deps.launchPersonaAgent).not.toHaveBeenCalled();
  });

  it("404s an unknown parent", async () => {
    deps.agentManager.getAgent.mockResolvedValueOnce(null as never);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_missing/launch-persona",
      payload: { persona: "security-review", agentType: "codex" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("launches one child per persona, with the note as the briefing", async () => {
    for (const agentType of CLI_AGENT_TYPES) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents/agt_parent/launch-persona",
        payload: { persona: "security-review", agentType, includeDiff: false },
      });
      expect(response.statusCode).toBe(200);
    }
    expect(deps.launchPersonaAgent).toHaveBeenLastCalledWith("agt_parent", {
      persona: "security-review",
      context: "Review the agent's current work in this worktree.",
      agentType: CLI_AGENT_TYPES[CLI_AGENT_TYPES.length - 1],
      includeDiff: false,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-persona",
      payload: {
        personas: ["security-review", "ux-review", "security-review"],
        agentType: "codex",
        note: "  Focus on the auth changes.  ",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      launched: [
        {
          agentId: "agt_security-review",
          name: "security-review-parent",
          persona: "security-review",
        },
        {
          agentId: "agt_ux-review",
          name: "ux-review-parent",
          persona: "ux-review",
        },
      ],
    });
    expect(deps.launchPersonaAgent).toHaveBeenCalledWith("agt_parent", {
      persona: "ux-review",
      context: "Focus on the auth changes.",
      agentType: "codex",
    });
  });
});
