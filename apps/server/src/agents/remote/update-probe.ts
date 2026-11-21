import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { isBuildIdentity } from "../build-identity.js";
import type { RunnerCompatibility } from "./update-handoff.js";
import {
  candidatePath,
  RUNNER_UPDATE_EXECUTABLE_LIMIT,
  type RunnerUpdateLayout,
  type RunnerUpdateRequest,
} from "./update-verify.js";
import { setpriv } from "./workload-identity.js";

export const RUNNER_COMPATIBILITY_MODE = "runner-update-compatibility";
const probeTimeoutMs = 5_000;
const probeOutputLimit = 4096;

export function parseCompatibility(
  stdout: string,
  expectedVersion: string
): RunnerCompatibility {
  const value = JSON.parse(stdout) as RunnerCompatibility | null;
  const format = (epoch: unknown): epoch is number =>
    typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch > 0;
  if (
    !value ||
    !isBuildIdentity(value) ||
    !value.revision ||
    value.version !== expectedVersion ||
    !value.handoff ||
    !Array.isArray(value.handoff.reads) ||
    value.handoff.reads.length > 32 ||
    !value.handoff.reads.every(format) ||
    !format(value.handoff.writes) ||
    !value.handoff.reads.includes(value.handoff.writes)
  )
    throw new Error("Invalid runner compatibility response");
  return {
    version: value.version,
    revision: value.revision,
    handoff: { reads: value.handoff.reads, writes: value.handoff.writes },
  };
}

/** Run a fixed probe with a joint output cap and a process-group deadline. */
export function readRunnerCompatibility(
  command: string,
  args: string[],
  version: string,
  executableFd?: number,
  timeout = probeTimeoutMs
): Promise<RunnerCompatibility> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: "/",
      env: { HOME: "/nonexistent" },
      detached: true,
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        ...(executableFd === undefined ? [] : [executableFd]),
      ],
    });
    const fail = (message: string) => {
      clearTimeout(timer);
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The probe may have exited just before the deadline.
        }
      }
      child.stdout!.destroy();
      child.stderr!.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail("Runner compatibility probe timed out"),
      timeout
    );
    const stdout: Buffer[] = [];
    let bytes = 0;
    function count(chunk: Buffer) {
      bytes += chunk.length;
      if (bytes > probeOutputLimit) {
        fail("Runner compatibility probe output was too large");
        return false;
      }
      return true;
    }
    child.stdout!.on("data", (chunk: Buffer) => {
      if (count(chunk)) stdout.push(chunk);
    });
    child.stderr!.on("data", count);
    child.once("error", () =>
      fail("Runner compatibility probe could not start")
    );
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("Runner compatibility probe failed"));
        return;
      }
      try {
        resolve(
          parseCompatibility(Buffer.concat(stdout).toString("utf8"), version)
        );
      } catch {
        reject(new Error("Invalid runner compatibility response"));
      }
    });
  });
}

/** Called by the root staging unit under its existing exclusive lock. */
export async function probeStagedRunner(
  layout: RunnerUpdateLayout,
  target: RunnerUpdateRequest
): Promise<RunnerCompatibility> {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error(
      "Runner compatibility probe requires the Linux staging service"
    );
  if (!/^[a-f0-9]{64}$/.test(target.sha256))
    throw new Error("Runner compatibility probe requires a staged digest");
  const candidate = candidatePath(layout, target.sha256);
  const directory = await lstat(layout.staging);
  const stat = await lstat(candidate);
  if (
    !directory.isDirectory() ||
    directory.uid !== 0 ||
    directory.mode & 0o077 ||
    !stat.isFile() ||
    stat.uid !== 0 ||
    (stat.mode & 0o7777) !== 0o700 ||
    stat.size > RUNNER_UPDATE_EXECUTABLE_LIMIT
  )
    throw new Error(
      "Runner compatibility probe requires a private staged executable"
    );

  // Keep the staged inode private and unchanged. Pass an unlinked read-only
  // copy as fd 3, so the sandbox UID needs no access to the staging tree.
  // Match the digest again on the exact bytes passed to the probe.
  const copy = path.join(
    layout.staging,
    `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`
  );
  await copyFile(candidate, copy, constants.COPYFILE_EXCL);
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(copy)) hash.update(chunk);
    if (hash.digest("hex") !== target.sha256)
      throw new Error("Runner compatibility probe digest mismatch");
    await chmod(copy, 0o555);
    const executable = await open(copy, "r");
    try {
      await unlink(copy);
      return await readRunnerCompatibility(
        setpriv,
        [
          "--reuid=65534",
          "--regid=65534",
          "--clear-groups",
          "--no-new-privs",
          "--inh-caps=-all",
          "--ambient-caps=-all",
          "--bounding-set=-all",
          "--",
          "/proc/self/fd/3",
          RUNNER_COMPATIBILITY_MODE,
        ],
        target.version,
        executable.fd
      );
    } finally {
      await executable.close();
    }
  } finally {
    await unlink(copy).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
