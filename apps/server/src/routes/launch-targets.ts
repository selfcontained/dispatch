import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TemplateService } from "../templates/service.js";
import type { TaskService } from "../tasks/service.js";
import {
  controllerPlacement,
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
  location: { kind: "folder" | "project" };
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
  async function targets(request: FastifyRequest): Promise<Target[]> {
    const controller = runnerIdForPlacement(controllerPlacement);
    const { runners } = await read<{
      runners: Array<{ id: string; name: string; status: string }>;
    }>(request, "/api/runners");
    return [
      {
        key: keyFor(controller),
        id: controller,
        name: "This computer",
        location: { kind: "folder" as const },
        status: "online",
      },
      ...runners
        .filter((r) => r.status !== "revoked")
        .map((r) => ({
          key: keyFor(r.id),
          id: r.id,
          name: r.name,
          status: r.status,
          location: { kind: "project" as const },
        })),
    ];
  }
  const fields = (target: Target) =>
    target.location.kind === "folder" ? {} : { runner: target.id };
  const publicTarget = (target: Target) => ({
    key: target.key,
    name: target.name,
    status: target.status,
    location: target.location,
    dataUrl: `${ROOT}/${target.key}`,
    launchFields: fields(target),
    selectionFields: { runner: target.id },
  });
  async function selected(request: FastifyRequest) {
    const { key } = request.params as { key: string };
    const target = (await targets(request)).find((t) => t.key === key);
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
    const choices = await targets(request);
    let projectError: string | undefined;
    let repositories: Array<Project & { repository: string | null }> = [];
    if (choices.some((t) => t.location.kind === "project")) {
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
        location:
          t.location.kind === "project"
            ? {
                ...t.location,
                projects: repositories.filter((p) => p.repository),
                ...(projectError && { error: projectError }),
              }
            : t.location,
      })),
    };
  });

  app.get(`${ROOT}/saved/:kind/:id`, async (request) => {
    const { kind, id } = request.params as { kind: string; id: string };
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
    const target = (await targets(request)).find((t) => t.id === idOnServer);
    return {
      targetKey: keyFor(idOnServer),
      inherited,
      projectId: projectId ?? saved.projectId ?? null,
      directory: target?.location.kind === "folder" ? saved.directory : "",
      launchFields: inherited
        ? {}
        : target
          ? fields(target)
          : { runner: idOnServer },
    };
  });

  app.get(`${ROOT}/:key/branches`, async (request, reply) => {
    const target = await selected(request);
    const q = request.query as { directory?: string; projectId?: string };
    if (target.location.kind === "folder")
      return read(
        request,
        `/api/v1/git/branches?${query({ cwd: q.directory })}`
      );
    if (!q.projectId)
      return reply.code(400).send({ error: "Choose a runner and repository." });
    const repository = await read<{ url: string | null }>(
      request,
      `/api/v1/projects/${encodeURIComponent(q.projectId)}/repository`
    );
    return read(
      request,
      `/api/v1/git/branches?${query({ runnerId: target.id, repository: repository.url ?? "" })}`
    );
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
    const directory = p?.repoRoot ?? q.directory ?? "";
    const settings = await read<{ enabledAgentTypes: string[] }>(
      request,
      "/api/v1/app/settings/agent-types"
    );
    const engine = q.agentType ?? settings.enabledAgentTypes[0] ?? "claude";
    let catalog: Catalog;
    let engines: unknown;
    let engineOptions: EngineOption[] | null;
    let agentTypes = settings.enabledAgentTypes;
    if (target.location.kind === "folder") {
      const [models, statuses] = await Promise.all([
        read<Catalog>(request, "/api/v1/agent-models"),
        read<{ engines: EngineOption[] }>(request, "/api/v1/system/engines"),
      ]);
      catalog = models;
      engines = statuses;
      engineOptions = statuses.engines;
    } else {
      const inventory = await read<{ entries: EngineOption[] | null }>(
        request,
        `/api/v1/engine-management/inventory?${query({ scope: "runner", runnerId: target.id })}`
      );
      engines = inventory;
      // Installation instructions are the existing platform-independent CLI
      // metadata; installation/sign-in status always comes from this target.
      const metadata = await read<{ engines: EngineOption[] }>(
        request,
        "/api/v1/system/engines"
      );
      engineOptions =
        inventory.entries?.map((entry) => ({
          ...entry,
          install: metadata.engines.find((m) => m.id === entry.id)?.install,
        })) ?? null;
      agentTypes = inventory.entries?.map((e) => e.id) ?? agentTypes;
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
        scope: { kind: "runner", runnerId: target.id },
        operation: {
          type: "model_catalog",
          engine,
          ...(q.model && { model: q.model }),
        },
      });
      if (!ack.ok)
        throw Object.assign(
          new Error(
            ack.error ?? "The runner did not return the requested engine data."
          ),
          { statusCode: 503 }
        );
      if (ack.capability?.type !== "model_catalog")
        throw Object.assign(
          new Error("The runner did not return the requested engine data."),
          { statusCode: 503 }
        );
      const result = ack.capability.catalog;
      catalog = {
        models: { [engine]: result.models },
        defaults: result.defaultModel ? { [engine]: result.defaultModel } : {},
        availability: {},
      };
    }
    const located = resolveSavedTarget(directory, {
      runner: target.id,
      projectId: q.projectId,
      projectRoot: p?.repoRoot ?? undefined,
    });
    const branchQuery = query({
      directory: target.location.kind === "folder" ? directory : undefined,
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
      directory: target.location.kind === "folder" ? directory : "",
      branchesUrl: `${ROOT}/${target.key}/branches?${branchQuery}`,
      personasUrl: `/api/v1/personas?${query({ cwd: located.directory, projectId: q.projectId, type: "task" })}`,
      defaults: {
        baseBranch: target.location.kind === "folder" ? "main" : "",
        preferenceKey:
          target.location.kind === "folder"
            ? directory.trim()
            : JSON.stringify([target.key, q.projectId ?? null]),
        launchFields: fields(target),
      },
    };
  });
}
