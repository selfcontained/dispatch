import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { isBuildIdentity } from "../build-identity.js";
import type { RunnerCompatibility } from "./update-handoff.js";
import {
  candidatePath,
  RUNNER_UPDATE_EXECUTABLE_LIMIT,
  type RunnerUpdateLayout,
  type RunnerUpdateRequest,
} from "./update-verify.js";

export const RUNNER_COMPATIBILITY_MODE = "runner-update-compatibility";
const probeTimeoutMs = 5_000;
const probeOutputLimit = 4096;
const unitDetailLimit = 256;

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
  timeout = probeTimeoutMs
): Promise<RunnerCompatibility> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: "/",
      env: { HOME: "/nonexistent" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
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
    const stderr: Buffer[] = [];
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
    child.stderr!.on("data", (chunk: Buffer) => {
      if (count(chunk)) stderr.push(chunk);
    });
    child.once("error", () =>
      fail("Runner compatibility probe could not start")
    );
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = Buffer.concat(stderr)
          .toString("utf8")
          .trim()
          .slice(0, 512);
        reject(
          new Error(
            `Runner compatibility probe failed (${signal ?? `exit ${code}`})${detail ? `: ${detail}` : ""}`
          )
        );
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

function systemctl(...args: string[]) {
  return new Promise<string>((resolve) => {
    execFile(
      "/usr/bin/systemctl",
      args,
      {
        timeout: probeTimeoutMs,
        maxBuffer: 4 * probeOutputLimit,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      },
      (error, stdout) => resolve(error ? "" : String(stdout))
    );
  });
}

/**
 * systemd-run says nothing about a unit that failed before exec, so read the
 * failed unit's own result. It stays loaded until it is reset below.
 */
async function reapFailedProbe(unit: string) {
  const shown = await systemctl(
    "show",
    "--property=Result",
    "--property=ExecMainCode",
    "--property=ExecMainStatus",
    "--property=ExecStartPre",
    unit
  );
  await systemctl("stop", unit);
  await systemctl("reset-failed", unit);
  const value = (name: string) =>
    new RegExp(`^${name}=(.*)$`, "m").exec(shown)?.[1];
  const result = value("Result");
  // A unit that never loaded, or is still running, shows success.
  if (!result || result === "success") return "";
  const detail = [`result ${result}`];
  // CLD_EXITED, CLD_KILLED and CLD_DUMPED. Zero means it never ran.
  const code = value("ExecMainCode");
  const status = value("ExecMainStatus");
  if (code === "1") detail.push(`main exit status ${status}`);
  else if (code === "2" || code === "3") detail.push(`main signal ${status}`);
  for (const [, how, number] of shown.matchAll(
    /^ExecStartPre=.* code=(exited|killed|dumped) ; status=([1-9]\d*)/gm
  ))
    detail.push(`ExecStartPre ${how} with status ${number}`);
  return ` [${detail.join(", ").slice(0, unitDetailLimit)}]`;
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

  // PID 1 bind-mounts this private, re-hashed copy read-only into the probe
  // unit. The probe UID cannot traverse the staging directory on the host.
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
    // systemd-run resolves argv[0] before creating the mount namespace.
    // The installed path exists on an executable filesystem. Inside the unit
    // its required read-only bind mount replaces it with the staged copy.
    const executable = layout.installed;
    // A successful unit is collected on exit. A failed one is kept for its
    // result, then reset.
    const unit = `dispatch-runner-probe-${randomBytes(8).toString("hex")}.service`;
    return await readRunnerCompatibility(
      "/usr/bin/systemd-run",
      [
        "--wait",
        "--pipe",
        "--quiet",
        `--unit=${unit}`,
        "--service-type=exec",
        "--property=User=nobody",
        "--property=Group=65534",
        "--property=CapabilityBoundingSet=",
        "--property=NoNewPrivileges=yes",
        "--property=TimeoutStartSec=5s",
        "--property=RuntimeMaxSec=5s",
        "--property=KillSignal=SIGKILL",
        "--property=MemoryMax=512M",
        "--property=TasksMax=32",
        "--property=ProtectSystem=strict",
        "--property=ProtectHome=yes",
        "--property=PrivateTmp=yes",
        "--property=PrivateDevices=yes",
        "--property=PrivateNetwork=yes",
        "--property=RestrictNamespaces=yes",
        "--property=RestrictSUIDSGID=yes",
        "--property=SystemCallArchitectures=native",
        `--property=BindReadOnlyPaths=${copy}:${executable}`,
        "--",
        executable,
        RUNNER_COMPATIBILITY_MODE,
      ],
      target.version,
      11_000
    ).catch(async (error: Error) => {
      throw new Error(`${error.message}${await reapFailedProbe(unit)}`);
    });
  } finally {
    await unlink(copy).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
