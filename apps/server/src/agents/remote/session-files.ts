import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  isSessionFileData,
  isSessionFileName,
  MAX_SESSION_FILE_BASE64,
} from "@dispatch/runner-protocol";
import { openLinuxDirectory } from "../../files/open-workspace-file.js";
import { readSessionFile } from "../../files/session-file.js";

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
