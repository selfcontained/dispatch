import {
  modelChoicesForRunner,
  getAgentModelAvailability,
  getReportedModelHistory,
  readStoredModelCatalog,
} from "../shared/agent-models.js";
import type { AgentType } from "../shared/agent-types.js";
import { identityKey } from "../runners/repository-identity.js";
import type { AgentManager } from "../agents/manager.js";
import {
  sameRunner,
  pathFromWire,
  type Req,
} from "@dispatch/runner-protocol/contract";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TemplateService } from "../templates/service.js";
import type { TaskService } from "../tasks/service.js";
import type { CheckoutDirectory } from "../runners/directory.js";
import {
  controllerPlacement,
  placementForRunner,
  runnerIdForPlacement,
} from "../runners/placement.js";
import {
  resolveSavedTarget,
  targetPlacement,
} from "../runners/saved-location.js";

type Target = {
  key: string;
  name: string;
  id: string;
  location: {
    folders: boolean;
    repositories: boolean;
    repositorySearchUrl?: string;
  };
  sources: {
    directory: boolean;
    repository: boolean;
    defaultBaseBranch: string;
  };
  engineScope: import("@dispatch/runner-protocol/engine-management").EngineScope;
  launchFields: Record<string, string>;
  modelReports: "availability" | "history";
  status: string;
};
type Project = {
  id: string;
  repoRoot: string | null;
  [field: string]: unknown;
};
type EngineOption = {
  id: string;
  installed?: boolean;
  install?: string;
  [field: string]: unknown;
};
type Model = { id: string; effort?: unknown };
type Catalog = {
  models: Record<string, Model[]>;
  defaults?: Record<string, string>;
  availability?: unknown;
};
const ROOT = "/api/v1/launch-targets";
const keyFor = (id: string) =>
  createHash("sha256").update(`dispatch-launch-target\0${id}`).digest("hex");
const query = (values: Record<string, string | undefined>) => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values))
    if (value !== undefined) params.set(name, value);
  return params.toString();
};

/** Additive read adapter. Existing routes own validation, auth and results.
 * Keys and generated read URLs are opaque to clients; runner IDs travel only
 * in the server-provided launch fields, which forms submit without inspecting.
 */
export async function registerLaunchTargetRoutes(
  app: FastifyInstance,
  deps: {
    runners: Pick<CheckoutDirectory, "for" | "managementList">;
    agents: Pick<AgentManager, "getAgent">;
    templates: Pick<TemplateService, "getTemplate">;
    tasks: Pick<TaskService, "store">;
  }
) {
  async function read<T>(
    request: FastifyRequest,
    url: string,
    payload?: object
  ): Promise<T> {
    const headers = { ...request.headers };
    delete headers["content-length"];
    delete headers["content-type"];
    const response = await app.inject({
      method: payload ? "POST" : "GET",
      url,
      headers,
      remoteAddress: request.ip,
      ...(payload && { payload }),
    });
    if (response.statusCode >= 400) {
      const body = response.json();
      throw Object.assign(new Error(body.error ?? "Request failed."), {
        statusCode: response.statusCode,
      });
    }
    return response.json() as T;
  }
  async function targets(): Promise<Target[]> {
    const runners = await deps.runners.managementList();
    return runners
      .filter((runner) => !("status" in runner) || runner.status !== "revoked")
      .map((entry) => {
        const runner = deps.runners.for(placementForRunner(entry.id));
        const sources = runner.describe().capabilities.sources ?? {
          directory: false,
          repository: true,
          defaultBaseBranch: "",
        };
        return {
          key: keyFor(entry.id),
          id: entry.id,
          name: entry.name,
          status: "status" in entry ? entry.status : "online",
          engineScope: entry.engineScope,
          launchFields: entry.launchFields,
          modelReports: runner.settings.modelReports,
          sources,
          location: {
            folders: sources.directory,
            repositories: sources.repository,
            ...(entry.repositoryPicker &&
              sources.repository && {
                repositorySearchUrl: `/api/v1/runners/${encodeURIComponent(entry.id)}/repository-search`,
              }),
          },
        };
      });
  }
  const fields = (target: Target) => target.launchFields;
  const publicTarget = (target: Target) => ({
    key: target.key,
    name: target.name,
    status: target.status,
    location: target.location,
    dataUrl: `${ROOT}/${target.key}`,
    branchesUrl: `${ROOT}/${target.key}/branches`,
    historyUrl: `${ROOT}/${target.key}/history`,
    defaultBaseBranch: target.sources.defaultBaseBranch,
    launchFields: fields(target),
    selectionFields: { runner: target.id },
  });
  async function selected(request: FastifyRequest) {
    const { key } = request.params as { key: string };
    const target = (await targets()).find((t) => t.key === key);
    if (!target)
      throw Object.assign(new Error("Runner not found."), { statusCode: 404 });
    return target;
  }
  async function project(request: FastifyRequest, id?: string) {
    return id
      ? read<Project>(request, `/api/v1/projects/${encodeURIComponent(id)}`)
      : undefined;
  }
  app.get(ROOT, async (request) => {
    const choices = await targets();
    let projectError: string | undefined;
    let repositories: Array<Project & { repository: string | null }> = [];
    if (choices.length) {
      try {
        const projects = await read<Project[]>(request, "/api/v1/projects");
        repositories = await Promise.all(
          projects.map(async (p) => {
            try {
              return {
                ...p,
                repository: (
                  await read<{ url: string | null }>(
                    request,
                    `/api/v1/projects/${encodeURIComponent(p.id)}/repository`
                  )
                ).url,
              };
            } catch (error) {
              projectError = (error as Error).message;
              return { ...p, repository: null };
            }
          })
        );
      } catch (error) {
        projectError = (error as Error).message;
      }
    }
    return {
      targets: choices.map((t) => ({
        ...publicTarget(t),
        location: {
          ...t.location,
          projects: repositories.filter(
            (p) =>
              (p.repoRoot && t.location.folders) ||
              (p.repository && t.location.repositories)
          ),
          ...(projectError && { error: projectError }),
        },
      })),
    };
  });

  app.get(`${ROOT}/:key/history`, async (request) => {
    const target = await selected(request);
    if (!target.location.folders) return { projects: [], projectOptions: [] };
    const q = request.query as {
      search?: string;
      limit?: string;
      candidates?: string;
    };
    const history = await read<{
      projects: string[];
      projectOptions: Array<{ path: string; iconUrl?: string }>;
    }>(
      request,
      `/api/v1/history/projects?${query({ search: q.search, limit: q.limit, runnerId: target.id })}`
    );
    const projectOptions = history.projectOptions;
    const candidates: unknown = q.candidates ? JSON.parse(q.candidates) : [];
    const folders = Array.isArray(candidates)
      ? candidates.filter(
          (candidate): candidate is string =>
            typeof candidate === "string" &&
            identityKey(
              targetPlacement({ directory: candidate }),
              candidate
            ) !== null &&
            (!q.search ||
              candidate.toLowerCase().includes(q.search.toLowerCase()))
        )
      : [];
    return {
      projects: [
        ...new Set([
          ...projectOptions.map((option) => option.path),
          ...folders,
        ]),
      ],
      projectOptions,
    };
  });

  app.get(`${ROOT}/saved/:kind/:id`, async (request) => {
    const { kind, id } = request.params as { kind: string; id: string };
    if (kind === "agent") {
      const agent = await deps.agents.getAgent(id);
      if (!agent)
        throw Object.assign(new Error("Agent not found."), { statusCode: 404 });
      const runner = runnerIdForPlacement(agent.placement);
      const target = (await targets()).find((t) => t.id === runner);
      if (!target)
        throw Object.assign(new Error("Runner not found."), {
          statusCode: 404,
        });
      const folder = agent.workspacePath
        ? agent.gitContext?.repoRoot?.trim() || agent.workspacePath.trim()
        : agent.launchCwd?.trim() ||
          agent.gitContext?.repoRoot?.trim() ||
          agent.cwd.trim();
      const reviewFolder =
        agent.workspacePath ?? agent.worktreePath ?? agent.cwd;
      return {
        targetKey: keyFor(runner),
        projectId: agent.projectId ?? null,
        directory: target?.location.folders ? folder : "",
        reviewPreferenceKey: target?.location.folders
          ? reviewFolder
          : JSON.stringify([keyFor(runner), agent.id]),
      };
    }
    let saved;
    let inherited = false;
    let projectId: string | null | undefined;
    if (kind === "template") saved = await deps.templates.getTemplate(id);
    else if (kind === "trigger") {
      const column = await deps.tasks.store.getColumn(id);
      if (!column)
        throw Object.assign(new Error("Column not found."), {
          statusCode: 404,
        });
      const template =
        column.trigger &&
        (await deps.templates.getTemplate(column.trigger.templateId));
      projectId = column.projectId;
      const p = await project(request, column.projectId);
      saved = column.trigger?.location
        ? resolveSavedTarget(template?.directory ?? p?.repoRoot ?? "", {
            ...column.trigger.location,
            projectId: column.projectId,
            projectRoot: p?.repoRoot ?? undefined,
          })
        : template;
      inherited = !column.trigger?.location;
    }
    if (!saved)
      throw Object.assign(new Error("Template not found."), {
        statusCode: 404,
      });
    const idOnServer = runnerIdForPlacement(targetPlacement(saved));
    const target = (await targets()).find((t) => t.id === idOnServer);
    return {
      targetKey: keyFor(idOnServer),
      inherited,
      projectId: projectId ?? saved.projectId ?? null,
      directory: target?.location.folders ? saved.directory : "",
      locationLabel: target?.location.folders
        ? saved.directory
        : ((await project(request, projectId ?? saved.projectId ?? undefined))
            ?.name ??
          target?.name ??
          ""),
      launchFields: inherited
        ? {}
        : target
          ? fields(target)
          : { runner: idOnServer },
    };
  });

  app.get(`${ROOT}/:key/branches`, async (request, reply) => {
    const selectedTarget = await selected(request);
    const q = request.query as { directory?: string; projectId?: string };
    let target: Req<"git.branches">["target"];
    try {
      const p = await project(request, q.projectId);
      if (selectedTarget.location.folders && (!p || p.repoRoot)) {
        const directory = q.directory?.trim() || p?.repoRoot;
        if (!directory) throw new Error("cwd query parameter is required.");
        target = { path: pathFromWire(directory) };
      } else {
        if (!q.projectId || !selectedTarget.location.repositories)
          throw new Error("Choose a runner and repository.");
        const repository = await read<{ url: string | null }>(
          request,
          `/api/v1/projects/${encodeURIComponent(q.projectId)}/repository`
        );
        if (!repository.url)
          throw new Error("Choose a valid HTTPS repository URL.");
        target = { repository: repository.url };
      }
    } catch (error) {
      return reply
        .code((error as { statusCode?: number }).statusCode ?? 400)
        .send({ error: (error as Error).message });
    }
    try {
      const runner = deps.runners.for(placementForRunner(selectedTarget.id));
      const result = await runner.call("git.branches", { target });
      return {
        ...result,
        branches: [...result.branches].sort((a, b) => {
          if (a === "main") return -1;
          if (b === "main") return 1;
          if (a === "master") return -1;
          if (b === "master") return 1;
          return a.localeCompare(b);
        }),
      };
    } catch (error) {
      request.log.error(
        {
          err: error,
          runnerId: selectedTarget.id,
          projectId: q.projectId,
          target,
        },
        "Failed to list remote branches."
      );
      return reply.code(500).send({ error: "Failed to list remote branches." });
    }
  });

  app.get(`${ROOT}/:key`, async (request) => {
    const target = await selected(request);
    const q = request.query as {
      directory?: string;
      projectId?: string;
      agentType?: string;
      model?: string;
    };
    const p = await project(request, q.projectId);
    const requestedDirectory = p ? (p.repoRoot ?? "") : (q.directory ?? "");
    const directory =
      target.location.folders &&
      !sameRunner(
        targetPlacement({ directory: requestedDirectory }),
        controllerPlacement
      )
        ? ""
        : requestedDirectory;
    const settings = await read<{ enabledAgentTypes: string[] }>(
      request,
      "/api/v1/app/settings/agent-types"
    );
    let engine = q.agentType ?? settings.enabledAgentTypes[0] ?? "claude";
    const inventory = await read<{ entries: EngineOption[] | null }>(
      request,
      `/api/v1/engine-management/inventory?${query({ scope: target.engineScope.kind, ...(target.engineScope.kind === "runner" && { runnerId: target.engineScope.runnerId }) })}`
    );
    const engines = inventory;
    const engineOptions = inventory.entries;
    const agentTypes = inventory.entries
      ? settings.enabledAgentTypes.filter((id) =>
          inventory.entries!.some((entry) => entry.id === id)
        )
      : settings.enabledAgentTypes;
    if (agentTypes.length && !agentTypes.includes(engine))
      engine = agentTypes[0]!;
    const { ack } = await read<{
      ack: {
        ok: boolean;
        error?: string;
        capability?: {
          type: string;
          catalog: { models: Model[]; defaultModel?: string };
        };
      };
    }>(request, "/api/v1/engine-management/operations", {
      scope: target.engineScope,
      operation: {
        type: "model_catalog",
        engine,
        ...(q.model && { model: q.model }),
      },
    });
    if (!ack.ok || ack.capability?.type !== "model_catalog")
      throw Object.assign(
        new Error(
          ack.error ?? "The runner did not return the requested engine data."
        ),
        { statusCode: 503 }
      );
    const result = ack.capability.catalog;
    const catalog: Catalog = {
      models: { [engine]: result.models },
      defaults: result.defaultModel ? { [engine]: result.defaultModel } : {},
      availability: {
        [engine]: {
          ...modelChoicesForRunner(target.id, engine as AgentType),
          unseen:
            target.modelReports === "availability"
              ? getAgentModelAvailability(engine as AgentType).unseen
              : getReportedModelHistory(target.id, engine as AgentType).unseen,
        },
      },
    };
    // Only the currently selected model is probed; catalog reads never enumerate effort.
    const selectedModel = q.model ?? catalog.defaults?.[engine];
    if (selectedModel)
      readStoredModelCatalog(target.id, engine as AgentType, selectedModel);
    const located = resolveSavedTarget(directory, {
      runner: target.id,
      projectId: q.projectId,
      projectRoot: p?.repoRoot ?? undefined,
    });
    const branchQuery = query({
      directory: target.location.folders ? directory : undefined,
      projectId: q.projectId,
    });
    return {
      ...publicTarget(target),
      agentTypes,
      engines,
      engineOptions,
      catalog,
      effort: catalog.models[engine]?.find(
        (m) => m.id === (q.model ?? catalog.defaults?.[engine])
      )?.effort,
      directory: target.location.folders ? directory : "",
      branchesUrl: `${ROOT}/${target.key}/branches?${branchQuery}`,
      personasUrl: `/api/v1/personas?${query({ cwd: located.directory, ...(!target.location.folders && { runner: target.id }), projectId: q.projectId, type: "task" })}`,
      defaults: {
        baseBranch: p && !p.repoRoot ? "" : target.sources.defaultBaseBranch,
        preferenceKey:
          target.location.folders && !(p && !p.repoRoot)
            ? directory.trim()
            : JSON.stringify([target.key, q.projectId ?? null]),
        launchFields: fields(target),
        templateFields: target.location.folders
          ? {}
          : { directory: located.directory },
      },
    };
  });
}
