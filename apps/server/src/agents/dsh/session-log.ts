import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { constants, zstdDecompress, zstdDecompressSync } from "node:zlib";
import { promisify } from "node:util";

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
  /** True when the file was larger than the reader is willing to inflate. */
  partial: boolean;
};

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;
/** A single log larger than this is not inflated in-process. */
export const SESSION_LOG_MAX_BYTES = 64 * 1024 * 1024;

const zstdDecompressAsync = promisify(zstdDecompress);

/**
 * The byte length of the Zstandard frame at `offset`, read from its
 * headers (RFC 8878): magic, frame header descriptor, then block headers
 * until the last block, then the checksum when the frame carries one.
 * Null when the buffer ends before the frame does (a torn tail) or the
 * bytes there are not a frame at all.
 */
export function zstdFrameLength(buffer: Buffer, offset: number): number | null {
  if (offset + 4 > buffer.length) return null;
  const magic = buffer.readUInt32LE(offset);
  if ((magic & SKIPPABLE_MAGIC_MASK) === SKIPPABLE_MAGIC) {
    if (offset + 8 > buffer.length) return null;
    const size = buffer.readUInt32LE(offset + 4);
    const total = 8 + size;
    return offset + total <= buffer.length ? total : null;
  }
  if (magic !== ZSTD_MAGIC) return null;
  let at = offset + 4;
  if (at >= buffer.length) return null;
  const descriptor = buffer[at];
  at += 1;
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const checksum = (descriptor & 0x04) !== 0;
  const dictFlag = descriptor & 0x03;
  if (!singleSegment) at += 1; // window descriptor
  at += [0, 1, 2, 4][dictFlag];
  at += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  for (;;) {
    if (at + 3 > buffer.length) return null;
    const header = buffer[at] | (buffer[at + 1] << 8) | (buffer[at + 2] << 16);
    const last = (header & 1) === 1;
    const type = (header >> 1) & 0x03;
    const size = header >> 3;
    if (type === 3) return null; // reserved: not a frame we understand
    at += 3 + (type === 1 ? 1 : size);
    if (at > buffer.length) return null;
    if (last) break;
  }
  if (checksum) at += 4;
  return at <= buffer.length ? at - offset : null;
}

type Decoder = (slice: Buffer, tolerant: boolean) => Promise<Buffer>;

/**
 * Walk a concatenated-frame buffer by its frame headers, so a magic
 * sequence inside a frame's data cannot mislead the cut. A frame that
 * fails to decode (checksum, corrupt block) is skipped and the walk goes
 * on after it; the last frame may be torn (the session is still being
 * written) and yields what it can.
 */
async function walkFrames(buffer: Buffer, decode: Decoder): Promise<Buffer> {
  const parts: Buffer[] = [];
  let at = 0;
  while (at < buffer.length) {
    const length = zstdFrameLength(buffer, at);
    if (length === null) {
      // Torn tail (or trailing junk): keep what the decoder can recover.
      try {
        const tail = await decode(buffer.subarray(at), true);
        if (tail.length > 0) parts.push(tail);
      } catch {
        // nothing decodable
      }
      break;
    }
    const slice = buffer.subarray(at, at + length);
    at += length;
    if ((slice.readUInt32LE(0) & SKIPPABLE_MAGIC_MASK) === SKIPPABLE_MAGIC) {
      continue;
    }
    try {
      parts.push(await decode(slice, false));
    } catch {
      // A bad frame between good ones: drop it, keep going.
    }
  }
  return Buffer.concat(parts);
}

const decodeSync: Decoder = async (slice, tolerant) =>
  zstdDecompressSync(
    slice,
    tolerant ? { finishFlush: constants.ZSTD_e_flush } : {}
  );
const decodeAsync: Decoder = (slice, tolerant) =>
  zstdDecompressAsync(
    slice,
    tolerant ? { finishFlush: constants.ZSTD_e_flush } : {}
  );

/** Decode every frame synchronously (tests and small files). */
export function decodeZstdFrames(buffer: Buffer): string {
  const parts: Buffer[] = [];
  let at = 0;
  while (at < buffer.length) {
    const length = zstdFrameLength(buffer, at);
    if (length === null) {
      try {
        const tail = zstdDecompressSync(buffer.subarray(at), {
          finishFlush: constants.ZSTD_e_flush,
        });
        if (tail.length > 0) parts.push(tail);
      } catch {
        // nothing decodable
      }
      break;
    }
    const slice = buffer.subarray(at, at + length);
    at += length;
    if ((slice.readUInt32LE(0) & SKIPPABLE_MAGIC_MASK) === SKIPPABLE_MAGIC) {
      continue;
    }
    try {
      parts.push(zstdDecompressSync(slice));
    } catch {
      // skip a corrupt frame
    }
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Decode every frame off the event loop's critical path (one frame per turn). */
export async function decodeZstdFramesAsync(buffer: Buffer): Promise<string> {
  return (await walkFrames(buffer, decodeAsync)).toString("utf8");
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
      header = headerOf(record);
      continue;
    }
    if (typeof record.type === "string") events.push(record);
  }
  return { header, events };
}

function headerOf(record: Record<string, unknown>): SessionHeader {
  return {
    id: String(record.id),
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

/**
 * Only the header line: dsh writes it as the first frame on its own, so a
 * caller deciding whether it may read the log at all inflates one frame,
 * not the file.
 */
export async function readSessionHeader(
  file: string
): Promise<SessionHeader | null> {
  const buffer = await readFile(file);
  if (!file.endsWith(".zstd")) {
    return parseSessionLog(buffer.toString("utf8").split("\n")[0] ?? "").header;
  }
  const length = zstdFrameLength(buffer, 0);
  if (length === null) return null;
  try {
    const first = await zstdDecompressAsync(buffer.subarray(0, length));
    return parseSessionLog(first.toString("utf8")).header;
  } catch {
    return null;
  }
}

export async function readSessionLog(file: string): Promise<SessionLog> {
  const info = await stat(file);
  if (info.size > SESSION_LOG_MAX_BYTES) {
    return {
      header: await readSessionHeader(file),
      events: [],
      size: info.size,
      mtimeMs: info.mtimeMs,
      partial: true,
    };
  }
  // Stat, then read: dsh may append between the two, and the cache key
  // must describe the bytes actually parsed, so size is the buffer's.
  const buffer = await readFile(file);
  const text = file.endsWith(".zstd")
    ? await decodeZstdFramesAsync(buffer)
    : buffer.toString("utf8");
  return {
    ...parseSessionLog(text),
    size: buffer.length,
    mtimeMs: info.mtimeMs,
    partial: false,
  };
}

/** Reads session logs, keeping the last parse of each file while it is unchanged. */
export type SessionLogReader = { read: (file: string) => Promise<SessionLog> };

const READER_MAX_ENTRIES = 64;

export function createSessionLogReader(): SessionLogReader {
  const cache = new Map<string, SessionLog>();
  return {
    async read(file) {
      const info = await stat(file);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
        return hit;
      }
      const log = await readSessionLog(file);
      cache.delete(file);
      cache.set(file, log);
      if (cache.size > READER_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return log;
    },
  };
}
