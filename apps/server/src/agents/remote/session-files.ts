import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  isSessionFileData,
  isSessionFileName,
  MAX_SESSION_FILE_BASE64,
  MAX_SESSION_FILE_BYTES,
} from "@dispatch/runner-protocol";
import { openLinuxDirectory } from "../../files/open-workspace-file.js";
import { executionArgs, setpriv } from "./workload-identity.js";

export function sessionFileCommand(
  uid: number,
  gid: number,
  helper: string[],
  kind: "deliver" | "receive" | "collect" | "stream",
  root: string,
  name: string
) {
  return [
    setpriv,
    [...executionArgs(uid, gid), ...helper, kind, root, name],
  ] as const;
}

/** Open as the workload. O_NONBLOCK lets us reject FIFOs without waiting. */
async function collectFile(source: string, legacy: boolean) {
  const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Not a regular file.");
    const stream = file.createReadStream({ autoClose: false });
    if (!legacy) {
      await pipeline(stream, process.stdout);
      return;
    }
    stream.setEncoding("base64");
    let encoded = "";
    for await (const chunk of stream) {
      encoded += chunk;
      if (Buffer.byteLength(encoded, "base64") > MAX_SESSION_FILE_BYTES)
        throw new Error("Session files are limited to 20 MiB.");
    }
    process.stdout.write(encoded);
  } finally {
    await file.close();
  }
}

/** Write as the workload into the supervisor's directory, then rename into place. */
async function deliverSessionFile(
  root: string,
  name: string,
  data: string | Readable
) {
  if (
    !isSessionFileName(name) ||
    (typeof data === "string" && !isSessionFileData(data))
  )
    throw new Error("Invalid session input file.");
  const dir = await openLinuxDirectory(root);
  const destination = `/proc/self/fd/${dir.fd}`;
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
      await dir.close();
    }
  }
}

/** `receive` passes `<size>:<name>` so the helper can verify the stream. */
export function sizedName(name: string, size: number) {
  return `${size}:${name}`;
}

function splitSizedName(value: string): [string, number] {
  const colon = value.indexOf(":");
  const size = Number(value.slice(0, colon));
  if (colon < 1 || !Number.isSafeInteger(size) || size < 0)
    throw new Error("Invalid session input file.");
  return [value.slice(colon + 1), size];
}

/** The supervisor supplies the root, and this process runs as the workload UID. */
export async function runSessionFileCli(
  kind: string,
  root: string,
  name: string
) {
  try {
    if (kind === "collect" || kind === "stream") {
      // Do not normalize: the kernel resolves symlinks and .. components.
      await collectFile(root ? `${root}/${name}` : name, kind === "collect");
      return;
    }
    if (kind === "receive") {
      // Streamed bytes: the caller's flow control bounds memory, not a size
      // cap. A short or long stream (a cancelled transfer) is discarded.
      const [file, expected] = splitSizedName(name);
      let received = 0;
      const counted = process.stdin.pipe(
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > expected)
              callback(new Error("Session file is longer than announced."));
            else callback(null, chunk);
          },
          flush(callback) {
            callback(
              received === expected
                ? null
                : new Error("Session file transfer ended early.")
            );
          },
        })
      );
      process.stdin.once("error", (error) => counted.destroy(error));
      await deliverSessionFile(root, file, counted);
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
        : error instanceof Error &&
            "code" in error &&
            typeof error.code === "string" &&
            /^[A-Z0-9]+$/.test(error.code)
          ? `Session file is unavailable (${error.code}).`
          : "Session file is unavailable.";
    process.stderr.write(message);
    process.exitCode = 1;
  }
}
