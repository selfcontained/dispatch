import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import { vi } from "vitest";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerLaunchTargetRoutes } from "../src/routes/launch-targets.js";
import { resolveSavedTarget } from "../src/runners/saved-location.js";

const catalog = {
  models: {
    claude: [
      {
        id: "retained",
        label: "Retained",
        effort: [{ value: "high", name: "High" }],
      },
    ],
  },
  defaults: { claude: "retained" },
  availability: { claude: { disabled: ["retained"], unseen: [] } },
};
const template = {
  id: "template",
  directory: "/repo",
  projectId: "project",
  ...resolveSavedTarget("/repo", { runner: "fixture", projectId: "project" }),
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup(projectFailure = false) {
  const app = Fastify();
  apps.push(app);
  let catalogFailure = false;
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.authorization !== "Bearer fixture")
      return reply.code(401).send({ error: "Unauthorized" });
  });
  app.get("/api/runners", async () => ({
    runners: [
      { id: "fixture", name: "Fixture", status: "offline" },
      { id: "gone", name: "Gone", status: "revoked" },
    ],
  }));
  app.get("/api/v1/app/settings/agent-types", async () => ({
    enabledAgentTypes: ["claude", "codex"],
  }));
  app.get("/api/v1/agent-models", async () => catalog);
  app.get("/api/v1/system/engines", async (req) => ({
    canManage: req.ip === "192.0.2.4",
    engines: [
      { id: "claude", installed: false, install: "existing command" },
      { id: "codex", installed: true, install: "existing codex command" },
    ],
  }));
  app.get("/api/v1/projects", async (_request, reply) =>
    projectFailure
      ? reply.code(503).send({ error: "Fixture projects unavailable" })
      : [{ id: "project", repoRoot: "/repo" }]
  );
  app.get("/api/v1/projects/:id", async () => ({
    id: "project",
    repoRoot: "/repo",
  }));
  app.get("/api/v1/projects/:id/repository", async () => ({
    url: "https://github.com/fixture/repo",
  }));
  app.get("/api/v1/git/branches", async (req) => ({
    branches: ["main", "develop"],
    defaultBranch: "develop",
    query: req.query,
  }));
  app.get("/api/v1/personas", async (req) => ({
    personas: [{ slug: "review", name: "Review" }],
    query: req.query,
  }));
  app.get("/api/v1/engine-management/inventory", async () => ({
    entries: [{ id: "codex", installed: false, signedIn: false }],
  }));
  app.post("/api/v1/engine-management/operations", async () => ({
    ack: catalogFailure
      ? { ok: false, error: "Fixture unavailable" }
      : {
          ok: true,
          capability: {
            type: "model_catalog",
            catalog: {
              models: [{ id: "runner-model", effort: [{ value: "medium" }] }],
              defaultModel: "runner-model",
            },
          },
        },
  }));
  app.get("/api/v1/templates", async () => [template]);
  const branches = vi.fn(async (placement, op, input) => ({
    branches: ["develop", "main"],
    defaultBranch: "develop",
  }));
  await registerLaunchTargetRoutes(app, {
    agents: {
      getAgent: async (id: string) => ({
        id,
        placement: id.startsWith("controller")
          ? controllerPlacement
          : placementForRunner(id === "missing-target" ? "missing" : "fixture"),
        cwd: id.startsWith("controller") ? "/cwd" : "runner://fixture/@session",
        projectId: id === "unscoped" ? null : "project",
        ...(id === "controller-moved"
          ? {
              workspacePath: "/moved",
              gitContext: { repoRoot: " /moved/root " },
            }
          : { launchCwd: " /launch " }),
      }),
    } as never,
    runners: {
      for: (placement) => ({
        call: (op, input) => branches(placement, op, input),
      }),
    } as never,
    templates: { getTemplate: async () => template } as never,
    tasks: {
      store: {
        getColumn: async (id: string) => ({
          projectId: "project",
          trigger: {
            templateId: "template",
            ...(id === "explicit" && { location: { runner: "fixture" } }),
          },
        }),
      },
    } as never,
  });
  const get = async (url: string) =>
    app.inject({
      url,
      headers: { authorization: "Bearer fixture" },
      remoteAddress: "192.0.2.4",
    });
  const targets = (await get("/api/v1/launch-targets")).json().targets;
  return {
    app,
    get,
    targets,
    branches,
    failCatalog: () => {
      catalogFailure = true;
    },
  };
}

describe("launch target adapter", () => {
  it("requires the existing authentication and uses opaque keys with offline choices retained", async () => {
    const { app, targets } = await setup();
    expect(
      (await app.inject({ url: "/api/v1/launch-targets" })).statusCode
    ).toBe(401);
    expect(targets.map((t: any) => t.location.kind)).toEqual([
      "folder",
      "project",
    ]);
    expect(targets[1].status).toBe("offline");
    expect(targets[1].location.projects).toHaveLength(1);
    expect(targets[1].key).not.toContain("fixture");
    expect(targets[0].key).not.toBe("local");
    expect(targets[0].selectionFields).toEqual({ runner: "local" });
    expect(targets[0].launchFields).toEqual({});
  });
  it("delegates the controller reads unchanged, including availability and missing engines", async () => {
    const { get, targets } = await setup();
    const before = (await get("/api/v1/agent-models")).body;
    const response = await get(
      `${targets[0].dataUrl}?directory=%2Frepo&agentType=claude`
    );
    expect(response.statusCode).toBe(200);
    const data = response.json();
    expect(data.catalog).toEqual(catalog);
    expect(data.engines).toEqual((await get("/api/v1/system/engines")).json());
    expect(data.agentTypes).toEqual(["claude", "codex"]);
    expect(data.defaults.launchFields).toEqual({});
    expect(data.defaults.baseBranch).toBe("main");
    expect((await get(data.branchesUrl)).json()).toEqual({
      branches: ["main", "develop"],
      defaultBranch: "develop",
    });
    expect((await get("/api/v1/agent-models")).body).toBe(before);
    expect((await get(data.personasUrl)).statusCode).toBe(200);
  });
  it("reads the runner's catalog and project's repository without install/sign-in gates", async () => {
    const { get, targets, branches } = await setup();
    const response = await get(
      `${targets[1].dataUrl}?projectId=project&agentType=codex`
    );
    expect(response.statusCode).toBe(200);
    const data = response.json();
    expect(data.agentTypes).toEqual(["codex"]);
    expect(data.engineOptions[0].installed).toBe(false);
    expect(data.defaults.templateFields).toEqual({
      directory: "runner://fixture/@session",
    });
    expect(data.engineOptions[0].install).toBe("existing codex command");
    expect(data.catalog.models.codex[0].id).toBe("runner-model");
    expect(data.effort).toEqual([{ value: "medium" }]);
    expect(data.defaults.launchFields).toEqual({ runner: "fixture" });
    expect(data.directory).toBe("");
    await get(data.branchesUrl);
    expect(branches).toHaveBeenCalledWith(expect.anything(), "git.branches", {
      target: { repository: "https://github.com/fixture/repo" },
    });
    const personas = (await get(data.personasUrl)).json();
    expect(personas.query.projectId).toBe("project");
    expect(personas.query.cwd).toBe("runner://fixture/@session");
  });
  it("projects saved targets separately without altering existing template bytes", async () => {
    const { get, targets } = await setup();
    const before = (await get("/api/v1/templates")).body;
    for (const [kind, id, inherited] of [
      ["template", "template", false],
      ["trigger", "implicit", true],
      ["trigger", "explicit", false],
    ]) {
      const response = await get(`/api/v1/launch-targets/saved/${kind}/${id}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        targetKey: targets[1].key,
        projectId: "project",
        directory: "",
        inherited,
        locationLabel: "Fixture",
      });
    }
    expect((await get("/api/v1/templates")).body).toBe(before);
  });
  it("keeps the controller selectable when project choices fail", async () => {
    const { get, targets } = await setup(true);
    expect(targets[1].location.error).toBe("Fixture projects unavailable");
    expect((await get(targets[0].dataUrl)).statusCode).toBe(200);
  });
  it("surfaces a target data error without removing the target", async () => {
    const { get, targets, failCatalog } = await setup();
    failCatalog();
    expect((await get(targets[1].dataUrl)).statusCode).toBe(503);
    expect((await get("/api/v1/launch-targets")).json().targets).toEqual(
      targets
    );
  });
});

it.each([
  ["controller", 0, "/launch", "project"],
  ["controller-moved", 0, "/moved/root", "project"],
  ["enrolled", 1, "", "project"],
  ["unscoped", 1, "", null],
])(
  "projects agent %s without exposing another target’s path",
  async (id, index, directory, projectId) => {
    const { get, targets } = await setup();
    const result = (
      await get(`/api/v1/launch-targets/saved/agent/${id}`)
    ).json();
    expect(result).toMatchObject({
      targetKey: targets[index as number].key,
      directory,
      projectId,
    });
  }
);

it("derives a supported engine when changing targets from another engine", async () => {
  const { get, targets } = await setup();
  const result = (
    await get(`${targets[1].dataUrl}?projectId=project&agentType=claude`)
  ).json();
  expect(result.agentTypes).toEqual(["codex"]);
  expect(result.catalog.models.codex[0].id).toBe("runner-model");
});

it("does not project an unlisted agent target as the controller", async () => {
  const { get } = await setup();
  expect(
    (await get("/api/v1/launch-targets/saved/agent/missing-target")).statusCode
  ).toBe(404);
});
