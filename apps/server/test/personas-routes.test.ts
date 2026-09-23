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

import { registerPersonaRoutes } from "../src/routes/personas.js";
import { StreamServiceError } from "../src/chat/service.js";

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
    streams: {
      promptAgent: vi.fn(
        async (
          _agentId: string,
          _input: { text: string; description: string }
        ) => ({
          held: false,
        })
      ),
    },
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
    expect(deps.streams.promptAgent).not.toHaveBeenCalled();
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

  it("asks the agent to launch the personas itself, with the user's note", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-persona",
      payload: {
        personas: ["security-review", "ux-review", "security-review"],
        agentType: "codex",
        includeDiff: false,
        note: "  Focus on the auth changes.  ",
      },
    });
    expect(response.statusCode).toBe(200);
    // A prompt, not a post: nothing is written into the stream, and the
    // turn it opens carries one line saying what was asked for.
    expect(response.json()).toEqual({ ok: true, held: false });
    expect(deps.streams.promptAgent).toHaveBeenCalledTimes(1);
    const [agentId, input] = deps.streams.promptAgent.mock.calls[0]!;
    expect(agentId).toBe("agt_parent");
    expect(input.description).toBe(
      "Review requested: security-review, ux-review"
    );
    // The agent writes the briefing; the request names the personas, the
    // runtime, and carries the user's note.
    expect(input.text).toContain('persona: "security-review"');
    expect(input.text).toContain('persona: "ux-review"');
    expect(input.text).not.toMatch(
      /security-review[\s\S]*security-review[\s\S]*security-review/
    );
    expect(input.text).toContain('type: "codex"');
    expect(input.text).toContain("includeDiff: false");
    expect(input.text).toContain("prompt: <your briefing>");
    expect(input.text).toContain("From the user: Focus on the auth changes.");
    expect(input.text).toContain("its reviewer resolves it");
  });

  it("reports a prompt held behind the agent's running turn", async () => {
    deps.streams.promptAgent.mockResolvedValueOnce({ held: true });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-persona",
      payload: { persona: "security-review", agentType: "codex" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, held: true });
    expect(deps.streams.promptAgent.mock.calls[0]![1].description).toBe(
      "Review requested: security-review"
    );
  });

  it("reports the agent as not running when the post cannot be delivered", async () => {
    class StoppedError extends StreamServiceError {
      readonly statusCode = 409;
    }
    deps.streams.promptAgent.mockRejectedValueOnce(
      new StoppedError("Agent is stopped.")
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-persona",
      payload: { persona: "security-review", agentType: "codex" },
    });
    expect(response.statusCode).toBe(409);
  });
});
