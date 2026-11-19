import path from "node:path";
import {
  isSessionFilePath,
  MAX_SESSION_FILE_BYTES,
} from "@dispatch/runner-protocol";
import { openRegularFile } from "./open-workspace-file.js";

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
