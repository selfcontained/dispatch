import { resolveSavedTarget } from "../src/runners/saved-location.js";
import { PROJECT_IDENTITY_SQL } from "../src/runners/repository-identity.js";
import { placementForRunner } from "../src/runners/placement.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { RunnerCapabilityUnavailable } from "../src/agents/remote/service.js";
import { personaScopeFor } from "./helpers/persona-scope.js";
import { registerMcpRoutes } from "../src/routes/mcp.js";
import { handleMcpRequest } from "../src/shared/mcp/server.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../../../packages/runner/src/workload/shared/git/git-context.js";

// The routes hijack the reply and hand the raw socket to the MCP transport,
// so the stub has to end the response itself or `inject` never settles.
vi.mock("../src/shared/mcp/server.js", () => ({
  handleMcpRequest: vi.fn(
    async (_req: unknown, res: { end: (body?: string) => void }) => {
      res.end("{}");
    }
  ),
}));

vi.mock(
  "../../../packages/runner/src/workload/shared/git/git-context.js",
  () => ({
    resolveRepoRoot: vi.fn(async () => "/repo"),
    resolveWorktreeRoot: vi.fn(async () => "/repo"),
  })
);

vi.mock("../src/agents/telemetry.js", () => ({
  getFeedbackSummary: vi.fn(async () => ({})),
}));

function createMockDeps() {
  return {
    config: { authToken: "test-auth-token" },
    redeemCodexReset: vi.fn(),
    providerPlans: vi.fn(async () => ({
      checkedAt: "2026-09-24T12:00:00Z",
      providers: [],
    })),
    // Only the chat-surface flag reads it from these routes.
    pool: { query: vi.fn(async () => ({ rows: [] })) } as never,
    agentManager: {
      inspectCheckout: vi.fn(
        async (
          _record: { cwd: string },
          _query: { kind: string }
        ): Promise<unknown> => ({
          kind: "roots",
          checkoutRoot: "/repo",
          repositoryRoot: "/repo",
        })
      ),
      readRepoManifest: vi.fn(async () => {
        throw new RunnerCapabilityUnavailable(
          "This runner version does not support checkout commands."
        );
      }),
      permitsRemoteAgentMcp: vi.fn(() => false),
      // Persona authoring reaches the caller's checkout through its runner.
      checkoutReadRunners: vi.fn(() => ({})),
      getAgent: vi.fn(async () => ({
        id: "agt_test1",
        cwd: "/tmp/test",
        placement: placementForRunner("local"),
        persona: null,
        parentAgentId: null,
        baseBranch: "main",
        status: "idle",
        name: "test-agent",
      })),
      listAgents: vi.fn(async () => []),
    },
    jobService: {
      listJobs: vi.fn(async () => []),
      getJobById: vi.fn(async () => null),
      getJobByName: vi.fn(async () => null),
      addJob: vi.fn(async () => ({ id: "job_1" })),
      updateJob: vi.fn(async () => ({ id: "job_1" })),
      removeJob: vi.fn(async () => undefined),
      runJob: vi.fn(async () => ({ id: "run_1" })),
      getActiveRunForAgent: vi.fn(async () => null),
    },
    templateService: {
      listTemplates: vi.fn(async () => []),
      getTemplate: vi.fn(async () => null),
      getTemplateByName: vi.fn(async () => null),
      addTemplate: vi.fn(async () => ({ id: "tpl_1" })),
      updateTemplate: vi.fn(async () => ({ id: "tpl_1" })),
      removeTemplate: vi.fn(async () => undefined),
    },
    brainStore: {} as never,
    publishBrainChanged: vi.fn(),
    publishUiEvent: vi.fn(),
    getBearerToken: vi.fn(() => "bearer-token"),
    validateJobMcpToken: vi.fn(() => true),
    validateAgentMcpToken: vi.fn(() => true),
    mcpSendNotify: vi.fn(),
    mcpUpsertEvent: vi.fn(),
    mcpRenameSession: vi.fn(),
    mcpShareFile: vi.fn(),
    mcpListFiles: vi.fn(),
    mcpSubmitFeedback: vi.fn(),
    mcpListPersonas: vi.fn(),
    mcpLaunchPersona: vi.fn(),
    mcpGetFeedback: vi.fn(),
    mcpResolveFeedback: vi.fn(),
    mcpSubmitResolution: vi.fn(),
    mcpCancelRecheck: vi.fn(),
    mcpUpsertPin: vi.fn(),
    mcpDeletePin: vi.fn(),
    mcpGetParentContext: vi.fn(),
    mcpGetRecheckContext: vi.fn(),
    mcpUpdateReviewStatus: vi.fn(),
    mcpCompleteReview: vi.fn(),
    mcpJobComplete: vi.fn(),
    mcpJobFailed: vi.fn(),
    mcpJobNeedsInput: vi.fn(),
    mcpJobLog: vi.fn(),
    mcpSendMessage: vi.fn(),
    mcpListAgentsForAgent: vi.fn(),
    mcpMethodNotAllowed: vi.fn(() => ({
      error: "Method not allowed. Use POST for MCP requests.",
    })),
  };
}

let app: FastifyInstance;
let deps: ReturnType<typeof createMockDeps>;

beforeAll(async () => {
  app = Fastify();
  deps = createMockDeps();
  await registerMcpRoutes(
    app,
    deps as unknown as Parameters<typeof registerMcpRoutes>[1]
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  deps.agentManager.permitsRemoteAgentMcp.mockReturnValue(false);
  deps.agentManager.inspectCheckout.mockResolvedValue({
    kind: "roots",
    checkoutRoot: "/repo",
    repositoryRoot: "/repo",
  });
  deps.agentManager.getAgent.mockResolvedValue({
    id: "agt_test1",
    cwd: "/tmp/test",
    placement: placementForRunner("local"),
    persona: null,
    parentAgentId: null,
    baseBranch: "main",
    status: "idle",
    name: "test-agent",
  });
  deps.getBearerToken.mockReturnValue("bearer-token");
  deps.validateJobMcpToken.mockReturnValue(true);
  deps.validateAgentMcpToken.mockReturnValue(true);
  deps.jobService.getActiveRunForAgent.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Method-not-allowed (405) routes
// ---------------------------------------------------------------------------

describe("GET /api/mcp", () => {
  it("returns 405", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp" });
    expect(res.statusCode).toBe(405);
    expect(res.json().error).toMatch(/method not allowed/i);
  });
});

describe("DELETE /api/mcp", () => {
  it("returns 405", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/mcp" });
    expect(res.statusCode).toBe(405);
    expect(res.json().error).toMatch(/method not allowed/i);
  });
});

describe("GET /api/mcp/:agentId", () => {
  it("returns 405", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/agt_test1",
    });
    expect(res.statusCode).toBe(405);
    expect(res.json().error).toMatch(/method not allowed/i);
  });
});

describe("DELETE /api/mcp/:agentId", () => {
  it("returns 405", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/mcp/agt_test1",
    });
    expect(res.statusCode).toBe(405);
    expect(res.json().error).toMatch(/method not allowed/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/mcp/jobs/:runId/:agentId — auth and lookup branches
// ---------------------------------------------------------------------------

describe("POST /api/mcp/jobs/:runId/:agentId", () => {
  it("returns 403 when job MCP token is invalid", async () => {
    deps.validateJobMcpToken.mockReturnValue(false);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_1/agt_test1",
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/invalid mcp token/i);
  });

  it("returns 404 when agent is not found", async () => {
    deps.agentManager.getAgent.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_1/agt_missing",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/agent not found/i);
  });

  it("returns 403 when run ID does not match the active run", async () => {
    deps.jobService.getActiveRunForAgent.mockResolvedValue({
      id: "run_OTHER",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_1/agt_test1",
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/does not match/i);
  });

  it("skips token validation when no bearer token is present", async () => {
    deps.getBearerToken.mockReturnValue(null);
    deps.agentManager.getAgent.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_1/agt_test1",
      payload: {},
    });
    // Token validation is skipped — the route continues to the agent lookup
    expect(deps.validateJobMcpToken).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/mcp/:agentId — auth and lookup branches
// ---------------------------------------------------------------------------

describe("POST /api/mcp/:agentId", () => {
  it("returns 403 when agent MCP token is invalid", async () => {
    deps.validateAgentMcpToken.mockReturnValue(false);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_test1",
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/invalid mcp token/i);
  });

  it("returns 404 when agent is not found", async () => {
    deps.agentManager.getAgent.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_missing",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/agent not found/i);
  });

  it("returns 403 when agent has an active job run", async () => {
    deps.jobService.getActiveRunForAgent.mockResolvedValue({
      id: "run_active",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_test1",
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/job-scoped mcp route/i);
  });

  it("skips token validation when no bearer token is present", async () => {
    deps.getBearerToken.mockReturnValue(null);
    deps.agentManager.getAgent.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_test1",
      payload: {},
    });
    expect(deps.validateAgentMcpToken).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });
});

describe("usage callback wiring", () => {
  it.each(["/api/mcp/agt_test1", "/api/mcp/jobs/run_1/agt_test1"])(
    "provides the shared reporter to %s",
    async (url) => {
      const res = await app.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode).toBe(200);
      const context = vi.mocked(handleMcpRequest).mock.calls.at(-1)?.[3];
      expect(context?.providerPlans).toBe(deps.providerPlans);
      // No setting stored → every type launchable, read through the pool.
      await expect(context?.enabledAgentTypes?.()).resolves.toEqual([
        "claude",
        "codex",
        "opencode",
      ]);
    }
  );
});

describe("runner-scoped manifests", () => {
  // One rule for every runner caller (N15): the credential does not gate tools.
  it.each([true, false])(
    "explains why a listed runner tool cannot execute (session credential: %s)",
    async (credential) => {
      const reason = /runner version does not support checkout commands/i;
      deps.agentManager.permitsRemoteAgentMcp.mockReturnValue(true);
      deps.getBearerToken.mockReturnValue(credential ? "bearer-token" : "");
      deps.agentManager.getAgent.mockResolvedValue({
        ...(await deps.agentManager.getAgent()),
        cwd: "/srv/alpha",
        placement: placementForRunner("rnr_alpha"),
      });
      deps.agentManager.inspectCheckout.mockImplementation(
        async (_agent, query) =>
          query.kind === "roots"
            ? {
                kind: "roots",
                checkoutRoot: "/work/repo",
                repositoryRoot: "/work/repo",
              }
            : {
                kind: "readFile",
                content: JSON.stringify({
                  tools: [
                    { name: "proof", description: "Proof", command: ["true"] },
                  ],
                }),
              }
      );
      const result = await app.inject({
        method: "POST",
        url: "/api/mcp/agt_test1",
        payload: {},
      });
      expect(result.statusCode).toBe(200);
      const context = vi.mocked(handleMcpRequest).mock.calls.at(-1)?.[3];
      const [tool] = (await context?.discoverRepoTools?.()) ?? [];
      expect(tool?.name).toBe("repo_proof");
      expect(deps.agentManager.readRepoManifest).toHaveBeenCalledTimes(1);
      const invocation = tool!.run({
        agentId: "agt_test1",
        repoRoot: "/work/repo",
      });
      await expect(invocation).rejects.toThrow(/repository tool unavailable/i);
      await expect(invocation).rejects.toThrow(reason);
    }
  );

  it("keeps identical remote paths separate and reads edits on the next request", async () => {
    deps.agentManager.permitsRemoteAgentMcp.mockReturnValue(true);
    const agent = await deps.agentManager.getAgent();
    const manifests = new Map([
      ["/srv/alpha", "alpha"],
      ["/srv/beta", "beta"],
    ]);
    deps.agentManager.inspectCheckout.mockImplementation(
      async (record, query) => {
        if (query.kind === "roots")
          return {
            kind: "roots",
            checkoutRoot: "/work/repo",
            repositoryRoot: "/work/repo",
          };
        const description = manifests.get(record.cwd);
        return {
          kind: "readFile",
          content: description
            ? JSON.stringify({
                tools: [{ name: "proof", command: ["true"], description }],
              })
            : null,
        };
      }
    );
    const list = async (cwd: string) => {
      deps.agentManager.getAgent.mockResolvedValue({
        ...agent,
        cwd,
        placement: placementForRunner(
          cwd === "/srv/alpha" ? "rnr_alpha" : "rnr_beta"
        ),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/mcp/agt_test1",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const context = vi.mocked(handleMcpRequest).mock.calls.at(-1)?.[3];
      expect(context).toMatchObject({ repoRoot: null, worktreeRoot: null });
      return context?.discoverRepoTools?.();
    };
    await expect(list("/srv/alpha")).resolves.toMatchObject([
      { name: "repo_proof", description: "alpha" },
    ]);
    await expect(list("/srv/beta")).resolves.toMatchObject([
      { name: "repo_proof", description: "beta" },
    ]);
    manifests.set("/srv/beta", "updated");
    await expect(list("/srv/beta")).resolves.toMatchObject([
      { name: "repo_proof", description: "updated" },
    ]);
    manifests.delete("/srv/beta");
    await expect(list("/srv/beta")).resolves.toEqual([]);
    expect(resolveRepoRoot).not.toHaveBeenCalled();
    expect(resolveWorktreeRoot).not.toHaveBeenCalled();
  });
});

describe("owner review checkout boundary", () => {
  it.each(["/api/mcp/agt_test1", "/api/mcp/jobs/run_1/agt_test1"])(
    "skips host checkout discovery for owner calls on %s",
    async (url) => {
      const call = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "launch_owner_reviews",
          arguments: { context: "Review" },
        },
      };
      for (const payload of [call, [call, { ...call, id: 2 }]]) {
        const res = await app.inject({ method: "POST", url, payload });
        expect(res.statusCode).toBe(200);
        expect(handleMcpRequest).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.anything(),
          payload,
          expect.objectContaining({ repoRoot: null, worktreeRoot: null })
        );
        expect(resolveRepoRoot).not.toHaveBeenCalled();
        expect(resolveWorktreeRoot).not.toHaveBeenCalled();
      }
      const res = await app.inject({
        method: "POST",
        url,
        payload: [call, { ...call, id: 2, params: { name: "list_personas" } }],
      });
      expect(res.statusCode).toBe(200);
      expect(deps.agentManager.inspectCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/tmp/test" }),
        { kind: "roots" }
      );
      expect(resolveRepoRoot).not.toHaveBeenCalled();
      expect(resolveWorktreeRoot).not.toHaveBeenCalled();
    }
  );
});

describe("job access ceiling wiring", () => {
  it.each([
    ...["/api/mcp/agt_test1", "/api/mcp/jobs/run_1/agt_test1"].flatMap(
      (url) => [
        { url, role: null, fullAccess: false, callerAccess: false },
        { url, role: null, fullAccess: true, callerAccess: true },
        { url, role: "review", fullAccess: true, callerAccess: true },
        { url, role: "review", fullAccess: false, callerAccess: false },
      ]
    ),
  ])(
    "passes caller access for $url with role $role and engine access $fullAccess",
    async ({ url, role, fullAccess, callerAccess }) => {
      const agent = await deps.agentManager.getAgent();
      deps.agentManager.getAgent.mockResolvedValue({
        ...agent,
        role,
        fullAccess,
      } as never);
      await app.inject({ method: "POST", url, payload: {} });
      const context = vi.mocked(handleMcpRequest).mock.calls.at(-1)?.[3];
      expect(context?.agent?.fullAccess).toBe(callerAccess);
      const callbacks = context?.crudTools;
      expect(callbacks).toBeDefined();
      const input = { name: "job", directory: "/tmp" };
      await callbacks!.createJob(input);
      await callbacks!.updateJob({ jobId: "job_1", prompt: "updated" });
      await callbacks!.runJob("job_1");
      await callbacks!.createTemplate(input);
      await callbacks!.updateTemplate("tpl_1", input);
      // Saved targets record the caller's runner (local here).
      const saved = { ...input, runner: "local" };
      expect(deps.jobService.addJob).toHaveBeenCalledWith(
        saved,
        callerAccess,
        expect.any(Function)
      );
      expect(deps.jobService.updateJob).toHaveBeenCalledWith(
        { jobId: "job_1", prompt: "updated" },
        callerAccess,
        expect.any(Function)
      );
      expect(deps.jobService.runJob).toHaveBeenCalledWith({
        jobId: "job_1",
        wait: false,
        callerFullAccess: callerAccess,
      });
      expect(deps.templateService.addTemplate).toHaveBeenCalledWith(
        saved,
        callerAccess,
        expect.any(Function)
      );
      expect(deps.templateService.updateTemplate).toHaveBeenCalledWith(
        "tpl_1",
        input,
        callerAccess,
        expect.any(Function)
      );
      // Local agents: the scope resolves exactly as the services' default.
      const scope = vi.mocked(deps.jobService.addJob).mock.calls.at(-1)![2]!;
      const target = { cwd: "/tmp", projectRoot: "/tmp" };
      const selected = scope(target);
      expect(selected).toEqual({
        ...personaScopeFor(target),
        runners: expect.any(Function),
      });
      if (selected.kind === "folder")
        expect(selected.runners()).toEqual(
          deps.agentManager.checkoutReadRunners()
        );
    }
  );
});

describe("Codex reset dependency forwarding", () => {
  it.each([false, true])(
    "forwards reset only with scoped bearer (job=%s)",
    async (job) => {
      const url = job
        ? "/api/mcp/jobs/run_test/agt_test1"
        : "/api/mcp/agt_test1";
      await app.inject({
        method: "POST",
        url,
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(
        vi.mocked(handleMcpRequest).mock.calls.at(-1)?.[3]?.redeemCodexReset
      ).toBe(deps.redeemCodexReset);
      vi.mocked(handleMcpRequest).mockClear();
      deps.getBearerToken.mockReturnValue(null as never);
      await app.inject({
        method: "POST",
        url,
        headers: { cookie: "session=browser-only" },
        payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
      expect(
        vi.mocked(handleMcpRequest).mock.calls.at(-1)?.[3]?.redeemCodexReset
      ).toBeUndefined();
    }
  );

  it.each([false, true])(
    "refuses invalid bearer before forwarding (job=%s)",
    async (job) => {
      deps.validateAgentMcpToken.mockReturnValue(false);
      deps.validateJobMcpToken.mockReturnValue(false);
      const url = job
        ? "/api/mcp/jobs/run_test/agt_test1"
        : "/api/mcp/agt_test1";
      const response = await app.inject({
        method: "POST",
        url,
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(response.statusCode).toBe(403);
      expect(handleMcpRequest).not.toHaveBeenCalled();
      expect(deps.redeemCodexReset).not.toHaveBeenCalled();
    }
  );
});

it("denies agent MCP after the agent's runner registration is revoked", async () => {
  const agent = await deps.agentManager.getAgent();
  deps.agentManager.getAgent.mockResolvedValueOnce({
    ...agent,
    cwd: "/srv/old",
    placement: placementForRunner("rnr_old"),
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/mcp/agt_test1",
    payload: {},
  });
  expect(response.statusCode).toBe(403);
  expect(deps.agentManager.permitsRemoteAgentMcp).toHaveBeenCalledWith(
    "rnr_old"
  );
  expect(deps.jobService.getActiveRunForAgent).not.toHaveBeenCalled();
});

describe("repository-only Local MCP scope", () => {
  it.each([false, true])(
    "uses project identity unless the workspace moved (%j)",
    async (moved) => {
      const deps = createMockDeps();
      const agent = await deps.agentManager.getAgent();
      deps.agentManager.getAgent.mockResolvedValue({
        ...agent,
        projectId: "prj_repo",
        workspacePath: moved ? "/moved" : null,
      } as typeof agent);
      vi.mocked(deps.pool.query).mockResolvedValue({
        rows: [{ repoRoot: null, repository: "https://github.com/o/r" }],
      } as never);
      const app = Fastify();
      await registerMcpRoutes(app, deps as never);
      try {
        const result = await app.inject({
          method: "POST",
          url: "/api/mcp/agt_test1",
          payload: {},
        });
        expect(result.statusCode).toBe(200);
        expect(
          vi.mocked(handleMcpRequest).mock.calls.at(-1)?.[3]
        ).toMatchObject({
          brainRepoRoot: moved ? "/repo" : "https://github.com/o/r",
        });
      } finally {
        await app.close();
      }
    }
  );
});

describe("implicit MCP saved-project defaults", () => {
  it.each(["local", "fixture"])(
    "scopes names, lists and creates to the caller's project on %s",
    async (runner) => {
      const deps = createMockDeps();
      const agent = {
        ...(await deps.agentManager.getAgent()),
        projectId: "prj_repo",
        placement: placementForRunner(runner),
        cwd: "/managed/cache/checkout",
      };
      deps.agentManager.getAgent.mockResolvedValue(agent);
      deps.agentManager.permitsRemoteAgentMcp.mockReturnValue(true);
      vi.mocked(deps.pool.query).mockImplementation(
        async (sql) =>
          ({
            rows:
              sql === PROJECT_IDENTITY_SQL
                ? [{ repoRoot: null, repository: "https://github.com/o/r" }]
                : [],
          }) as never
      );
      const saved = (id: string, projectId: string, targetRunner = runner) => ({
        ...resolveSavedTarget("", { runner: targetRunner, projectId }),
        id,
        name: "daily",
        projectId,
      });
      const own = saved("own", "prj_repo");
      const other = saved("other", "prj_other");
      const elsewhere = saved(
        "elsewhere",
        "prj_repo",
        runner === "local" ? "fixture" : "local"
      );
      deps.jobService.listJobs.mockResolvedValue([
        other,
        elsewhere,
        own,
      ] as never);
      deps.templateService.listTemplates.mockResolvedValue([
        other,
        elsewhere,
        own,
      ] as never);
      const app = Fastify();
      await registerMcpRoutes(app, deps as never);
      try {
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/mcp/agt_test1",
              payload: {},
            })
          ).statusCode
        ).toBe(200);
        const callbacks = vi
          .mocked(handleMcpRequest)
          .mock.calls.at(-1)?.[3]?.crudTools;
        expect(await callbacks!.listJobs(agent.cwd, true)).toEqual([own]);
        expect(await callbacks!.listTemplates(agent.cwd, true)).toEqual([own]);
        expect(await callbacks!.getJobByName(agent.cwd, "daily", true)).toEqual(
          own
        );
        expect(
          await callbacks!.getTemplateByName(agent.cwd, "daily", true)
        ).toEqual(own);
        expect(
          await callbacks!.getJobByName(agent.cwd, "missing", true)
        ).toBeNull();
        for (const create of [callbacks!.createJob, callbacks!.createTemplate])
          await create({ name: "new", directory: agent.cwd }, true);
        const target = {
          name: "new",
          directory: "",
          projectId: "prj_repo",
          runner,
        };
        expect(deps.jobService.addJob).toHaveBeenCalledWith(
          target,
          false,
          expect.any(Function)
        );
        expect(deps.templateService.addTemplate).toHaveBeenCalledWith(
          target,
          false,
          expect.any(Function)
        );
        // An explicitly supplied Local folder remains a folder, including the caller's path.
        if (runner === "local") {
          await callbacks!.createTemplate(
            { name: "folder", directory: agent.cwd },
            false
          );
          expect(deps.templateService.addTemplate).toHaveBeenLastCalledWith(
            { name: "folder", directory: agent.cwd, runner: "local" },
            false,
            expect.any(Function)
          );
          await callbacks!.getTemplateByName(agent.cwd, "daily", false);
          expect(deps.templateService.getTemplateByName).toHaveBeenCalledWith(
            agent.cwd,
            "daily",
            "local"
          );
        }
      } finally {
        await app.close();
      }
    }
  );

  it.each(["folder", "moved"])(
    "preserves implicit Local %s targets",
    async (kind) => {
      const deps = createMockDeps();
      const agent = {
        ...(await deps.agentManager.getAgent()),
        projectId: "prj_repo",
        workspacePath: kind === "moved" ? "/moved" : null,
      };
      deps.agentManager.getAgent.mockResolvedValue(agent);
      vi.mocked(deps.pool.query).mockResolvedValue({
        rows: [
          {
            repoRoot: kind === "folder" ? "/repo" : null,
            repository: "https://github.com/o/r",
          },
        ],
      } as never);
      const app = Fastify();
      await registerMcpRoutes(app, deps as never);
      try {
        await app.inject({
          method: "POST",
          url: "/api/mcp/agt_test1",
          payload: {},
        });
        const callbacks = vi
          .mocked(handleMcpRequest)
          .mock.calls.at(-1)?.[3]?.crudTools;
        const directory = agent.workspacePath ?? agent.cwd;
        await callbacks!.createTemplate({ name: "old", directory }, true);
        expect(deps.templateService.addTemplate).toHaveBeenCalledWith(
          { name: "old", directory, runner: "local" },
          false,
          expect.any(Function)
        );
      } finally {
        await app.close();
      }
    }
  );
});
