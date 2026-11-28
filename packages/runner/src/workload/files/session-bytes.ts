import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  isSessionFileName,
  isSessionFileData,
  MAX_SESSION_FILE_BYTES,
} from "@dispatch/runner-protocol";
import { openLinuxDirectory } from "./open-workspace-file.js";

/** Regular files only: nonblocking open rejects FIFOs without waiting. */
async function openSessionFile(source: string) {
  const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Not a regular file.");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Stream regular files without a size cap; Local retains readFile semantics for other file types. */
export async function readSessionFileStream(
  source: string,
  regularOnly = true
) {
  const file = regularOnly
    ? await openSessionFile(source)
    : await open(source, constants.O_RDONLY);
  try {
    if (!(await file.stat()).isFile()) {
      const bytes = await file.readFile();
      await file.close();
      return { source: Readable.from([bytes]), close: async () => {} };
    }
    return {
      source: file.createReadStream({ autoClose: false }),
      close: () => file.close(),
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Bounded inline bytes, shared by native calls and the legacy workload helper. */
export async function readSessionFileBytes(source: string): Promise<Buffer> {
  const file = await openSessionFile(source);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_SESSION_FILE_BYTES)
        throw new Error("Session files are limited to 20 MiB.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}

export async function collectFile(source: string, legacy: boolean) {
  if (legacy) {
    process.stdout.write(
      (await readSessionFileBytes(source)).toString("base64")
    );
    return;
  }
  const file = await readSessionFileStream(source);
  try {
    await pipeline(file.source, process.stdout);
  } finally {
    file.source.destroy();
    await file.close();
  }
}

/** Write as the workload into the supervisor's directory, then rename into place. */
export async function deliverSessionFile(
  root: string,
  name: string,
  data: string | Readable
) {
  if (
    !isSessionFileName(name) ||
    (typeof data === "string" && !isSessionFileData(data))
  )
    throw new Error("Invalid session input file.");
  const dir =
    process.platform === "linux" ? await openLinuxDirectory(root) : undefined;
  const destination = dir ? `/proc/self/fd/${dir.fd}` : await realpath(root);
  const temp = path.join(destination, `.incoming-${randomUUID()}`);
  try {
    await writeFile(
      temp,
      typeof data === "string" ? Buffer.from(data, "base64") : data,
      { flag: "wx", mode: 0o600 }
    );
    await rename(temp, path.join(destination, name));
  } finally {
    try {
      await unlink(temp).catch(() => {});
    } finally {
      await dir?.close();
    }
  }
}
