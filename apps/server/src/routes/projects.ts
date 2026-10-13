import type { PublishUiEvent } from "../server/ui-events.js";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import * as z from "zod/v4";
import { ProjectStore } from "../projects/store.js";
import { parseInput } from "../shared/lib/parse-input.js";
import { resolveTilde } from "../shared/lib/resolve-tilde.js";
import { getDirectoryIconPath } from "../shared/directory-icon-cache.js";
const appearance = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  iconOverride: z.string().trim().max(8).nullable().default(null),
});
export async function registerProjectRoutes(
  app: FastifyInstance,
  { pool, publishUiEvent }: { pool: Pool; publishUiEvent: PublishUiEvent }
) {
  const store = new ProjectStore(pool);
  app.get("/api/v1/projects", () => store.list());
  app.post("/api/v1/projects", async (request, reply) => {
    const input = parseInput(
      appearance.extend({ repoRoot: z.string().min(1) }),
      request.body,
      reply
    );
    if (!input) return;
    try {
      const cwd = await realpath(resolveTilde(input.repoRoot));
      const git = async (...args: string[]) =>
        (await promisify(execFile)("git", ["-C", cwd, ...args])).stdout.trim();
      const common = await git(
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir"
      );
      const gitDir = await git("rev-parse", "--absolute-git-dir");
      // Normal discovery handles nested paths and separate Git metadata.
      // A linked worktree instead uses the primary checkout from Git's registry.
      const root =
        common === gitDir
          ? await git("rev-parse", "--show-toplevel")
          : (await git("worktree", "list", "--porcelain", "-z"))
              .split("\0")[0]!
              .slice("worktree ".length);
      const repoRoot = await realpath(root);
      const result = await store.create({ ...input, repoRoot });
      publishUiEvent({ type: "project.changed" });
      return result;
    } catch (error) {
      const code = (error as { code?: string }).code;
      return reply.code(code === "23505" ? 409 : 400).send({
        error:
          code === "23505"
            ? "This repository already has a project."
            : "Choose an existing Git repository.",
      });
    }
  });
  app.patch<{ Params: { id: string } }>(
    "/api/v1/projects/:id",
    async (request, reply) => {
      const input = parseInput(appearance, request.body, reply);
      if (!input) return;
      const result = await store.update(request.params.id, input);
      if (result) publishUiEvent({ type: "project.changed" });
      return result ?? reply.code(404).send({ error: "Project not found." });
    }
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/projects/:id",
    async (request, reply) => {
      if (!(await store.delete(request.params.id)))
        return reply.code(404).send({ error: "Project not found." });
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
      const icon = await getDirectoryIconPath(pool, project.repoRoot);
      if (!icon) return reply.code(404).send();
      try {
        const root = await realpath(project.repoRoot);
        const iconPath = await realpath(path.join(root, icon));
        if (!iconPath.startsWith(root + path.sep))
          return reply.code(404).send();
        const mime =
          path.extname(icon).toLowerCase() === ".svg"
            ? "image/svg+xml"
            : path.extname(icon).toLowerCase() === ".png"
              ? "image/png"
              : "image/x-icon";
        const bytes = await readFile(iconPath);
        if (!bytes.length || bytes.length > 2 * 1024 * 1024)
          return reply.code(404).send();
        await pool.query(
          "UPDATE projects SET icon_data=$2, icon_mime=$3 WHERE id=$1",
          [project.id, bytes, mime]
        );
        return reply
          .header("Cache-Control", "private, max-age=86400")
          .type(mime)
          .send(bytes);
      } catch {
        return reply.code(404).send();
      }
    }
  );
}
