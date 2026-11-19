import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  isSessionFileData,
  isSessionFileName,
  isSessionFilePath,
  MAX_SESSION_FILE_BASE64,
  MAX_SESSION_FILE_BYTES,
} from "@dispatch/runner-protocol";
import {
  openLinuxDirectory,
  openRegularFile,
} from "../../files/open-workspace-file.js";

export async function readSessionFile(root: string, relative: string) {
  if (!isSessionFilePath(relative) || path.isAbsolute(relative))
    throw new Error("Invalid relative session file path.");
  const file = await openRegularFile(root, relative.split("/"));
  try {
    const stat = await file.stat();
    if (stat.nlink !== 1)
      throw new Error("Hard-linked files cannot be collected.");
    if (stat.size > MAX_SESSION_FILE_BYTES)
      throw new Error("Session files are limited to 20 MiB.");
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

async function deliverSessionFile(root: string, name: string, data: string) {
  if (!isSessionFileName(name) || !isSessionFileData(data))
    throw new Error("Invalid session input file.");
  const dir = await openLinuxDirectory(root);
  const destination = `/proc/self/fd/${dir.fd}`;
  const temp = path.join(destination, `.incoming-${randomUUID()}`);
  try {
    await writeFile(temp, Buffer.from(data, "base64"), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temp, path.join(destination, name));
  } finally {
    try {
      await unlink(temp).catch(() => {});
    } finally {
      await dir.close();
    }
  }
}

/** The supervisor supplies the root, and this process runs as the workload UID. */
export async function runSessionFileCli(
  kind: string,
  root: string,
  name: string
) {
  try {
    if (kind === "collect") {
      process.stdout.write(
        (await readSessionFile(root, name)).toString("base64")
      );
      return;
    }
    let data = "";
    process.stdin.setEncoding("ascii");
    for await (const chunk of process.stdin) {
      data += chunk;
      if (data.length > MAX_SESSION_FILE_BASE64)
        throw new Error("Session files are limited to 20 MiB.");
    }
    if (kind !== "deliver") throw new Error("Unknown session file operation.");
    await deliverSessionFile(root, name, data);
  } catch (error) {
    const message =
      error instanceof Error && !("code" in error)
        ? error.message
        : "Session file is unavailable.";
    process.stderr.write(message);
    process.exitCode = 1;
  }
}
