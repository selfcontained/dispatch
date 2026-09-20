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
      streamOf: vi.fn(async (id: string) => `root:${id}`),
      sendUserPost: vi.fn(async (_root: string, input: { text: string }) => ({
        block: { id: "blk_1", text: input.text },
        delivered: null,
      })),
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
    expect(deps.streams.sendUserPost).not.toHaveBeenCalled();
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
    expect(response.json()).toMatchObject({ ok: true, block: { id: "blk_1" } });
    expect(deps.streams.streamOf).toHaveBeenCalledWith("agt_parent");
    expect(deps.streams.sendUserPost).toHaveBeenCalledTimes(1);
    const [root, input] = deps.streams.sendUserPost.mock.calls[0]!;
    expect(root).toBe("root:agt_parent");
    expect(input).toMatchObject({ to: "agt_parent", allowInert: false });
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
  });

  it("reports the agent as not running when the post cannot be delivered", async () => {
    class StoppedError extends StreamServiceError {
      readonly statusCode = 409;
    }
    deps.streams.sendUserPost.mockRejectedValueOnce(
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
