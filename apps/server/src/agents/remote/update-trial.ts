import { execFile } from "node:child_process";
import {
  copyFile,
  chmod,
  link,
  lstat,
  open,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import { embeddedBuild, type BuildIdentity } from "../build-identity.js";
import type { RunnerInstalledBuild, RunnerUpdateReason } from "./protocol.js";
import type { FenceRecord } from "./update-admission.js";
import { fileFenceStore } from "./update-fence-store.js";
import { compiledRunnerUpdateKeys } from "./update-keys.js";
import { RUNNER_UPDATE_VERSION } from "./update-manifest.js";
import {
  compareRunnerVersions,
  confirmedFloor,
  RUNNER_UPDATE_LAYOUT,
  sha256File,
  syncDirectory,
  trusted,
  verifiedCandidate,
  writeAtomic,
  type RunnerUpdateLayout,
} from "./update-verify.js";

// Covers supervisor startup, reconnect backoff, journal replay and retained-host
// attachment while leaving eleven minutes of the controller's 15-minute hold.
export const RUNNER_TRIAL_MS = 4 * 60_000;
const POLL_MS = 500;
const SUPERVISOR = "dispatch-runner.service";
export const TRIAL_UNIT = "dispatch-runner-trial.service";
export const TRIAL_HELPER = "update/activate-helper";
const JOURNAL = "trial.json";

type Failure = Extract<
  RunnerUpdateReason,
  | "boot_failed"
  | "confirm_timeout"
  | "reattach_failed"
  | "verify_failed"
  | "cancelled"
>;
type Pending = {
  fence: FenceRecord;
  previous: RunnerInstalledBuild;
  deadline: number;
  phase: "prepared" | "starting" | "trial" | "committing" | "restoring";
  reason?: Failure;
};
type Terminal = {
  fence: FenceRecord;
  phase: "confirmed" | "rolled_back" | "deferred";
  reason?: Failure;
};
export type TrialRecord = Pending | Terminal;
type Signal =
  | { kind: "ready"; pid: number }
  | { kind: "disconnect" }
  | { kind: "confirm"; observed: { revision: string; sha256: string } }
  | {
      kind: "reject";
      reason: "verify_failed" | "reattach_failed" | "cancelled";
    };
type Mail = Signal & { attemptId: string; startedAt: number };

async function readRecord<T>(file: string, uid: number): Promise<T | null> {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  await trusted(file, "file", uid, true);
  if (stat.size > 512 * 1024) throw new Error("Oversized runner trial record");
  const handle = await open(file, "r");
  try {
    return JSON.parse(await handle.readFile("utf8")) as T;
  } finally {
    await handle.close();
  }
}

export function readTrial(layout: RunnerUpdateLayout, uid = 0) {
  return readRecord<TrialRecord>(path.join(layout.state, JOURNAL), uid);
}

export function trialMatches(trial: TrialRecord | null, fence: FenceRecord) {
  return (
    trial?.fence.attemptId === fence.attemptId &&
    trial.fence.startedAt === fence.startedAt &&
    trial.fence.target.sha256 === fence.target.sha256
  );
}

export function terminalTrial(trial: TrialRecord): trial is Terminal {
  return (
    trial.phase === "confirmed" ||
    trial.phase === "rolled_back" ||
    trial.phase === "deferred"
  );
}

function mailName(
  fence: FenceRecord,
  signal: "ready" | "decision" | "disconnect"
) {
  return `trial-${fence.attemptId}-${fence.startedAt}-${signal}.json`;
}

export async function sendTrialSignal(
  layout: RunnerUpdateLayout,
  fence: FenceRecord,
  signal: Signal
) {
  const name = mailName(
    fence,
    signal.kind === "ready" || signal.kind === "disconnect"
      ? signal.kind
      : "decision"
  );
  const file = path.join(layout.state, name);
  const message = JSON.stringify({
    ...signal,
    attemptId: fence.attemptId,
    startedAt: fence.startedAt,
  });
  if (signal.kind === "ready" || signal.kind === "disconnect") {
    await writeAtomic(layout.state, name, message);
    return;
  }
  // Both messages can arrive on adjacent connection epochs. The first decision
  // is immutable, including across a daemon restart.
  const temp = `${name}.${crypto.randomUUID()}`;
  await writeAtomic(layout.state, temp, message);
  try {
    await link(path.join(layout.state, temp), file);
    await syncDirectory(layout.state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await rm(path.join(layout.state, temp), { force: true });
  }
}

export async function isSuppressed(
  layout: RunnerUpdateLayout,
  sha256: string,
  uid = 0
) {
  return (
    (await readRecord(
      path.join(layout.state, `failed-${sha256}.json`),
      uid
    )) !== null
  );
}

const execute = promisify(execFile);
async function systemctl(...args: string[]) {
  const { stdout } = await execute("/usr/bin/systemctl", args, {
    timeout: 100_000,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  return stdout.trim();
}

/** Called with an existing fence, so new manual writers will refuse it. */
export async function trialLocksAvailable(layout: RunnerUpdateLayout) {
  try {
    await execute(
      "/usr/bin/flock",
      [
        "-n",
        path.join(path.dirname(layout.installed), "install.lock"),
        "/usr/bin/flock",
        "-n",
        path.join(layout.state, "stage.lock"),
        "/usr/bin/true",
      ],
      { timeout: 5_000 }
    );
    return true;
  } catch {
    return false;
  }
}

export function startRunnerTrial() {
  return systemctl("--no-block", "start", TRIAL_UNIT);
}

export async function trialHelperAvailable(layout: RunnerUpdateLayout) {
  if (
    layout !== RUNNER_UPDATE_LAYOUT ||
    process.platform !== "linux" ||
    process.getuid?.() !== 0
  )
    return false;
  try {
    const helper = await trusted(
      path.join(path.dirname(layout.installed), TRIAL_HELPER),
      "file",
      0,
      false
    );
    if (!(helper.mode & 0o100)) return false;
    for (const file of [TRIAL_UNIT, `${SUPERVISOR}.d/50-dispatch-trial.conf`])
      await trusted(path.join("/etc/systemd/system", file), "file", 0, false);
    const [loaded, execStart, pre] = await Promise.all([
      systemctl("show", "-p", "LoadState", "--value", TRIAL_UNIT),
      systemctl("show", "-p", "ExecStart", "--value", TRIAL_UNIT),
      systemctl("show", "-p", "ExecStartPre", "--value", SUPERVISOR),
    ]);
    return (
      loaded === "loaded" &&
      execStart.includes(`${TRIAL_HELPER} runner-update-trial live`) &&
      pre.includes(`${TRIAL_HELPER} runner-update-trial boot`)
    );
  } catch {
    return false;
  }
}

export type TrialSystem = {
  stop(): Promise<void>;
  start(): Promise<void>;
  pid(): Promise<number>;
};

export function systemdSupervisor(command = systemctl): TrialSystem {
  async function show(...properties: string[]) {
    const output = await command(
      "show",
      ...properties.map((property) => `--property=${property}`),
      SUPERVISOR
    );
    return Object.fromEntries(
      output.split("\n").map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 1)];
      })
    );
  }
  return {
    async stop() {
      const policy = await show("KillMode", "ExecStop", "ExecStopPost");
      // Older systemd omits empty stop hooks from show output.
      if (
        policy.KillMode !== "process" ||
        policy.ExecStop ||
        policy.ExecStopPost
      )
        throw new Error("Runner stop policy cannot preserve hosts");
      await command("stop", SUPERVISOR);
      const state = await show("ActiveState", "MainPID");
      if (
        state.MainPID !== "0" ||
        !["inactive", "failed"].includes(state.ActiveState!)
      )
        throw new Error("Old runner supervisor is still running");
    },
    async start() {
      await command("reset-failed", SUPERVISOR).catch(() => {});
      await command("start", SUPERVISOR);
    },
    async pid() {
      const state = await show("ActiveState", "MainPID");
      return state.ActiveState === "active" ? Number(state.MainPID) : 0;
    },
  };
}

/** The unit holds install.lock for this entire function. Boot mode never starts
 * or stops the unit that invoked it through ExecStartPre. */
export async function runTrial(options: {
  layout: RunnerUpdateLayout;
  uid: number;
  boot: boolean;
  build: BuildIdentity;
  verify(fence: FenceRecord): Promise<string | undefined>;
  system: TrialSystem;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  checkpoint?: (name: string) => Promise<void>;
}) {
  const { layout, uid, boot, system } = options;
  const now = options.now ?? (() => performance.timeOrigin + performance.now());
  const sleep = options.sleep ?? pause;
  const checkpoint = options.checkpoint ?? (async () => {});
  const store = fileFenceStore(layout.state, uid);
  const runtime = path.dirname(layout.installed);
  const backup = path.join(layout.staging, "trial-previous");
  const next = path.join(layout.staging, "trial-next");
  const save = async (record: TrialRecord) => {
    await writeAtomic(layout.state, JOURNAL, JSON.stringify(record));
    await checkpoint(record.phase);
  };
  const identity = ({ version, revision, sha256 }: RunnerInstalledBuild) => ({
    version,
    revision,
    sha256,
  });
  const fileSync = async (file: string) => {
    const handle = await open(file, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  const replaceLink = async (source: string, destination: string) => {
    const temporary = `${destination}.new`;
    await rm(temporary, { force: true });
    await link(source, temporary);
    await rename(temporary, destination);
    // rename(2) is a no-op if both names already link the same inode.
    await rm(temporary, { force: true });
    await syncDirectory(path.dirname(destination));
  };
  const finish = async (result: Terminal) => {
    await save(result);
    await cleanup(result);
  };
  const cleanup = async (result: Terminal) => {
    const fence = await store.read();
    if (fence?.phase === "activating" && trialMatches(result, fence)) {
      await store.clear();
      await syncDirectory(layout.state);
    }
    await rm(backup, { force: true });
    await rm(next, { force: true });
    for (const type of ["ready", "decision", "disconnect"] as const)
      await rm(path.join(layout.state, mailName(result.fence, type)), {
        force: true,
      });
    await syncDirectory(layout.staging);
    await syncDirectory(layout.state);
  };
  const commit = async (record: Pending) => {
    const target = identity(record.fence.target);
    if ((await sha256File(layout.installed)) !== target.sha256)
      throw new Error("Confirmed runner binary changed before commit");
    await replaceLink(backup, path.join(runtime, "previous-verified"));
    await checkpoint("previous-published");
    await writeAtomic(
      layout.state,
      "previous-verified.json",
      JSON.stringify(record.previous)
    );
    await writeAtomic(layout.state, "floor.json", JSON.stringify(target));
    await checkpoint("floor-published");
    await writeAtomic(layout.state, "confirmed.json", JSON.stringify(target));
    const { ino } = await lstat(layout.installed);
    await writeAtomic(
      runtime,
      "installed-release",
      `${ino} v${target.version}\n`
    );
    await replaceLink(layout.installed, path.join(runtime, TRIAL_HELPER));
    await checkpoint("helper-refreshed");
    await rm(path.join(layout.state, `failed-${target.sha256}.json`), {
      force: true,
    });
    await finish({ fence: record.fence, phase: "confirmed" });
  };
  const rollback = async (record: Pending, reason: Failure) => {
    const active = await lstat(layout.installed);
    const old = await lstat(backup);
    const swapped = active.ino !== old.ino || active.dev !== old.dev;
    if (!swapped && record.phase !== "restoring") {
      // A crash during stop can leave the old service down. Its bytes and the
      // verified candidate are still intact.
      if (!boot && !(await system.pid()))
        await system.start().catch(console.error);
      return finish({ fence: record.fence, phase: "deferred", reason });
    }
    if (record.phase !== "restoring")
      await save({ ...record, phase: "restoring", reason });
    if (swapped) {
      if (!boot) await system.stop();
      await replaceLink(backup, layout.installed);
      await checkpoint("restored");
    }
    // Record suppression before releasing the fence, including across a crash
    // after the restore rename.
    await writeAtomic(
      layout.state,
      `failed-${record.fence.target.sha256}.json`,
      JSON.stringify({ attemptId: record.fence.attemptId, reason })
    );
    await checkpoint("suppression-published");
    if (!boot && !(await system.pid()))
      await system.start().catch(console.error);
    await finish({ fence: record.fence, phase: "rolled_back", reason });
  };

  await trusted(runtime, "directory", uid, false);
  await trusted(layout.installed, "file", uid, false);
  await trusted(layout.staging, "directory", uid, true);
  await trusted(layout.state, "directory", uid, true);
  const prior = await readTrial(layout, uid);
  if (prior) {
    if (terminalTrial(prior)) await cleanup(prior);
    else if (prior.phase === "committing") return commit(prior);
    else
      return rollback(
        prior,
        prior.reason ??
          (prior.phase === "trial" ? "confirm_timeout" : "boot_failed")
      );
  }

  const fence = await store.read();
  if (fence?.phase !== "activating") return;
  if (boot) {
    return finish({ fence, phase: "deferred", reason: "cancelled" });
  }
  const decision = () =>
    readRecord<Mail>(path.join(layout.state, mailName(fence, "decision")), uid);
  const previous = {
    ...options.build,
    revision: options.build.revision ?? "",
    sha256: await sha256File(layout.installed),
  };
  const floor = await confirmedFloor(layout, previous, uid);
  const target = fence.target;
  if (
    !RUNNER_UPDATE_VERSION.test(previous.version) ||
    !previous.revision ||
    [previous, floor].some(
      (old) => compareRunnerVersions(target.version, old.version) <= 0
    )
  ) {
    return finish({ fence, phase: "deferred", reason: "verify_failed" });
  }
  const candidate = await options.verify(fence);
  const helper = await lstat(path.join(runtime, TRIAL_HELPER));
  const active = await lstat(layout.installed);
  if (
    helper.ino !== active.ino ||
    helper.dev !== active.dev ||
    active.dev !== (await lstat(layout.staging)).dev
  )
    return finish({ fence, phase: "deferred", reason: "verify_failed" });
  if (!candidate)
    return finish({ fence, phase: "deferred", reason: "verify_failed" });

  await rm(next, { force: true });
  await copyFile(candidate, next);
  if ((await sha256File(next)) !== target.sha256)
    return finish({ fence, phase: "deferred", reason: "verify_failed" });
  await chmod(next, 0o755);
  await fileSync(next);
  await replaceLink(layout.installed, backup);
  await fileSync(backup);
  await checkpoint("backup-pinned");
  const record: Pending = {
    fence,
    previous,
    deadline: now() + RUNNER_TRIAL_MS,
    phase: "prepared",
  };
  await save(record);
  const matchesFence = async () => {
    const current = await store.read();
    return (
      current?.phase === "activating" &&
      trialMatches(record, current) &&
      JSON.stringify(current) === JSON.stringify(fence)
    );
  };
  const interrupted = async () =>
    now() >= record.deadline ||
    !(await matchesFence()) ||
    (await decision())?.kind === "reject" ||
    (await readRecord(
      path.join(layout.state, mailName(fence, "disconnect")),
      uid
    )) !== null;
  if (await interrupted()) return rollback(record, "cancelled");
  try {
    await system.stop();
  } catch (error) {
    console.error(error);
    return rollback(record, "boot_failed");
  }
  await checkpoint("stopped");
  if (await interrupted()) return rollback(record, "cancelled");
  await rename(next, layout.installed);
  await checkpoint("swap-renamed");
  await syncDirectory(runtime);
  await syncDirectory(layout.staging);
  await checkpoint("swapped");
  record.phase = "starting";
  await save(record);
  try {
    await system.start();
  } catch (error) {
    console.error(error);
    return rollback(record, "boot_failed");
  }
  const pid = await system.pid();
  while (now() < record.deadline) {
    if (!pid || (await system.pid()) !== pid)
      return rollback(record, "boot_failed");
    const mail = await decision();
    if (mail?.kind === "reject") return rollback(record, mail.reason);
    if (record.phase === "starting") {
      const ready = await readRecord<Mail>(
        path.join(layout.state, mailName(fence, "ready")),
        uid
      );
      if (
        ready?.kind === "ready" &&
        ready.pid === pid &&
        ready.attemptId === fence.attemptId &&
        ready.startedAt === fence.startedAt
      ) {
        record.phase = "trial";
        await save(record);
      }
    } else if (
      mail?.kind === "confirm" &&
      mail.attemptId === fence.attemptId &&
      mail.startedAt === fence.startedAt
    ) {
      if (
        mail.observed.sha256 !== target.sha256 ||
        mail.observed.revision !== target.revision
      )
        return rollback(record, "verify_failed");
      if (now() >= record.deadline) break;
      record.phase = "committing";
      await save(record);
      return commit(record);
    }
    await sleep(POLL_MS);
  }
  await rollback(
    record,
    record.phase === "starting" ? "boot_failed" : "confirm_timeout"
  );
}

export async function runRunnerUpdateTrial(argv: string[]) {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    argv.length !== 1 ||
    !["live", "boot"].includes(argv[0]!)
  )
    throw new Error(
      "Runner update trial requires the managed Linux installation"
    );
  await runTrial({
    layout: RUNNER_UPDATE_LAYOUT,
    uid: 0,
    boot: argv[0] === "boot",
    build: embeddedBuild,
    system: systemdSupervisor(),
    verify: (fence) =>
      fence.target.arch === process.arch
        ? verifiedCandidate(
            RUNNER_UPDATE_LAYOUT,
            fence.target,
            compiledRunnerUpdateKeys(),
            0
          )
        : Promise.resolve(undefined),
  });
}
