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
      getTerminalAccess: vi.fn(async () => ({ mode: "none" as const })),
    },
    sendAgentPrompt: vi.fn(async () => {}),
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
  deps.agentManager.getTerminalAccess.mockResolvedValue({
    mode: "none" as const,
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

describe("POST /api/v1/agents/:id/launch-review", () => {
  it("validates persona, agent type, and includeDiff", async () => {
    const invalidPayloads = [
      { agentType: "codex" },
      { persona: "bad slug!", agentType: "codex" },
      { persona: "security-review", agentType: "invalid" },
      { persona: "security-review", agentType: "codex", includeDiff: "yes" },
    ];
    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents/agt_parent/launch-review",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("requires a tmux session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-review",
      payload: { persona: "security-review", agentType: "codex" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("prompts the parent for every supported agent type", async () => {
    for (const agentType of CLI_AGENT_TYPES) {
      deps.agentManager.getTerminalAccess.mockResolvedValueOnce({
        mode: "tmux" as const,
        session: "test-session",
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents/agt_parent/launch-review",
        payload: { persona: "security-review", agentType, includeDiff: false },
      });
      expect(response.statusCode).toBe(200);
    }
    expect(deps.sendAgentPrompt).toHaveBeenLastCalledWith(
      "agt_parent",
      expect.stringContaining("includeDiff: false")
    );
  });
});
