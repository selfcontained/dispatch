import { sendStoredFile } from "../files/send-file.js";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

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
    return sendStoredFile(
      request,
      reply,
      filePath,
      agentRow.rows[0].mime_type ?? undefined
    );
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
