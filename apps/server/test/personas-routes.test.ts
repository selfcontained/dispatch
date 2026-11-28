import { placementForRunner } from "../src/runners/placement.js";
import { validationCatalogFixture } from "./helpers/model-catalog-validation.js";
const validationFixtures: ReturnType<typeof validationCatalogFixture>[] = [];
import {
  setLearnedAgentModels,
  getLearnedAgentModels,
  forgetLearnedAgentModels,
} from "../src/shared/agent-models.js";
import { afterEach } from "vitest";
afterEach(() => {
  for (const fixture of validationFixtures.splice(0)) fixture.close();
  forgetLearnedAgentModels();
});
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

vi.mock("../src/personas/resolve.js", () => ({
  listPersonas: vi.fn(async () => ({
    personas: [],
    warnings: [],
    refreshing: false,
    updatedAt: null,
  })),
}));

vi.mock("../src/personas/codeowners.js", () => ({
  hasCodeowners: vi.fn(async () => false),
}));

vi.mock(
  "../../../packages/runner/src/workload/shared/git/git-context.js",
  () => ({
    resolveRepoRoot: vi.fn(async (cwd: string) => cwd),
    resolveWorktreeRoot: vi.fn(async (cwd: string) => cwd),
  })
);

function createMockDeps() {
  return {
    projects: {
      get: vi.fn(async (_id: string) => ({ repoRoot: "/project" })),
      getRepository: vi.fn(async (_id: string) => ({ url: null })),
    },
    agentManager: {
      checkoutReadRunners: vi.fn(() => ({})),
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
    const { listPersonas } = await import("../src/personas/resolve.js");
    vi.mocked(listPersonas).mockResolvedValueOnce({
      personas: [
        { slug: "security-review", name: "Security Review", type: "review" },
      ],
      warnings: [],
      refreshing: false,
      updatedAt: null,
    } as never);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/personas?cwd=/tmp",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().personas[0].slug).toBe("security-review");
    expect(response.json().codeowners).toBe(false);
    expect(listPersonas).toHaveBeenCalledWith(
      {
        kind: "folder",
        cwd: "/tmp",
        source: "workspace",
        runners: expect.any(Function),
      },
      "review"
    );
  });

  it("returns discovery warnings without hiding valid personas", async () => {
    const { listPersonas } = await import("../src/personas/resolve.js");
    vi.mocked(listPersonas).mockResolvedValueOnce({
      warnings: ["Invalid persona type in broken.md"],
      refreshing: true,
      updatedAt: null,
      personas: [
        {
          slug: "builder",
          name: "Builder",
          description: "",
          body: "Build",
          type: "task",
        },
      ],
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/personas?cwd=/tmp&type=task",
    });
    expect(response.statusCode).toBe(200);
    expect(listPersonas).toHaveBeenCalledWith(
      {
        kind: "folder",
        cwd: "/tmp",
        source: "catalog",
        runners: expect.any(Function),
      },
      "task"
    );
    expect(response.json()).toMatchObject({
      refreshing: true,
      personas: [expect.objectContaining({ slug: "builder" })],
      warnings: ["Invalid persona type in broken.md"],
    });
  });

  it.each([
    // Its repository, read on that runner and nowhere else; without a
    // project there is nothing to read there, and the runner says so.
    ["&projectId=prj_test", { kind: "repository", read: expect.any(Function) }],
    ["", { kind: "repository", read: expect.any(Function) }],
  ])("scopes a runner listing with query suffix %s", async (suffix, scope) => {
    const { listPersonas } = await import("../src/personas/resolve.js");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/personas?runner=rnr_test&cwd=&type=task${suffix}`,
    });
    expect(response.statusCode).toBe(200);
    expect(listPersonas).toHaveBeenCalledWith(scope, "task");
  });

  it("reports an ownership map found in the worktree", async () => {
    const { hasCodeowners } = await import("../src/personas/codeowners.js");
    vi.mocked(hasCodeowners).mockResolvedValueOnce(true);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/personas?cwd=/tmp",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().codeowners).toBe(true);
    expect(hasCodeowners).toHaveBeenCalledWith({
      access: expect.any(Function),
    });
  });
});

describe("POST /api/v1/agents/:id/launch-persona", () => {
  it("validates persona and agent type", async () => {
    const invalidPayloads = [
      { agentType: "codex" },
      { persona: "bad slug!", agentType: "codex" },
      { persona: "security-review", agentType: "invalid" },
      { personas: [], agentType: "codex" },
      { personas: [], codeowners: false, agentType: "codex" },
      { codeowners: "yes", agentType: "codex" },
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

  it.each(["taught", "first refresh", "failed refresh"] as const)(
    "passes a runner-only reviewer model and effort to the kickoff (%s)",
    async (source) => {
      if (source === "taught")
        setLearnedAgentModels(
          "opencode",
          [
            {
              id: "runner-custom/review",
              label: "Runner Review",
              effort: [{ value: "runner-effort", name: "Runner effort" }],
            },
          ],
          "runner-custom/review",
          "linux"
        );
      else
        validationFixtures.push(
          validationCatalogFixture(
            "linux",
            "opencode",
            [
              {
                id: "runner-custom/review",
                label: "Runner Review",
                effort: [{ value: "runner-effort", name: "Runner effort" }],
              },
            ],
            source === "failed refresh"
          )
        );
      deps.agentManager.getAgent.mockResolvedValueOnce({
        id: "agt_parent",
        placement: placementForRunner("linux"),
        cwd: "/srv/review",
      } as never);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents/agt_parent/launch-persona",
        payload: {
          personas: ["security-review"],
          codeowners: true,
          agentType: "opencode",
          model: "runner-custom/review",
          effort: "runner-effort",
        },
      });
      expect(response.statusCode).toBe(200);
      const [, input] = deps.streams.promptAgent.mock.calls[0]!;
      expect(input.text).toContain('model: "runner-custom/review"');
      expect(input.text).toContain('effort: "runner-effort"');
      if (source !== "taught") {
        expect(
          validationFixtures[0]!.call.mock.calls.filter(
            ([op]) => op === "engine.models"
          )
        ).toHaveLength(1);
        const learned = getLearnedAgentModels("opencode", "linux");
        if (source === "first refresh")
          expect(learned?.[0]?.id).toBe("runner-custom/review");
        else expect(learned).toBeUndefined();
      }
    }
  );

  it("asks the agent to launch the personas itself, with the user's note", async () => {
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
    expect(input.text).not.toContain("includeDiff");
    expect(input.text).toContain("prompt: <your briefing>");
    expect(input.text).toContain("From the user: Focus on the auth changes.");
    expect(input.text).toContain("its reviewer resolves it");
  });

  it("asks the agent to launch the code owners with no personas picked", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-persona",
      payload: {
        personas: [],
        codeowners: true,
        agentType: "claude",
        model: "opus",
      },
    });
    expect(response.statusCode).toBe(200);
    const [, input] = deps.streams.promptAgent.mock.calls[0]!;
    expect(input.description).toBe("Review requested: code owners");
    expect(input.text).toContain("Please launch the code owners on your");
    // The owner tool's runtime arg is `agentType`, unlike launch_agent's `type`.
    expect(input.text).toContain(
      'launch_owner_reviews({ agentType: "claude", model: "opus", context: <your briefing> })'
    );
    expect(input.text).not.toContain('type: "claude", ');
    expect(input.text).not.toContain("launch_agent(");
    expect(input.text).not.toContain("includeDiff");
  });

  it("lists the code owners ahead of hand-picked personas", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-persona",
      payload: {
        personas: ["security-review"],
        codeowners: true,
        agentType: "codex",
      },
    });
    expect(response.statusCode).toBe(200);
    const [, input] = deps.streams.promptAgent.mock.calls[0]!;
    expect(input.description).toBe(
      "Review requested: code owners, security-review"
    );
    expect(input.text).toContain(
      "Please launch the code owners and the security-review persona on your"
    );
    expect(input.text.indexOf("launch_owner_reviews(")).toBeLessThan(
      input.text.indexOf('launch_agent({ persona: "security-review"')
    );
    // A picked persona can also be an owner; the agent must not launch it
    // twice, but may still launch one the owner pass failed on.
    expect(input.text).toContain("Run launch_owner_reviews first");
    expect(input.text).toContain("skip the launch_agent line");
    expect(input.text).toContain("`failures`");
  });

  it("omits the overlap rule when nothing can overlap", async () => {
    for (const payload of [
      { personas: [], codeowners: true, agentType: "codex" },
      { personas: ["security-review"], agentType: "codex" },
    ]) {
      deps.streams.promptAgent.mockClear();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents/agt_parent/launch-persona",
        payload,
      });
      expect(response.statusCode).toBe(200);
      const [, input] = deps.streams.promptAgent.mock.calls[0]!;
      expect(input.text).not.toContain("Run launch_owner_reviews first");
    }
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

it("checks the selected reviewer model's effort before posting a review request", async () => {
  const { setLearnedAgentModels, forgetLearnedAgentModels } =
    await import("../src/shared/agent-models.js");
  setLearnedAgentModels(
    "codex",
    [
      { id: "a", label: "A", effort: [{ value: "low", name: "Low" }] },
      { id: "b", label: "B", effort: [{ value: "max", name: "Max" }] },
    ],
    "a"
  );
  try {
    for (const [effort, status] of [
      ["max", 200],
      ["low", 400],
    ] as const) {
      const r = await app.inject({
        method: "POST",
        url: "/api/v1/agents/agt_parent/launch-persona",
        payload: {
          persona: "security-review",
          agentType: "codex",
          model: "b",
          effort,
        },
      });
      expect(r.statusCode).toBe(status);
    }
  } finally {
    forgetLearnedAgentModels();
  }
});
