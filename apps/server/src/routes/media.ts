import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import {
  getMediaById,
  listMediaFiles,
  loadSeenMediaKeys,
  markSeenMediaKeys,
} from "../media/store.js";
import {
  isMediaFile,
  isTextFile,
  isValidMediaKey,
  mimeType,
  resolveMediaDir,
  sanitizeUploadedFileName,
  toMediaKey,
} from "../shared/media.js";
import type { InjectionCoordinator } from "../terminal/injection-coordinator.js";
import { TmuxTerminal } from "../terminal/tmux-terminal.js";
import { hostClipboardImageCapable } from "../shared/lib/clipboard-capability.js";
import { writeImageToClipboard } from "../shared/lib/clipboard-write.js";
import { runCommand } from "../shared/lib/run-command.js";

// Per-agent [File #N] sequence counter for terminal injection. In-memory,
// resets on server restart — N is a cosmetic prompt label, not a stable ID.
const fileSeqByAgent = new Map<string, number>();

function nextFileSeq(agentId: string): number {
  const seq = (fileSeqByAgent.get(agentId) ?? 0) + 1;
  fileSeqByAgent.set(agentId, seq);
  return seq;
}

function mediaContentUrl(agentId: string, fileName: string): string {
  return `/api/v1/agents/${agentId}/media/${encodeURIComponent(fileName)}`;
}

type MediaRouteDeps = {
  pool: Pool;
  mediaRoot: string;
  agentManager: AgentManager;
  appLog: FastifyBaseLogger;
  publishUiEvent: (event: unknown) => void;
  injectionCoordinator: InjectionCoordinator;
};

export async function registerMediaRoutes(
  app: FastifyInstance,
  deps: MediaRouteDeps
): Promise<void> {
  app.get("/api/v1/agents/:id/media", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agentExists = await deps.pool.query(
      "SELECT 1 FROM agents WHERE id = $1",
      [id]
    );
    if (agentExists.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const files = await listMediaFiles(deps.pool, id);
    const seenKeys = await loadSeenMediaKeys(
      deps.pool,
      id,
      files.map((file) =>
        toMediaKey({ name: file.fileName, updatedAt: file.updatedAt })
      )
    );
    return {
      files: files.map((file) => ({
        id: file.id,
        name: file.fileName,
        source: file.source,
        size: file.sizeBytes,
        updatedAt: file.updatedAt,
        url: mediaContentUrl(id, file.fileName),
        description: file.description,
        seen: seenKeys.has(
          toMediaKey({ name: file.fileName, updatedAt: file.updatedAt })
        ),
      })),
    };
  });

  // Stable, owner-independent lookup for consumers such as the lightbox.
  // Callers need only the media row ID; the server resolves the owning agent
  // and canonical content URL.
  app.get("/api/v1/media/:mediaId", async (request, reply) => {
    const params = request.params as { mediaId?: string };
    const mediaId = Number(params.mediaId);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
      return reply.code(400).send({ error: "Invalid media ID." });
    }

    const media = await getMediaById(deps.pool, mediaId);
    if (!media) {
      return reply.code(404).send({ error: "Media item not found." });
    }

    return {
      media: {
        id: media.id,
        ownerAgentId: media.agentId,
        name: media.fileName,
        source: media.source,
        size: media.sizeBytes,
        updatedAt: media.updatedAt,
        url: mediaContentUrl(media.agentId, media.fileName),
        description: media.description,
      },
    };
  });

  app.get("/api/v1/agents/:id/media/:file", async (request, reply) => {
    const params = request.params as { id?: string; file?: string };
    const id = params.id ?? "";
    const agentRow = await deps.pool.query<{
      id: string;
      media_dir: string | null;
    }>("SELECT id, media_dir FROM agents WHERE id = $1", [id]);
    if (agentRow.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const file = params.file ?? "";
    if (!/^[A-Za-z0-9._-]+$/.test(file)) {
      return reply.code(400).send({ error: "Invalid media file name." });
    }

    const filePath = path.join(
      resolveMediaDir(id, agentRow.rows[0].media_dir, deps.mediaRoot),
      file
    );
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return reply.code(404).send({ error: "Media file not found." });
    }

    const contentType = mimeType(file);
    reply.header("X-Content-Type-Options", "nosniff");
    // Agent-authored files render in the browser (lightbox iframe or new
    // tab) but must never run same-origin against the Dispatch API. Only
    // passive types are exempt; anything a browser might render as a
    // document (html, xml/xhtml, …) gets an opaque origin.
    const isPassive =
      contentType.startsWith("image/") ||
      contentType === "video/mp4" ||
      contentType === "application/pdf";
    if (!isPassive) {
      reply.header(
        "Content-Security-Policy",
        "sandbox allow-scripts allow-popups"
      );
    }
    return reply.type(contentType).send(await readFile(filePath));
  });

  app.post("/api/v1/agents/:id/media", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: "A file field is required." });
    }

    const fileName = sanitizeUploadedFileName(path.basename(data.filename));
    if (!fileName) {
      return reply.code(400).send({ error: "Invalid file name." });
    }
    if (!isMediaFile(fileName)) {
      return reply.code(400).send({
        error:
          "Unsupported file type. Use images (png/jpg/gif/webp), video (mp4), documents (pdf), or text files (txt/md/json/yaml/ts/py/etc).",
      });
    }

    const isText = isTextFile(fileName);
    const sourceField =
      (data.fields.source as { value?: string } | undefined)?.value ??
      (isText ? "text" : "screenshot");
    const validSources = ["screenshot", "stream", "simulator", "text", "user"];
    const source = validSources.includes(sourceField)
      ? sourceField
      : isText
        ? "text"
        : "screenshot";
    const description =
      (data.fields.description as { value?: string } | undefined)?.value ??
      null;

    const mediaDir = resolveMediaDir(agent.id, agent.mediaDir, deps.mediaRoot);
    await mkdir(mediaDir, { recursive: true });

    const buffer = await data.toBuffer();
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "-")
      .replace("Z", "");
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    const timestampedFileName = `${base}-${timestamp}${ext}`;

    await writeFile(path.join(mediaDir, timestampedFileName), buffer);

    const result = await deps.pool.query<{ id: number; created_at: Date }>(
      `INSERT INTO media (agent_id, file_name, source, size_bytes, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [id, timestampedFileName, source, buffer.length, description]
    );

    deps.publishUiEvent({ type: "media.changed", agentId: id });

    const injectField = (data.fields.inject as { value?: string } | undefined)
      ?.value;
    const shouldInject = injectField === "true";
    let delivery: "none" | "clipboard" | "path" = "none";

    if (shouldInject) {
      const mediaPath = path.join(mediaDir, timestampedFileName);
      const isImage = /\.(png|jpe?g|gif|webp)$/i.test(timestampedFileName);
      let clipboardOk = false;

      // For images, try the native clipboard path first
      if (isImage && hostClipboardImageCapable()) {
        try {
          const access = await deps.agentManager.getTerminalAccess(id);
          if (access.mode === "tmux") {
            // User-initiated: serialize against active pane writes but skip
            // the quiet gate — the upload is the user acting. The clipboard
            // write happens inside the queued task so the host clipboard and
            // the C-v paste stay adjacent (no window for another writer to
            // replace the clipboard between them).
            await deps.injectionCoordinator.inject(
              id,
              async () => {
                await writeImageToClipboard(buffer, data.mimetype);
                await runCommand("tmux", [
                  "send-keys",
                  "-t",
                  access.sessionName,
                  "C-v",
                ]);
              },
              { gate: false }
            );
            clipboardOk = true;
            delivery = "clipboard";
          }
        } catch (err) {
          deps.appLog.warn(
            { err, agentId: id },
            "Clipboard paste failed; falling back to path injection"
          );
        }
      }

      // Path-based injection: type [File #N] <path> into tmux
      if (!clipboardOk) {
        try {
          const access = await deps.agentManager.getTerminalAccess(id);
          if (access.mode === "tmux") {
            const seq = nextFileSeq(id);
            const terminal = new TmuxTerminal(access.sessionName);
            await deps.injectionCoordinator.inject(
              id,
              () => terminal.pasteText(`[File #${seq}] ${mediaPath} `),
              { gate: false }
            );
            delivery = "path";
          }
        } catch (err) {
          deps.appLog.warn(
            { err, agentId: id },
            "Terminal path injection failed"
          );
        }
      }
    }

    return reply.code(201).send({
      ok: true,
      media: {
        id: result.rows[0].id,
        fileName: timestampedFileName,
        source,
        sizeBytes: buffer.length,
        createdAt: result.rows[0].created_at.toISOString(),
        url: `/api/v1/agents/${id}/media/${encodeURIComponent(timestampedFileName)}`,
        path: path.join(mediaDir, timestampedFileName),
        delivery,
      },
    });
  });

  app.post("/api/v1/agents/:id/media/seen", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const body = request.body as { keys?: unknown } | undefined;
    if (
      !Array.isArray(body?.keys) ||
      !body.keys.every((key) => typeof key === "string")
    ) {
      return reply
        .code(400)
        .send({ error: "keys must be an array of strings." });
    }

    const keys = Array.from(
      new Set(
        body.keys.map((key) => key.trim()).filter((key) => isValidMediaKey(key))
      )
    );
    if (keys.length === 0) {
      return { ok: true, updated: 0 };
    }

    await markSeenMediaKeys(deps.pool, id, keys);
    deps.publishUiEvent({ type: "media.seen", agentId: id, keys });
    return { ok: true, updated: keys.length };
  });
}
