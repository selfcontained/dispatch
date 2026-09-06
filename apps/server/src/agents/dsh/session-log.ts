import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { constants, zstdDecompressSync } from "node:zlib";

/**
 * dsh keeps every session, subagents included, as an append-only JSONL log
 * under `<DSH_HOME>/sessions/<project>/<sessionId>/session.jsonl.zstd`:
 * one Zstandard frame per durable batch, concatenated. Node's one-shot
 * decoder stops after the first frame (Bun's does not), so the reader
 * cuts the file at frame magics itself and decodes frame by frame.
 */

export type SessionLogEvent = {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

export type SessionHeader = {
  id: string;
  createdAt?: number;
  cwd?: string;
  parentSession?: string;
  origin?: string;
  delegationDepth?: number;
};

export type SessionLog = {
  header: SessionHeader | null;
  events: SessionLogEvent[];
  /** The file's byte size when read; a cheap change detector. */
  size: number;
  mtimeMs: number;
};

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function magicOffsets(buffer: Buffer): number[] {
  const offsets: number[] = [];
  let at = buffer.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) {
    offsets.push(at);
    at = buffer.indexOf(ZSTD_MAGIC, at + 1);
  }
  return offsets;
}

/**
 * Decode a concatenated-frame Zstandard buffer. A magic sequence can in
 * principle occur inside compressed data; a slice that fails to decode is
 * extended to the next candidate, and dsh's per-frame checksums make a
 * false cut fail rather than decode to garbage. A torn final frame (the
 * session is still being written) yields what it can.
 */
export function decodeZstdFrames(buffer: Buffer): string {
  const offsets = magicOffsets(buffer);
  if (offsets.length === 0) return buffer.toString("utf8");
  const parts: Buffer[] = [];
  let start = offsets[0];
  let next = 1;
  while (start < buffer.length) {
    const end = next < offsets.length ? offsets[next] : buffer.length;
    const slice = buffer.subarray(start, end);
    try {
      parts.push(zstdDecompressSync(slice));
      start = end;
      next += 1;
      continue;
    } catch {
      if (next < offsets.length) {
        // Probably a false cut: take the next candidate as the frame end.
        next += 1;
        continue;
      }
      // The tail is an incomplete frame; keep whatever it already holds.
      try {
        parts.push(
          zstdDecompressSync(slice, { finishFlush: constants.ZSTD_e_flush })
        );
      } catch {
        // Nothing decodable in the tail.
      }
      break;
    }
  }
  return Buffer.concat(parts).toString("utf8");
}

export function parseSessionLog(text: string): {
  header: SessionHeader | null;
  events: SessionLogEvent[];
} {
  const lines = text.split("\n");
  // A torn tail leaves a partial last line; it never parses and is dropped.
  let header: SessionHeader | null = null;
  const events: SessionLogEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as SessionLogEvent;
    if (record.type === "session" && typeof record.id === "string") {
      header = {
        id: record.id,
        ...(typeof record.createdAt === "number"
          ? { createdAt: record.createdAt }
          : {}),
        ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
        ...(typeof record.parentSession === "string"
          ? { parentSession: record.parentSession }
          : {}),
        ...(typeof record.origin === "string" ? { origin: record.origin } : {}),
        ...(typeof record.delegationDepth === "number"
          ? { delegationDepth: record.delegationDepth }
          : {}),
      };
      continue;
    }
    if (typeof record.type === "string") events.push(record);
  }
  return { header, events };
}

export function sessionsRoot(dshHome: string): string {
  return path.join(dshHome, "sessions");
}

const LOG_NAMES = ["session.jsonl.zstd", "session.jsonl"];

/**
 * The log file for a session id, wherever its project directory is. dsh
 * derives the project directory from the cwd with a lossy encoding, so the
 * session id (a UUID, unique across projects) is the reliable key.
 */
export async function findSessionLog(
  dshHome: string,
  sessionId: string
): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  let projects: string[];
  try {
    projects = await readdir(sessionsRoot(dshHome));
  } catch {
    return null;
  }
  for (const project of projects) {
    for (const name of LOG_NAMES) {
      const candidate = path.join(
        sessionsRoot(dshHome),
        project,
        sessionId,
        name
      );
      try {
        await stat(candidate);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Every session log under the home, for whole-home scans (usage totals). */
export async function listSessionLogs(dshHome: string): Promise<string[]> {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = await readdir(sessionsRoot(dshHome));
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = path.join(sessionsRoot(dshHome), project);
    let sessions: string[];
    try {
      sessions = await readdir(dir);
    } catch {
      continue;
    }
    for (const session of sessions) {
      for (const name of LOG_NAMES) {
        const candidate = path.join(dir, session, name);
        try {
          await stat(candidate);
          out.push(candidate);
          break;
        } catch {
          // not this encoding
        }
      }
    }
  }
  return out;
}

export async function readSessionLog(file: string): Promise<SessionLog> {
  const [buffer, info] = await Promise.all([readFile(file), stat(file)]);
  const text = file.endsWith(".zstd")
    ? decodeZstdFrames(buffer)
    : buffer.toString("utf8");
  return {
    ...parseSessionLog(text),
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}
