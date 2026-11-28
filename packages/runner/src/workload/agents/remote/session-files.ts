import { Transform } from "node:stream";

import { MAX_SESSION_FILE_BASE64 } from "@dispatch/runner-protocol";
import { collectFile, deliverSessionFile } from "../../files/session-bytes.js";
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
