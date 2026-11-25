import type { TaskService } from "../tasks/service.js";
import type { PublishUiEvent } from "../server/ui-events.js";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import * as z from "zod/v4";
import {
  inferProjectRepository,
  projectRepositoryUrl,
} from "../agents/remote/repository.js";
import type { AgentManager } from "../agents/manager.js";
import {
  detectAgentIcon,
  iconTarget,
  readAgentIcon,
} from "../agents/checkout-icon.js";
import { sessionRunner } from "../agents/checkout-runner.js";
import { runnerDirectory } from "../runners/directory.js";
import { checkoutReadPlacement } from "../runners/placement.js";
import {
  pathFromWire,
  type Runner,
  type Target,
} from "@dispatch/runner-protocol/contract";
import { ProjectStore } from "../projects/store.js";
import { parseInput } from "../shared/lib/parse-input.js";
import { resolveTilde } from "../shared/lib/resolve-tilde.js";
import { parseUserAvatar } from "../user-avatar-settings.js";
const appearance = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  iconOverride: z
    .string()
    .nullable()
    .default(null)
    .refine(
      (value) =>
        value === null ||
        parseUserAvatar({ kind: "image", dataUrl: value }) !== null,
      "Choose a valid prepared icon image."
    ),
});
export { resolveProjectRoot } from "../projects/resolve-root.js";
import { resolveProjectRoot } from "../projects/resolve-root.js";

const MAX_ICON_BYTES = 2 * 1024 * 1024;

function iconMime(icon: string) {
  const ext = path.extname(icon).toLowerCase();
  return ext === ".svg"
    ? "image/svg+xml"
    : ext === ".png"
      ? "image/png"
      : "image/x-icon";
}

/** The icon in a checkout as its runner reads it, with main's limits. */
async function readCheckoutIcon(runner: Runner, target: Target) {
  try {
    const icon = await detectAgentIcon(runner, target);
    if (!icon) return null;
    const bytes = await readAgentIcon(runner, target, icon);
    if (
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      bytes.length > MAX_ICON_BYTES
    )
      return null;
    return { bytes, mime: iconMime(icon), path: icon };
  } catch {
    return null;
  }
}

type IconAgents = Pick<AgentManager, "getAgent" | "checkoutReadRunners">;

/**
 * A project's repository icon, read through its runner: a folder on the
 * runner that holds it; a project with no folder through its newest agent's
 * launch checkout on that agent's runner, the agent main's folder history
 * links a folder's icon through.
 */
async function readProjectIcon(
  pool: Pool,
  agents: IconAgents | undefined,
  project: { id?: string; repoRoot: string | null }
) {
  const runners = agents?.checkoutReadRunners() ?? {};
  if (project.repoRoot) {
    const folder = resolveTilde(project.repoRoot);
    return readCheckoutIcon(
      runnerDirectory(runners).for(checkoutReadPlacement(folder)),
      { path: pathFromWire(folder) }
    );
  }
  if (!agents || !project.id) return null;
  const newest = (
    await pool.query<{ id: string }>(
      "SELECT id FROM agents WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1",
      [project.id]
    )
  ).rows[0];
  const agent = newest && (await agents.getAgent(newest.id));
  if (!agent) return null;
  return readCheckoutIcon(sessionRunner(runners, agent), iconTarget(agent));
}

export async function registerProjectRoutes(
  app: FastifyInstance,
  {
    pool,
    publishUiEvent,
    taskService,
    agents,
  }: {
    pool: Pool;
    /** Reads a folderless project's icon through its newest agent. */
    agents?: IconAgents;
    publishUiEvent: PublishUiEvent;
    taskService: Pick<
      TaskService,
      "taskIdsForProject" | "cleanupProjectAttachments"
    >;
  }
) {
  const store = new ProjectStore(pool);
  const snapshotRepositoryIcon = async (project: {
    id: string;
    repoRoot: string | null;
    iconOverride: string | null;
  }) => {
    if (project.iconOverride) return;
    const icon = await readProjectIcon(pool, agents, project);
    if (icon)
      await pool.query(
        "UPDATE projects SET icon_data=$2, icon_mime=$3 WHERE id=$1",
        [project.id, icon.bytes, icon.mime]
      );
  };
  app.get("/api/v1/projects", () => store.list());
  app.get<{ Params: { id: string } }>(
    "/api/v1/projects/:id",
    async (request, reply) => {
      return (
        (await store.get(request.params.id)) ??
        reply.code(404).send({ error: "Project not found." })
      );
    }
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/projects/:id/repository",
    async (request, reply) => {
      return (
        (await store.getRepository(request.params.id)) ??
        reply.code(404).send({ error: "Project not found." })
      );
    }
  );
  app.get<{ Querystring: { repoRoot?: string; projectId?: string } }>(
    "/api/v1/projects/icon-preview",
    async (request, reply) => {
      const saved = request.query.projectId
        ? await store.get(request.query.projectId)
        : null;
      if (!saved && !request.query.repoRoot?.trim())
        return { dataUrl: null, path: null, source: null };
      // Preview the same canonical checkout that Create will persist. Invalid
      // in-progress input simply has no preview; saved offline icons still work.
      const root =
        saved?.repoRoot ??
        (await resolveProjectRoot(request.query.repoRoot!).catch(() => null));
      const icon = root
        ? await readProjectIcon(pool, agents, { repoRoot: root })
        : null;
      if (icon)
        return {
          dataUrl: `data:${icon.mime};base64,${icon.bytes.toString("base64")}`,
          path: icon.path,
          source: "repository",
        };
      if (saved) {
        const cached = (
          await pool.query(
            "SELECT icon_data, icon_mime FROM projects WHERE id=$1",
            [saved.id]
          )
        ).rows[0];
        if (cached?.icon_data && cached.icon_mime)
          return {
            dataUrl: `data:${cached.icon_mime};base64,${cached.icon_data.toString("base64")}`,
            path: null,
            source: "saved",
          };
      }
      return { dataUrl: null, path: null, source: null };
    }
  );
  app.post("/api/v1/projects", async (request, reply) => {
    const byRepository =
      request.body != null &&
      typeof request.body === "object" &&
      "repository" in request.body;
    const input = parseInput(
      byRepository
        ? appearance.extend({
            repoRoot: z.undefined(),
            repository: z.string().trim().min(1),
          })
        : appearance.extend({
            repoRoot: z.string().min(1),
            repository: z.undefined(),
          }),
      request.body,
      reply
    );
    if (!input) return;
    try {
      const repoRoot = input.repoRoot
        ? await resolveProjectRoot(input.repoRoot)
        : null;
      const repository =
        input.repository !== undefined
          ? projectRepositoryUrl(input.repository)
          : repoRoot &&
            (await inferProjectRepository(
              repoRoot,
              agents?.checkoutReadRunners() ?? {}
            ));
      const result = await store.create({ ...input, repoRoot, repository });
      await snapshotRepositoryIcon(result);
      publishUiEvent({ type: "project.changed" });
      return result;
    } catch (error) {
      const { code, constraint } = error as {
        code?: string;
        constraint?: string;
      };
      return reply.code(code === "23505" ? 409 : 400).send({
        error:
          code === "23505"
            ? constraint === "projects_repository_key"
              ? "This repository already has a project."
              : "This folder already has a project."
            : input.repository !== undefined
              ? "Choose a valid HTTPS repository URL."
              : "Choose an existing folder.",
      });
    }
  });
  app.patch<{ Params: { id: string } }>(
    "/api/v1/projects/:id",
    async (request, reply) => {
      const input = parseInput(appearance, request.body, reply);
      if (!input) return;
      const result = await store.update(request.params.id, input);
      if (result) {
        await snapshotRepositoryIcon(result);
        publishUiEvent({ type: "project.changed" });
      }
      return result ?? reply.code(404).send({ error: "Project not found." });
    }
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/projects/:id",
    async (request, reply) => {
      const taskIds = await taskService.taskIdsForProject(request.params.id);
      if (!(await store.delete(request.params.id)))
        return reply.code(404).send({ error: "Project not found." });
      await taskService.cleanupProjectAttachments(taskIds);
      publishUiEvent({ type: "project.changed" });
      return { ok: true };
    }
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/projects/:id/icon",
    async (request, reply) => {
      const project = await store.get(request.params.id);
      if (!project) return reply.code(404).send();
      reply.header(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'"
      );
      reply.header("X-Content-Type-Options", "nosniff");
      if (project.iconOverride?.startsWith("data:")) {
        const avatar = parseUserAvatar({
          kind: "image",
          dataUrl: project.iconOverride,
        });
        if (avatar?.kind === "image") {
          const [prefix, encoded] = avatar.dataUrl.split(",");
          return reply
            .header("Cache-Control", "private, max-age=86400")
            .type(prefix!.slice(5).split(";")[0]!)
            .send(Buffer.from(encoded!, "base64"));
        }
      }
      // Keep a durable copy: repo files can disappear during branch switches or
      // when a checkout is unavailable. Project identity should not disappear.
      const cached = (
        await pool.query<{
          icon_data: Buffer | null;
          icon_mime: string | null;
        }>("SELECT icon_data, icon_mime FROM projects WHERE id=$1", [
          project.id,
        ])
      ).rows[0];
      if (cached?.icon_data && cached.icon_mime) {
        return reply
          .header("Cache-Control", "private, max-age=86400")
          .type(cached.icon_mime)
          .send(cached.icon_data);
      }
      const icon = await readProjectIcon(pool, agents, project);
      if (!icon) return reply.code(404).send();
      await pool.query(
        "UPDATE projects SET icon_data=$2, icon_mime=$3 WHERE id=$1",
        [project.id, icon.bytes, icon.mime]
      );
      return reply
        .header("Cache-Control", "private, max-age=86400")
        .type(icon.mime)
        .send(icon.bytes);
    }
  );
}
