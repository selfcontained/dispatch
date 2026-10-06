import { openWorkspaceDirectory } from "../../files/workspace-directory.js";
import { ignoredWorkspacePaths } from "../../files/workspace-ignore.js";
import { createWorkspaceFileIndexer } from "../../files/workspace-file-index.js";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { imageDimensionsFromBuffer } from "../../files/image-dimensions.js";
import { detectFileType } from "../../files/file-type.js";
import { agentWorkspaceDir } from "../../agents/workspace-target.js";
import type { AgentRouteDeps } from "./shared.js";

const MAX_ENTRIES = 500;
const MAX_BYTES = 1_048_576;
class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

// Do not follow links, including directory links. Recheck after opening a file
// as well, so an ordinary concurrent rename cannot return unrelated contents.
async function resolveEntry(root: string, relative: string): Promise<string> {
  if (
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.includes("\0")
  ) {
    throw new WorkspaceError("Invalid workspace path.");
  }
  const parts = relative ? relative.split("/") : [];
  if (
    parts.some(
      (part) =>
        !part || part === "." || part === ".." || part.toLowerCase() === ".git"
    )
  ) {
    throw new WorkspaceError("Invalid workspace path.");
  }
  let target = root;
  for (const part of parts) {
    target = path.join(target, part);
    if ((await lstat(target)).isSymbolicLink()) {
      throw new WorkspaceError(
        "Symbolic links are not followed in Files.",
        403
      );
    }
  }
  const resolved = await realpath(target);
  const inside = path.relative(root, resolved);
  if (
    inside.startsWith(".." + path.sep) ||
    inside === ".." ||
    path.isAbsolute(inside)
  ) {
    throw new WorkspaceError("Path is outside the workspace.", 403);
  }
  return resolved;
}

export async function registerAgentWorkspaceRoutes(
  app: FastifyInstance,
  deps: Pick<AgentRouteDeps, "agentManager">
): Promise<void> {
  const fileIndex = createWorkspaceFileIndexer();
  app.get("/api/v1/agents/:id/workspace", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as {
      path?: unknown;
      workspace?: unknown;
      file?: unknown;
      index?: unknown;
      generation?: unknown;
    };
    if (
      (query.path !== undefined && typeof query.path !== "string") ||
      typeof query.workspace !== "string"
    ) {
      return reply
        .code(400)
        .send({ error: "A workspace and relative path are required." });
    }
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) return reply.code(404).send({ error: "Agent not found." });
    const workspace = agentWorkspaceDir(agent);
    if (!workspace)
      return reply.code(404).send({ error: "This agent has no workspace." });
    if (query.workspace !== workspace)
      return reply
        .code(409)
        .send({ error: "Workspace changed. Reopen Files to continue." });
    reply.header("Cache-Control", "no-store");
    try {
      const root = await realpath(workspace);
      if (query.index === "true") {
        const generation =
          typeof query.generation === "string"
            ? query.generation.slice(0, 64)
            : "initial";
        return await fileIndex(root, generation);
      }
      const relative = (query.path as string | undefined) ?? "";
      const target = await resolveEntry(root, relative);
      if (query.file !== "true") {
        const { directory, verify } = await openWorkspaceDirectory(
          root,
          target
        );
        const entries: Array<{
          name: string;
          path: string;
          kind: "directory" | "file" | "link" | "other";
        }> = [];
        const visible: typeof entries = [];
        let truncated = false;
        let scanned = 0;
        const deadline = Date.now() + 2000;
        const flush = async () => {
          const ignored = await ignoredWorkspacePaths(
            target,
            entries.map((entry) => entry.name)
          );
          visible.push(...entries.filter((entry) => !ignored.has(entry.name)));
          entries.length = 0;
        };
        for await (const entry of directory) {
          if (entry.name.toLowerCase() === ".git") continue;
          if (++scanned > 20_000 || Date.now() > deadline) {
            truncated = true;
            break;
          }
          entries.push({
            name: entry.name,
            path: relative ? `${relative}/${entry.name}` : entry.name,
            kind: entry.isSymbolicLink()
              ? "link"
              : entry.isDirectory()
                ? "directory"
                : entry.isFile()
                  ? "file"
                  : "other",
          });
          if (entries.length === 500) {
            await flush();
            if (visible.length > MAX_ENTRIES) {
              truncated = true;
              break;
            }
          }
        }
        await verify();
        if (entries.length) await flush();
        await verify();
        if (visible.length > MAX_ENTRIES) truncated = true;
        visible.sort(
          (a, b) =>
            Number(b.kind === "directory") - Number(a.kind === "directory") ||
            a.name.localeCompare(b.name)
        );
        return { entries: visible.slice(0, MAX_ENTRIES), truncated };
      }
      const initial = await lstat(target);
      if (!initial.isFile())
        throw new WorkspaceError("Only regular files can be previewed.");
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile())
          throw new WorkspaceError("Only regular files can be previewed.");
        const checked = await resolveEntry(root, relative);
        const current = await lstat(checked);
        if (
          checked !== target ||
          stat.ino !== current.ino ||
          stat.dev !== current.dev
        ) {
          throw new WorkspaceError(
            "File changed while opening. Refresh to retry.",
            409
          );
        }
        if (stat.size > MAX_BYTES)
          return {
            kind: "unsupported",
            size: stat.size,
            message: "Preview limited to files up to 1 MiB.",
          };
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            length,
            buffer.length - length,
            null
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX_BYTES)
          return {
            kind: "unsupported",
            size: length,
            message: "File grew beyond the 1 MiB preview limit.",
          };
        const data = buffer.subarray(0, length);
        // Keep image preview dependency-free and bounded. Animated formats are
        // deliberately excluded from this first read-only explorer.
        const detected = detectFileType(data, relative);
        if (
          detected.ok &&
          detected.mimeType.startsWith("image/") &&
          detected.mimeType !== "image/svg+xml"
        ) {
          const dimensions = imageDimensionsFromBuffer(data);
          const staticImage =
            detected.mimeType === "image/jpeg" ||
            (detected.mimeType === "image/png" &&
              !data.includes(Buffer.from("acTL")));
          if (
            staticImage &&
            dimensions &&
            dimensions.width * dimensions.height <= 16_000_000
          ) {
            return {
              kind: "image",
              size: length,
              src: `data:${detected.mimeType};base64,${data.toString("base64")}`,
            };
          }
          return {
            kind: "unsupported",
            size: length,
            message:
              "MVP image previews support static PNG/JPEG with readable dimensions up to 16 megapixels.",
          };
        }
        try {
          if (data.includes(0)) throw new Error("binary");
          return {
            kind: "text",
            size: length,
            text: new TextDecoder("utf-8", { fatal: true }).decode(data),
          };
        } catch {
          return {
            kind: "unsupported",
            size: length,
            message: "Binary or non-UTF-8 file. Preview unavailable.",
          };
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof WorkspaceError)
        return reply.code(error.status).send({ error: error.message });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESTALE")
        return reply
          .code(409)
          .send({ error: "Directory changed. Refresh to retry." });
      if (code === "ENOENT" || code === "ENOTDIR")
        return reply
          .code(404)
          .send({ error: "File or workspace no longer exists." });
      if (code === "EACCES" || code === "EPERM" || code === "ELOOP")
        return reply.code(403).send({ error: "This path cannot be read." });
      request.log.warn({ err: error }, "Workspace read failed");
      return reply.code(500).send({ error: "Unable to read workspace." });
    }
  });
}
