import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";

/** The bytes of a session file, as a runner transport sends them. */
export type SessionFileSource = {
  size: number;
  /** A fresh read of the bytes, for a stream. */
  open(): Readable;
  /** The whole file, for a v1 frame. */
  read(): Promise<Buffer>;
};

/**
 * A file on this machine that `files.put` hands to a session. The request's
 * `blob` names it and the transport resolves it (design 1.3): the local
 * runner hands over the path where it is, with no read; a remote runner
 * streams the bytes. Size and digest are taken here, lazily, by the
 * transport that needs them.
 */
export type SessionFileBlob = {
  /** Where the file is on this machine. */
  path: string;
  /**
   * `prompt`: a missing file fails the put (it drops out of the prompt).
   * `reference`: a listed row, handed over as it is; a runner stores it
   * under its digest so a changed file gets a new path.
   */
  purpose: "prompt" | "reference";
  digest(): Promise<string>;
  source(digest?: string): Promise<SessionFileSource>;
};

const PREFIX = "dispatch-session-file:";
const blobs = new Map<string, SessionFileBlob>();

/** Name `file` as a `files.put` blob for the duration of `run`. */
export async function withSessionFileBlob<T>(
  file: SessionFileBlob,
  run: (blob: string) => Promise<T>
): Promise<T> {
  const blob = PREFIX + randomUUID();
  blobs.set(blob, file);
  try {
    return await run(blob);
  } finally {
    blobs.delete(blob);
  }
}

/** The file a `files.put` request's `blob` names. */
export function sessionFileBlob(blob: string): SessionFileBlob {
  const file = blobs.get(blob);
  if (!file)
    throw new RunnerCallError({
      code: "invalid",
      message: "Unknown session file.",
    });
  return file;
}

const BYTES_PREFIX = "dispatch-session-file-bytes:";
const read = new Map<string, Buffer>();

/**
 * A `files.get` answer's `blob` for bytes read in this process: the caller
 * takes the same `Buffer` back, with no encoding (design 1.3).
 */
export function sessionFileBytesBlob(bytes: Buffer): string {
  const blob = BYTES_PREFIX + randomUUID();
  read.set(blob, bytes);
  return blob;
}

/** The bytes a `files.get` answer's `blob` names, once; else undefined. */
export function takeSessionFileBytes(blob: string): Buffer | undefined {
  const bytes = read.get(blob);
  read.delete(blob);
  return bytes;
}
