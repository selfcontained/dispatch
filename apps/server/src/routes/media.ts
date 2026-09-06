import path from "node:path";
import { mkdir, open, stat, writeFile } from "node:fs/promises";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import { mediaMetadataFromBuffer } from "../media/metadata.js";
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
import type { PublishUiEvent } from "../server/ui-events.js";

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

type RangeResult =
  | { kind: "full" }
  | { kind: "unsatisfiable" }
  | { kind: "satisfiable"; start: number; end: number };

// Single-range `Range: bytes=start-end` support — the case video seeking
// and PDF viewers actually issue. Per RFC 9110 §14.2, a Range the server
// doesn't understand — wrong unit, multi-range (comma-separated), or
// unparseable numbers — must be *ignored*, not rejected: the caller falls
// through to a normal 200 with the whole file. Only a syntactically valid
// `bytes=` range that falls outside the file is "unsatisfiable" (416).
function parseRange(rangeHeader: string, fileSize: number): RangeResult {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { kind: "full" };
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return { kind: "full" };

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range ("last N bytes").
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { kind: "full" };
    }
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? fileSize - 1 : Number(endStr);
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start
  ) {
    return { kind: "full" };
  }
  if (start >= fileSize) {
    return { kind: "unsatisfiable" };
  }

  return { kind: "satisfiable", start, end: Math.min(end, fileSize - 1) };
}

type MediaRouteDeps = {
  pool: Pool;
  mediaRoot: string;
  agentManager: AgentManager;
  appLog: FastifyBaseLogger;
  publishUiEvent: PublishUiEvent;
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
    // Lets browsers show a video seek bar / issue Range requests at all.
    reply.header("Accept-Ranges", "bytes");

    // Open explicitly rather than createReadStream(filePath) so a file
    // deleted between the stat above and here surfaces as a normal 404
    // instead of a stream error after headers may already be on the wire.
    let handle;
    try {
      handle = await open(filePath, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send({ error: "Media file not found." });
      }
      throw err;
    }

    // Everything from here until createReadStream succeeds can throw or
    // return early (bad stat, empty file, unsatisfiable range) — `handle`
    // needs closing on every one of those paths. Once the stream exists,
    // its `autoClose` plus Fastify's own stream teardown own the fd, so the
    // finally below backs off as soon as `streamStarted` flips.
    let streamStarted = false;
    try {
      // Re-stat the open handle rather than trusting the `stat` above —
      // closes the window where the file is replaced, or turned into a
      // directory, between that call and here (open() on a directory
      // succeeds on macOS/Linux; the read would fail EISDIR mid-response),
      // and it means Content-Length/Content-Range describe the same bytes
      // the fd will actually read.
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return reply.code(404).send({ error: "Media file not found." });
      }
      const { size } = stats;

      if (size === 0) {
        // createReadStream({ end: -1 }) throws for an empty file, and
        // there's nothing to stream either way.
        reply.header("Content-Length", 0);
        return reply.code(200).type(contentType).send("");
      }

      let start = 0;
      let end = size - 1;
      let status: 200 | 206 = 200;
      const rangeHeader = request.headers.range;
      if (typeof rangeHeader === "string" && rangeHeader.length > 0) {
        const range = parseRange(rangeHeader, size);
        if (range.kind === "unsatisfiable") {
          reply.header("Content-Range", `bytes */${size}`);
          return reply.code(416).send();
        }
        if (range.kind === "satisfiable") {
          ({ start, end } = range);
          status = 206;
        }
        // "full" (unrecognized unit, multi-range, or unparseable numbers)
        // falls through to the whole-file response below.
      }

      const stream = handle.createReadStream({ start, end, autoClose: true });
      streamStarted = true;
      // A client that aborts mid-stream (closed tab, re-seek before the
      // previous range finished) would otherwise leave the fd open.
      reply.raw.on("close", () => {
        if (!stream.destroyed) stream.destroy();
      });
      stream.on("error", (err) => {
        deps.appLog.error({ err, filePath }, "Media stream read error");
      });

      reply.code(status);
      if (status === 206) {
        reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
      }
      reply.header("Content-Length", end - start + 1);
      return reply.type(contentType).send(stream);
    } finally {
      if (!streamStarted) {
        await handle.close().catch(() => {});
      }
    }
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
      `INSERT INTO media (agent_id, file_name, source, size_bytes, description,
                          metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [
        id,
        timestampedFileName,
        source,
        buffer.length,
        description,
        mediaMetadataFromBuffer(buffer),
      ]
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
