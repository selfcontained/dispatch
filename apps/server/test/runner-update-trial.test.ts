import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileFenceStore } from "../src/agents/remote/update-fence-store.js";
import {
  clearUnreadableFence,
  isSuppressed,
  readTrial,
  RUNNER_TRIAL_MS,
  runTrial,
  sendTrialSignal,
  systemdSupervisor,
  TRIAL_HELPER,
} from "../src/agents/remote/update-trial.js";
import { sha256File } from "../src/agents/remote/update-verify.js";
import { fenceRecord, identity } from "./runner-update-fixtures.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-trial-"));
  const uid = process.getuid!();
  const layout = {
    config: path.join(root, "config"),
    installed: path.join(root, "dispatch"),
    staging: path.join(root, "update"),
    state: path.join(root, "state"),
  };
  for (const dir of [layout.staging, layout.state])
    await mkdir(dir, { mode: 0o700 });
  await writeFile(layout.installed, "old verified bytes", { mode: 0o755 });
  const oldInode = (await lstat(layout.installed)).ino;
  const oldSha = await sha256File(layout.installed);
  const helper = path.join(root, TRIAL_HELPER);
  await link(layout.installed, helper);
  const previous = path.join(root, "previous-verified");
  await writeFile(previous, "formerly confirmed predecessor", { mode: 0o755 });
  const candidate = path.join(layout.staging, "candidate");
  await writeFile(candidate, "signed candidate", { mode: 0o700 });
  const target = { ...fenceRecord.target, sha256: await sha256File(candidate) };
  const fence = { ...fenceRecord, phase: "activating", target } as const;
  const store = fileFenceStore(layout.state, uid);
  await store.write(fence);
  let pid = 11;
  let nextPid = pid + 1;
  const system = {
    stop: vi.fn(async () => {
      pid = 0;
    }),
    start: vi.fn(async () => {
      pid = nextPid++;
    }),
    pid: vi.fn(async () => pid),
  };
  let time = 1000;
  const options: Parameters<typeof runTrial>[0] = {
    layout,
    uid,
    boot: false,
    system,
    build: identity,
    verify: vi.fn(async () => candidate),
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
  const confirm = (revision = target.revision) =>
    sendTrialSignal(layout, fence, {
      kind: "confirm",
      observed: { revision, sha256: target.sha256 },
    });
  const ready = async () =>
    sendTrialSignal(layout, fence, { kind: "ready", pid: await system.pid() });
  const journal = () => readTrial(layout, uid);
  const suppressed = () => isSuppressed(layout, target.sha256, uid);
  const floor = async () =>
    JSON.parse(await readFile(path.join(layout.state, "floor.json"), "utf8"));
  const tick = () => {
    time += RUNNER_TRIAL_MS;
  };
  const boot = () =>
    runTrial({ ...options, boot: true, checkpoint: undefined });
  const live = () => runTrial(options);
  return {
    root,
    layout,
    candidate,
    oldInode,
    oldSha,
    previous,
    helper,
    target,
    fence,
    store,
    options,
    system,
    confirm,
    ready,
    journal,
    suppressed,
    floor,
    tick,
    boot,
    live,
  };
}

describe("durable runner trial", () => {
  let s: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    s = await fixture();
  });
  afterEach(async () => {
    await rm(s.root, { recursive: true, force: true });
  });

  const malformedFence = async (
    layout: Awaited<ReturnType<typeof fixture>>["layout"]
  ) => writeFile(path.join(layout.state, "fence.json"), "{");

  it("boots with the unreadable fence intact when no trial exists", async () => {
    await malformedFence(s.layout);
    await s.boot();
    await expect(s.store.read()).rejects.toThrow();
    await expect(s.live()).rejects.toThrow();
    expect(await s.journal()).toBeNull();
    expect(s.system.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["prepared", "deferred"],
    ["swap-renamed", "rolled_back"],
    ["committing", "confirmed"],
    ["confirmed", "confirmed"],
  ])("recovers %s with an unreadable fence", async (boundary, terminal) => {
    s.options.checkpoint = async (phase) => {
      if (phase === "trial") await s.confirm();
      if (phase === boundary) throw new Error("crash fixture");
    };
    s.options.sleep = async () => {
      await s.ready();
    };
    await expect(s.live()).rejects.toThrow("crash fixture");
    await malformedFence(s.layout);
    await s.boot();
    expect(await s.journal()).toMatchObject({ phase: terminal });
    expect(await sha256File(s.layout.installed)).toBe(
      terminal === "confirmed" ? s.target.sha256 : s.oldSha
    );
    await expect(s.store.read()).rejects.toThrow();
  });

  it.each(["{", "null", "{}", '{"phase":"committing"}'])(
    "permits an unreadable trial journal (%s) only with the verified incumbent inode at boot",
    async (contents) => {
      const journal = path.join(s.layout.state, "trial.json");
      await writeFile(journal, contents, { mode: 0o600 });
      await s.boot();
      expect(await readFile(journal, "utf8")).toBe(contents);
      await expect(s.live()).rejects.toThrow();
      // Copy identical bytes to a different inode. A trusted path is not an identity.
      await rm(s.layout.installed);
      await writeFile(s.layout.installed, "old verified bytes", {
        mode: 0o755,
      });
      await expect(s.boot()).rejects.toThrow();
    }
  );

  it("boots a verified retained predecessor with an unreadable journal", async () => {
    const journal = path.join(s.layout.state, "trial.json");
    await writeFile(journal, "{", { mode: 0o600 });
    const restored = path.join(s.layout.staging, "restored");
    await link(s.previous, restored);
    await rename(restored, s.layout.installed);
    await s.boot();
    expect((await lstat(s.layout.installed)).ino).toBe(
      (await lstat(s.previous)).ino
    );
    expect(await readFile(journal, "utf8")).toBe("{");
  });

  it("rejects malformed fields in a pending trial journal", async () => {
    const journal = path.join(s.layout.state, "trial.json");
    const pending = {
      fence: s.fence,
      phase: "prepared",
      previous: { ...identity, sha256: s.oldSha },
      deadline: 1000,
    };
    await writeFile(
      journal,
      JSON.stringify({ ...pending, fence: { ...s.fence, phase: "fenced" } }),
      { mode: 0o600 }
    );
    await expect(s.journal()).rejects.toThrow("Malformed runner trial fence");
    for (const override of [
      { phase: "unknown" },
      { deadline: null },
      { previous: { ...pending.previous, version: "" } },
      { previous: { ...pending.previous, revision: null } },
      { previous: { ...pending.previous, sha256: [s.oldSha] } },
      { previous: { ...pending.previous, sha256: "bad" } },
    ]) {
      await writeFile(journal, JSON.stringify({ ...pending, ...override }), {
        mode: 0o600,
      });
      await expect(s.journal()).rejects.toThrow(
        "Malformed pending runner trial"
      );
    }
  });

  it("lets manual update quarantine a damaged fence with no pending trial", async () => {
    const clear = () => clearUnreadableFence(s.layout, s.options.uid);
    await expect(clear()).rejects.toThrow("readable runner update fence");
    await malformedFence(s.layout);
    await chmod(s.layout.state, 0o755);
    await expect(clear()).rejects.toThrow("not a private root-owned directory");
    await chmod(s.layout.state, 0o700);
    const journal = path.join(s.layout.state, "trial.json");
    await writeFile(journal, "{", { mode: 0o600 });
    await expect(clear()).rejects.toThrow();
    const previous = { ...identity, sha256: s.oldSha };
    await writeFile(
      journal,
      JSON.stringify({
        fence: s.fence,
        phase: "prepared",
        previous,
        deadline: 1000,
      })
    );
    await expect(clear()).rejects.toThrow("trial is in progress");
    await expect(s.store.read()).rejects.toThrow();
    await writeFile(
      journal,
      JSON.stringify({ fence: s.fence, phase: "deferred" })
    );
    await clear();
    expect(await s.store.read()).toBeNull();
    const saved = (await readdir(s.layout.state)).find((name) =>
      name.startsWith("fence.json.unreadable-")
    );
    expect(await readFile(path.join(s.layout.state, saved!), "utf8")).toBe("{");
    await clear();
  });

  async function startThen(decide: () => Promise<unknown>) {
    s.options.checkpoint = async (phase) => {
      // Startup runs after the starting checkpoint. The candidate acknowledges
      // the PID from inside the fence at the first wait.
      if (phase === "trial") await decide();
    };
    let trialPolls = 0;
    s.options.sleep = async () => {
      if ((await s.journal())?.phase === "starting") await s.ready();
      else if (++trialPolls > 1) s.tick();
    };
    await s.live();
  }

  it("starts with the persisted fence, confirms once and preserves the predecessor inode", async () => {
    s.system.start.mockImplementationOnce(async () => {
      expect(await s.store.read()).toEqual(s.fence);
      expect(await sha256File(s.layout.installed)).toBe(s.target.sha256);
      s.system.pid.mockResolvedValue(12);
    });
    await startThen(async () => {
      // First decision sticks even when the correct acknowledgement is
      // retransmitted and a cancellation follows it.
      await s.confirm();
      await s.confirm();
      await sendTrialSignal(s.layout, s.fence, {
        kind: "reject",
        reason: "reattach_failed",
      });
    });
    expect(await s.journal()).toMatchObject({ phase: "confirmed" });
    expect(await s.store.read()).toBeNull();
    expect(await s.floor()).toMatchObject({
      version: s.target.version,
      sha256: s.target.sha256,
    });
    expect((await lstat(s.previous)).ino).toBe(s.oldInode);
    expect((await lstat(s.helper)).ino).toBe(
      (await lstat(s.layout.installed)).ino
    );
    expect(s.system.stop).toHaveBeenCalledTimes(1);
    await s.boot();
    expect(s.system.stop).toHaveBeenCalledTimes(1);
  });

  it("replaces the retained predecessor only when the next update is confirmed", async () => {
    await startThen(() => s.confirm());
    const first = (await lstat(s.layout.installed)).ino;
    await writeFile(s.candidate, "another signed candidate");
    const nextTarget = {
      ...s.target,
      version: "1.7.30",
      sha256: await sha256File(s.candidate),
    };
    const nextFence = {
      ...s.fence,
      startedAt: s.fence.startedAt + 1,
      target: nextTarget,
    };
    await s.store.write(nextFence);
    await runTrial({
      ...s.options,
      build: s.target,
      checkpoint: async (phase) => {
        if (phase !== "trial") return;
        expect((await lstat(s.previous)).ino).toBe(s.oldInode);
        await sendTrialSignal(s.layout, nextFence, {
          kind: "confirm",
          observed: nextTarget,
        });
      },
      sleep: async () => {
        if ((await s.journal())?.phase === "starting")
          await sendTrialSignal(s.layout, nextFence, {
            kind: "ready",
            pid: await s.system.pid(),
          });
      },
    });
    expect(await s.journal()).toMatchObject({ phase: "confirmed" });
    expect((await lstat(s.previous)).ino).toBe(first);
  });

  it.each([
    ["backup-pinned", "deferred"],
    ["prepared", "deferred"],
    ["stopped", "deferred"],
    ["swap-renamed", "rolled_back"],
    ["swapped", "rolled_back"],
    ["starting", "rolled_back"],
    ["trial", "rolled_back"],
    ["committing", "confirmed"],
    ["previous-published", "confirmed"],
    ["floor-published", "confirmed"],
    ["helper-refreshed", "confirmed"],
    ["confirmed", "confirmed"],
  ])("recovers a crash at %s as %s on boot", async (boundary, expected) => {
    const crash = new Error("power cut");
    s.options.checkpoint = async (phase) => {
      if (phase === boundary) throw crash;
      if (phase === "trial") await s.confirm();
    };
    s.options.sleep = async () => {
      await s.ready();
    };
    await expect(s.live()).rejects.toThrow(crash);
    const starts = s.system.start.mock.calls.length;
    const stops = s.system.stop.mock.calls.length;
    await s.boot();
    await s.boot();
    expect(s.system.start).toHaveBeenCalledTimes(starts);
    expect(s.system.stop).toHaveBeenCalledTimes(stops);
    expect(await s.journal()).toMatchObject({ phase: expected });
    expect(await s.store.read()).toBeNull();
    expect(await sha256File(s.layout.installed)).toBe(
      expected === "confirmed" ? s.target.sha256 : s.oldSha
    );
    expect(await sha256File(s.candidate)).toBe(s.target.sha256);
    expect(await s.suppressed()).toBe(expected === "rolled_back");
    if (expected !== "confirmed")
      expect(await readFile(s.previous, "utf8")).toBe(
        "formerly confirmed predecessor"
      );
  });

  it.each(["restoring", "restored", "suppression-published", "rolled_back"])(
    "recovers failed-start rollback interrupted at %s",
    async (boundary) => {
      const crash = new Error("power cut");
      s.options.checkpoint = async (phase) => {
        if (phase === boundary) throw crash;
      };
      s.system.start.mockRejectedValueOnce(new Error("candidate cannot start"));
      await expect(s.live()).rejects.toThrow(crash);
      await s.boot();
      await s.boot();
      expect(await s.journal()).toMatchObject({
        phase: "rolled_back",
        reason: "boot_failed",
      });
      expect(await s.store.read()).toBeNull();
      expect(await s.suppressed()).toBe(true);
      expect((await lstat(s.layout.installed)).ino).toBe(s.oldInode);
    }
  );

  it("defers when the controller drops before replacement and the same bytes remain staged", async () => {
    s.options.checkpoint = async (phase) => {
      if (phase === "stopped")
        await sendTrialSignal(s.layout, s.fence, { kind: "disconnect" });
    };
    await s.live();
    expect(await s.journal()).toMatchObject({
      phase: "deferred",
      reason: "cancelled",
    });
    expect(await s.store.read()).toBeNull();
    expect(await s.suppressed()).toBe(false);
    expect((await lstat(s.layout.installed)).ino).toBe(s.oldInode);
    expect(await sha256File(s.candidate)).toBe(s.target.sha256);
    expect(s.system.start).toHaveBeenCalledOnce();
  });

  it("leaves the old build installed if stop uses the entire trial window", async () => {
    s.options.checkpoint = async (phase) => {
      if (phase === "stopped") s.tick();
    };
    await s.live();
    expect(await s.journal()).toMatchObject({
      phase: "deferred",
      reason: "cancelled",
    });
    expect((await lstat(s.layout.installed)).ino).toBe(s.oldInode);
    expect(await s.suppressed()).toBe(false);
  });

  it.each([
    ["mismatch", "verify_failed"],
    ["cancel", "reattach_failed"],
    ["lost", "confirm_timeout"],
    ["late", "confirm_timeout"],
  ])("rolls back on %s confirmation", async (trigger, reason) => {
    await startThen(async () => {
      if (trigger === "mismatch") await s.confirm("e".repeat(40));
      if (trigger === "cancel")
        await sendTrialSignal(s.layout, s.fence, {
          kind: "reject",
          reason: "reattach_failed",
        });
      if (trigger === "lost") s.tick();
      if (trigger === "late") {
        s.tick();
        await s.confirm();
      }
    });
    expect(await s.journal()).toMatchObject({ phase: "rolled_back", reason });
    expect(await s.suppressed()).toBe(true);
    expect((await lstat(s.layout.installed)).ino).toBe(s.oldInode);
    expect(await readFile(s.previous, "utf8")).toBe(
      "formerly confirmed predecessor"
    );
    expect(await s.floor()).toMatchObject({ sha256: s.oldSha });
    expect(s.system.stop).toHaveBeenCalledTimes(2);
    expect(s.system.start).toHaveBeenCalledTimes(2);
    await s.confirm();
    await s.live();
    expect(s.system.stop).toHaveBeenCalledTimes(2);
    expect(await s.journal()).toMatchObject({ phase: "rolled_back", reason });
  });

  it("does not commit when the deadline passes while reading confirmation", async () => {
    let submitted = false;
    let deadlineChecks = 0;
    s.options.now = () =>
      !submitted || deadlineChecks++ === 0 ? 1000 : 1000 + RUNNER_TRIAL_MS;
    await startThen(async () => {
      await s.confirm();
      submitted = true;
    });
    expect(await s.journal()).toMatchObject({
      phase: "rolled_back",
      reason: "confirm_timeout",
    });
  });

  it("stops polling when unconfirmed trial time expires", async () => {
    let expired = false;
    let finalPoll = false;
    s.options.checkpoint = async (phase) => {
      if (phase === "trial") {
        s.tick();
        expired = true;
      }
    };
    s.options.sleep = async () => {
      if (!expired) return s.ready();
      expect(finalPoll).toBe(false);
      finalPoll = true;
    };
    await s.live();
    expect(await s.journal()).toMatchObject({
      phase: "rolled_back",
      reason: "confirm_timeout",
    });
  });

  it("persists suppression before publishing rollback or reopening admission", async () => {
    s.system.start.mockRejectedValueOnce(new Error("candidate cannot start"));
    s.options.checkpoint = async (phase) => {
      if (phase !== "rolled_back") return;
      expect(await s.store.read()).toEqual(s.fence);
      expect(await s.suppressed()).toBe(true);
    };
    await s.live();
    expect(await s.store.read()).toBeNull();
  });

  it("does not restart in a loop when both starts fail", async () => {
    s.system.start.mockRejectedValue(new Error("systemd start failed"));
    await s.live();
    await s.live();
    expect(s.system.start).toHaveBeenCalledTimes(2);
    expect(await s.journal()).toMatchObject({
      phase: "rolled_back",
      reason: "boot_failed",
    });
    expect(await s.suppressed()).toBe(true);
    expect(await s.store.read()).toBeNull();
  });

  it("rejects a changed candidate without stopping the old supervisor", async () => {
    await writeFile(s.candidate, "tampered");
    await s.live();
    expect(s.system.stop).not.toHaveBeenCalled();
    expect(await s.journal()).toMatchObject({
      phase: "deferred",
      reason: "verify_failed",
    });
  });

  it("rejects a stage below the confirmed floor", async () => {
    await writeFile(
      path.join(s.layout.state, "floor.json"),
      JSON.stringify({
        version: "1.7.30",
        sha256: "f".repeat(64),
      }),
      { mode: 0o600 }
    );
    await s.live();
    expect(s.system.stop).not.toHaveBeenCalled();
    expect(await s.journal()).toMatchObject({
      phase: "deferred",
      reason: "verify_failed",
    });
  });

  it("refuses a stale helper inode before stopping", async () => {
    await rm(s.helper);
    await writeFile(s.helper, "stale helper", { mode: 0o755 });
    await s.live();
    expect(s.system.stop).not.toHaveBeenCalled();
    expect(await s.journal()).toMatchObject({
      phase: "deferred",
      reason: "verify_failed",
    });
  });

  it("does not open a trial when a different PID claims readiness", async () => {
    s.options.sleep = async () => {
      await sendTrialSignal(s.layout, s.fence, { kind: "ready", pid: 1000 });
      const current = await s.journal();
      if (current?.phase === "trial") throw new Error("Unverified trial");
      if (s.system.pid.mock.calls.length > 4) s.tick();
    };
    await s.live();
    expect(await s.journal()).toMatchObject({
      phase: "rolled_back",
      reason: "boot_failed",
    });
  });

  it("looks up suppression by digest and leaves the prior result intact", async () => {
    s.system.start.mockRejectedValueOnce(new Error("candidate cannot start"));
    await s.live();
    expect(await s.suppressed()).toBe(true);
    expect(await isSuppressed(s.layout, "f".repeat(64), s.options.uid)).toBe(
      false
    );
  });

  it("requires the persisted activating fence", async () => {
    await s.store.write({ ...s.fence, phase: "fenced" });
    await s.live();
    expect(s.system.stop).not.toHaveBeenCalled();
    expect(await s.journal()).toBeNull();
  });
});

describe("systemd supervisor handoff", () => {
  const unit = "dispatch-runner.service";
  const survivors = () => new Set([11, 100]);
  const fixture = (
    policy = "KillMode=process\nExecStop=\nExecStopPost=",
    stopped = "ActiveState=inactive\nMainPID=0"
  ) => {
    const processes = survivors();
    const command = vi.fn(async (...args: string[]) => {
      if (args[0] === "show" && args[1] === "--property=KillMode")
        return policy;
      if (args[0] === "show") return stopped;
      if (args[0] === "stop" && args[1] === unit) {
        if (
          policy === "KillMode=process\nExecStop=\nExecStopPost=" ||
          policy === "KillMode=process"
        )
          processes.delete(11);
        else processes.clear();
        return "";
      }
      throw new Error(`Unexpected systemd operation ${args.join(" ")}`);
    });
    return { processes, command, system: systemdSupervisor(command) };
  };
  it.each(["KillMode=process", "KillMode=process\nExecStop=\nExecStopPost="])(
    "stops only the supervisor and verifies the empty MainPID (%j)",
    async (policy) => {
      const { system, command, processes } = fixture(policy);
      await system.stop();
      expect(processes).toEqual(new Set([100]));
      expect(command.mock.calls).toEqual([
        [
          "show",
          "--property=KillMode",
          "--property=ExecStop",
          "--property=ExecStopPost",
          unit,
        ],
        ["stop", unit],
        ["show", "--property=ActiveState", "--property=MainPID", unit],
      ]);
    }
  );
  it.each([
    "ExecStop=\nExecStopPost=",
    "KillMode=control-group\nExecStop=\nExecStopPost=",
    "KillMode=process\nExecStop=custom hook\nExecStopPost=",
    "KillMode=process\nExecStop=\nExecStopPost=custom hook",
  ])("refuses unsafe stop policy %s", async (policy) => {
    const { system, command, processes } = fixture(policy);
    await expect(system.stop()).rejects.toThrow("cannot preserve hosts");
    expect(command).toHaveBeenCalledOnce();
    expect(processes).toEqual(survivors());
  });
  it.each([
    "ActiveState=inactive\nMainPID=11",
    "ActiveState=activating\nMainPID=0",
  ])(
    "refuses replacement when the supervisor is still active (%s)",
    async (state) => {
      const { system } = fixture(undefined, state);
      await expect(system.stop()).rejects.toThrow("still running");
    }
  );
});
