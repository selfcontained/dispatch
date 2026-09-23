import path from "node:path";
import { mkdir, open, stat, writeFile } from "node:fs/promises";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import { detectFileType } from "../files/file-type.js";
import { fileMetadataFromBuffer } from "../files/metadata.js";
import {
  getFileById,
  listFileRows,
  loadSeenFileKeys,
  markSeenFileKeys,
} from "../files/store.js";
import {
  isValidFileKey,
  resolveFilesDir,
  sanitizeUploadedFileName,
  toFileKey,
} from "../shared/files.js";
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

function fileContentUrl(agentId: string, fileName: string): string {
  return `/api/v1/agents/${agentId}/files/${encodeURIComponent(fileName)}`;
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

type FileRouteDeps = {
  pool: Pool;
  filesRoot: string;
  agentManager: AgentManager;
  appLog: FastifyBaseLogger;
  publishUiEvent: PublishUiEvent;
};

export async function registerFileRoutes(
  app: FastifyInstance,
  deps: FileRouteDeps
): Promise<void> {
  app.get("/api/v1/agents/:id/files", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agentExists = await deps.pool.query(
      "SELECT 1 FROM agents WHERE id = $1",
      [id]
    );
    if (agentExists.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const files = await listFileRows(deps.pool, id);
    const seenKeys = await loadSeenFileKeys(
      deps.pool,
      id,
      files.map((file) =>
        toFileKey({ name: file.fileName, updatedAt: file.updatedAt })
      )
    );
    return {
      files: files.map((file) => ({
        id: file.id,
        name: file.fileName,
        source: file.source,
        size: file.sizeBytes,
        updatedAt: file.updatedAt,
        url: fileContentUrl(id, file.fileName),
        description: file.description,
        mimeType: file.mimeType,
        media: file.media,
        seen: seenKeys.has(
          toFileKey({ name: file.fileName, updatedAt: file.updatedAt })
        ),
      })),
    };
  });

  // Stable, owner-independent lookup for consumers such as the lightbox.
  // Callers need only the file row ID; the server resolves the owning agent
  // and canonical content URL.
  app.get("/api/v1/files/:fileId", async (request, reply) => {
    const params = request.params as { fileId?: string };
    const fileId = Number(params.fileId);
    if (!Number.isInteger(fileId) || fileId <= 0) {
      return reply.code(400).send({ error: "Invalid file ID." });
    }

    const row = await getFileById(deps.pool, fileId);
    if (!row) {
      return reply.code(404).send({ error: "File not found." });
    }

    return {
      file: {
        id: row.id,
        ownerAgentId: row.agentId,
        name: row.fileName,
        source: row.source,
        size: row.sizeBytes,
        updatedAt: row.updatedAt,
        url: fileContentUrl(row.agentId, row.fileName),
        description: row.description,
        mimeType: row.mimeType,
        media: row.media,
      },
    };
  });

  app.get("/api/v1/agents/:id/files/:file", async (request, reply) => {
    const params = request.params as { id?: string; file?: string };
    const id = params.id ?? "";
    const file = params.file ?? "";
    if (!/^[A-Za-z0-9._-]+$/.test(file)) {
      return reply.code(400).send({ error: "Invalid file name." });
    }
    const agentRow = await deps.pool.query<{
      id: string;
      files_dir: string | null;
      mime_type: string | null;
    }>(
      `SELECT a.id, a.files_dir, f.mime_type
         FROM agents a
         LEFT JOIN files f ON f.agent_id = a.id AND f.file_name = $2
        WHERE a.id = $1`,
      [id, file]
    );
    if (agentRow.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const filePath = path.join(
      resolveFilesDir(id, agentRow.rows[0].files_dir, deps.filesRoot),
      file
    );
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return reply.code(404).send({ error: "File not found." });
    }

    // The type stored with the file, read from its bytes. Bytes with no row
    // are served as opaque data, which the sandbox below also covers.
    const contentType =
      agentRow.rows[0].mime_type ?? "application/octet-stream";
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
        return reply.code(404).send({ error: "File not found." });
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
        return reply.code(404).send({ error: "File not found." });
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
        deps.appLog.error({ err, filePath }, "File stream read error");
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

  app.post("/api/v1/agents/:id/files", async (request, reply) => {
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
    const buffer = await data.toBuffer();
    const type = detectFileType(buffer, fileName);
    if (!type.ok) {
      return reply.code(400).send({ error: type.error });
    }

    const isText = type.media === "text";
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

    const filesDir = resolveFilesDir(agent.id, agent.filesDir, deps.filesRoot);
    await mkdir(filesDir, { recursive: true });

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "-")
      .replace("Z", "");
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    const timestampedFileName = `${base}-${timestamp}${ext}`;

    await writeFile(path.join(filesDir, timestampedFileName), buffer);

    const result = await deps.pool.query<{ id: number; created_at: Date }>(
      `INSERT INTO files (agent_id, file_name, source, size_bytes, description,
                          metadata, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        id,
        timestampedFileName,
        source,
        buffer.length,
        description,
        fileMetadataFromBuffer(buffer),
        type.mimeType,
      ]
    );

    deps.publishUiEvent({ type: "files.changed", agentId: id });

    // Uploads no longer type into a pane; the agent reads shared files
    // through its tools, and Chat attachments carry the reference.
    const delivery: "none" = "none";

    return reply.code(201).send({
      ok: true,
      file: {
        id: result.rows[0].id,
        fileName: timestampedFileName,
        source,
        sizeBytes: buffer.length,
        mimeType: type.mimeType,
        media: type.media,
        createdAt: result.rows[0].created_at.toISOString(),
        url: `/api/v1/agents/${id}/files/${encodeURIComponent(timestampedFileName)}`,
        path: path.join(filesDir, timestampedFileName),
        delivery,
      },
    });
  });

  app.post("/api/v1/agents/:id/files/seen", async (request, reply) => {
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
        body.keys.map((key) => key.trim()).filter((key) => isValidFileKey(key))
      )
    );
    if (keys.length === 0) {
      return { ok: true, updated: 0 };
    }

    await markSeenFileKeys(deps.pool, id, keys);
    deps.publishUiEvent({ type: "files.seen", agentId: id, keys });
    return { ok: true, updated: keys.length };
  });
}
