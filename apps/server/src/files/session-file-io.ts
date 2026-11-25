import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import {
  isSessionFilePath,
  MAX_SESSION_FILE_BYTES,
} from "@dispatch/runner-protocol";
import {
  openRegularFile,
  openSourceFile,
  realDirectory,
} from "./open-workspace-file.js";

export async function openBoundedSessionFile(root: string, relative: string) {
  if (!isSessionFilePath(relative) || path.isAbsolute(relative))
    throw new Error("Invalid relative session file path.");
  const file = await openRegularFile(root, relative.split("/"));
  try {
    const stat = await file.stat();
    if (stat.nlink !== 1)
      throw new Error("Hard-linked files cannot be collected.");
    if (stat.size > MAX_SESSION_FILE_BYTES)
      throw new Error("Session files are limited to 20 MiB.");
    return { file, stat };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function readSessionFile(root: string, relative: string) {
  const { file, stat } = await openBoundedSessionFile(root, relative);
  try {
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        size,
        bytes.length - size,
        size
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size || (await file.stat()).mtimeMs !== stat.mtimeMs)
      throw new Error(
        "Session file changed during transfer. Retry when it is stable."
      );
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}

export async function digestSessionFile(source: string): Promise<string> {
  const file = await openSourceFile(source);
  const hash = createHash("sha256");
  for await (const chunk of file.createReadStream()) hash.update(chunk);
  return hash.digest("hex");
}

const changedFile = () =>
  new Error("Session file changed during transfer. Retry when it is stable.");

/**
 * A file to hand to a runner: streamed as it is where the peer supports it,
 * or read whole under today's v1 limits where it does not. Used once.
 */
export async function sessionFileSource(source: string, digest?: string) {
  // Checked now and opened again only when read, so a source nobody reads
  // (a put refused before it sends) holds no file handle.
  const checked = await openSourceFile(source);
  let identity: { dev: number; ino: number; size: number };
  try {
    identity = await checked.stat();
  } finally {
    await checked.close();
  }
  return {
    size: identity.size,
    open: () =>
      Readable.from(
        (async function* () {
          const file = await openSourceFile(source);
          try {
            const { dev, ino } = await file.stat();
            if (dev !== identity.dev || ino !== identity.ino)
              throw changedFile();
            const hash = digest ? createHash("sha256") : null;
            for await (const chunk of file.createReadStream({
              autoClose: false,
            })) {
              hash?.update(chunk);
              yield chunk;
            }
            if (hash && hash.digest("hex") !== digest) throw changedFile();
          } finally {
            await file.close();
          }
        })(),
        { objectMode: false }
      ),
    read: async () => {
      const bytes = await readSessionFile(
        await realDirectory(path.dirname(source)),
        path.basename(source)
      );
      if (digest && createHash("sha256").update(bytes).digest("hex") !== digest)
        throw changedFile();
      return bytes;
    },
  };
}
