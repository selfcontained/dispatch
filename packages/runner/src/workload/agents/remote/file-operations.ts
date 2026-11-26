import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MANAGED_WORKSPACE } from "@dispatch/runner-protocol";
import {
  pathFromWire,
  sessionToWire,
  RunnerCallError,
} from "@dispatch/runner-protocol/contract";
import type { CallHandlers } from "../../../handlers.js";
import { sessionFileCommand, sizedName } from "./session-files.js";
import type { createSessionSupervisor } from "./session-supervisor.js";

type FileWorker = (
  kind: "receive" | "stream",
  root: string,
  name: string
) => ChildProcessWithoutNullStreams;
type FileSupervisor = Pick<
  Awaited<ReturnType<typeof createSessionSupervisor>>,
  "withSessionFile"
>;

export function workloadFileWorker(
  uid: number,
  gid: number,
  helper: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
): FileWorker {
  return (kind, root, name) => {
    const [bin, args] = sessionFileCommand(uid, gid, helper, kind, root, name);
    return spawn(bin, args, { env, signal, stdio: ["pipe", "pipe", "pipe"] });
  };
}

async function transfer<T>(
  child: ChildProcessWithoutNullStreams,
  run: () => Promise<T>
) {
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(0, 256);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(stderr.trim() || "Runner file transfer failed."))
    );
  });
  try {
    const [result] = await Promise.all([run(), exited]);
    return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

/** Resolve under the supervisor's session lock. The workload opens every file. */
export function enrolledFiles(
  supervisor: FileSupervisor,
  spawnFile: FileWorker
) {
  return {
    "files.put": async ({ session, name, size, blob }, context) => {
      if (!Number.isSafeInteger(size) || size < 0)
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid session input file.",
        });
      const body = new PassThrough();
      const received = context.receiveBlob(blob, body);
      void received.catch(() => {});
      try {
        return await supervisor.withSessionFile(
          sessionToWire(session),
          MANAGED_WORKSPACE,
          { name },
          async (root, name) => {
            const child = spawnFile("receive", root, sizedName(name, size));
            await transfer(child, () =>
              Promise.all([received, pipeline(body, child.stdin)])
            );
            return { path: pathFromWire(path.join(root, name)) };
          }
        );
      } finally {
        body.destroy();
      }
    },
    "files.get": ({ session, path: file }, { sendFile }) => {
      if (!sendFile)
        throw new RunnerCallError({
          code: "unsupported",
          message: "A file stream is required.",
        });
      return supervisor.withSessionFile(
        sessionToWire(session),
        MANAGED_WORKSPACE,
        { path: file },
        async (root, name) => {
          const child = spawnFile("stream", root, name);
          child.stdin.end();
          const digest = createHash("sha256");
          let size = 0;
          const counted = new Transform({
            transform(chunk: Buffer, _, done) {
              size += chunk.length;
              digest.update(chunk);
              done(null, chunk);
            },
          });
          const [blob] = await transfer(child, () =>
            Promise.all([sendFile(counted), pipeline(child.stdout, counted)])
          );
          return {
            name: path.basename(file),
            size,
            digest: digest.digest("hex"),
            blob,
          };
        }
      );
    },
  } satisfies CallHandlers;
}
