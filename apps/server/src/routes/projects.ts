import type { PublishUiEvent } from "../server/ui-events.js";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import * as z from "zod/v4";
import { ProjectStore } from "../projects/store.js";
import { parseInput } from "../shared/lib/parse-input.js";
import { resolveTilde } from "../shared/lib/resolve-tilde.js";
import { detectRepoIcon } from "../shared/repo-icon.js";
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
async function resolveProjectRoot(input: string): Promise<string> {
  const cwd = await realpath(resolveTilde(input));
  if (!(await stat(cwd)).isDirectory()) throw new Error("Not a directory");
  const git = async (...args: string[]) =>
    (await promisify(execFile)("git", ["-C", cwd, ...args])).stdout.trim();
  // A plain folder (no Git) is its own project root.
  const common = await git(
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ).catch(() => null);
  if (common === null) return cwd;
  const gitDir = await git("rev-parse", "--absolute-git-dir");
  // Normal discovery handles nested paths and separate Git metadata.
  // A linked worktree instead uses the primary checkout from Git's registry.
  const root =
    common === gitDir
      ? await git("rev-parse", "--show-toplevel")
      : (await git("worktree", "list", "--porcelain", "-z"))
          .split("\0")[0]!
          .slice("worktree ".length);
  return realpath(root);
}

async function readRepositoryIcon(repoRoot: string) {
  try {
    const root = await realpath(resolveTilde(repoRoot));
    const icon = await detectRepoIcon(root);
    if (!icon) return null;
    const iconPath = await realpath(path.join(root, icon));
    if (!iconPath.startsWith(root + path.sep)) return null;
    const bytes = await readFile(iconPath);
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) return null;
    const mime =
      path.extname(icon).toLowerCase() === ".svg"
        ? "image/svg+xml"
        : path.extname(icon).toLowerCase() === ".png"
          ? "image/png"
          : "image/x-icon";
    return { bytes, mime, path: icon };
  } catch {
    return null;
  }
}

export async function registerProjectRoutes(
  app: FastifyInstance,
  { pool, publishUiEvent }: { pool: Pool; publishUiEvent: PublishUiEvent }
) {
  const store = new ProjectStore(pool);
  const snapshotRepositoryIcon = async (project: {
    id: string;
    repoRoot: string;
    iconOverride: string | null;
  }) => {
    if (project.iconOverride) return;
    const icon = await readRepositoryIcon(project.repoRoot);
    if (icon)
      await pool.query(
        "UPDATE projects SET icon_data=$2, icon_mime=$3 WHERE id=$1",
        [project.id, icon.bytes, icon.mime]
      );
  };
  app.get("/api/v1/projects", () => store.list());
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
      const icon = root ? await readRepositoryIcon(root) : null;
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
    const input = parseInput(
      appearance.extend({ repoRoot: z.string().min(1) }),
      request.body,
      reply
    );
    if (!input) return;
    try {
      const repoRoot = await resolveProjectRoot(input.repoRoot);
      const result = await store.create({ ...input, repoRoot });
      await snapshotRepositoryIcon(result);
      publishUiEvent({ type: "project.changed" });
      return result;
    } catch (error) {
      const code = (error as { code?: string }).code;
      return reply.code(code === "23505" ? 409 : 400).send({
        error:
          code === "23505"
            ? "This folder already has a project."
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
      const icon = await readRepositoryIcon(project.repoRoot);
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
