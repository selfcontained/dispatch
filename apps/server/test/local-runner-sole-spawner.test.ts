/*
 * The local runner child as the only spawner and stopper of local hosts,
 * with real processes: the child killed right after it spawned a host and
 * before it answered; the child killed mid-stop; a stop racing a launch for
 * one session; a second app's child on the same root; and a host this build
 * started stopped by main's own in-app code (rollback). Each proof checks
 * there is exactly the expected number of hosts and the records match, and
 * logs its timings.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  pathFromWire,
  sessionFromWire,
  type Req,
} from "@dispatch/runner-protocol/contract";
import { createAcpRuntime } from "../src/agents/acp/runtime.js";
import type { RuntimeLaunch } from "../src/agents/runtime.js";
import { requestLocalSession } from "../src/runners/local.js";
import { mainLocalHosts } from "./helpers/main-local-hosts.js";
import {
  startTestLocalRunner,
  type TestLocalRunner,
} from "./helpers/local-runner-child.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const mainTs = path.resolve(here, "../src/main.ts");
const fakeAgent = path.join(repoRoot, "e2e/fixtures/fake-acp-agent.mjs");
const bun = process.execPath.includes("bun") ? process.execPath : "bun";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => logger,
  level: "silent",
} as unknown as Parameters<typeof createAcpRuntime>[0]["logger"];

const until = async (check: () => boolean | Promise<boolean>, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Processes whose command line ends like the host's for `dir`. */
function hostProcesses(dir: string): number[] {
  const out = execFileSync("/bin/ps", ["-axo", "pid=,args="], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((line) => line.trim().endsWith(`agent-host --state ${dir}`))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

/** Timings, printed once per proof for the report. */
const timings: Record<string, Record<string, number>> = {};
const mark = (proof: string, step: string, since: number) => {
  (timings[proof] ??= {})[step] = Math.round(performance.now() - since);
};

let root: string;
let cwd: string;
const cleanups: Array<() => void | Promise<void>> = [];
const previousCommand = process.env.DISPATCH_AGENT_HOST_COMMAND;

/**
 * A host that waits before it starts: its pid is written `delay` seconds
 * after the spawn, the window a runner can die in. The command line still
 * ends with `agent-host --state <dir>` throughout, as main identifies hosts.
 */
function hostCommandWithDelay(delay: number) {
  return [
    "/bin/sh",
    "-c",
    `sleep ${delay}; exec ${JSON.stringify(bun)} ${JSON.stringify(mainTs)} agent-host "$@"`,
    "agent-host",
  ];
}

beforeAll(() => {
  root = mkdtempSync("/tmp/dispatch-spawner-");
  cwd = mkdtempSync(path.join(os.tmpdir(), "spawner-cwd-"));
});

afterEach(async () => {
  for (const run of cleanups.splice(0).reverse()) await run();
});

afterAll(() => {
  // Any host these tests started and did not stop is a failure; never leave
  // one running.
  const leftovers = execFileSync("/bin/ps", ["-axo", "pid=,args="], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.includes(`agent-host --state ${root}/`))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
  for (const pid of leftovers) process.kill(pid, "SIGKILL");
  if (previousCommand === undefined)
    delete process.env.DISPATCH_AGENT_HOST_COMMAND;
  else process.env.DISPATCH_AGENT_HOST_COMMAND = previousCommand;
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  console.log(`sole-spawner timings (ms): ${JSON.stringify(timings)}`);
  expect(leftovers).toEqual([]);
});

function launchFor(agentId: string): RuntimeLaunch {
  return {
    agentId,
    cwd,
    engine: "claude",
    model: null,
    bins: { claudeBin: "claude", codexBin: null },
    systemPrompt: "Be brief.",
    mcp: { url: "http://127.0.0.1:1/api/mcp/agt_1", token: "tok" },
    env: {},
    pathPrefix: [],
    resumeSessionId: null,
  };
}

/** The contract request a runtime sends for `launchFor(agentId)`. */
function requestFor(agentId: string, launchId: string): Req<"session.launch"> {
  return {
    session: sessionFromWire(agentId),
    launchId,
    engine: "claude",
    model: null,
    effort: null,
    access: "full",
    resume: null,
    systemText: "Be brief.",
    firstText: null,
    overflowNotice: null,
    env: {},
    mcp: [{ name: "dispatch", url: "http://127.0.0.1:1/x", token: "tok" }],
    owner: null,
    directory: pathFromWire(cwd),
    programs: {
      claude: { path: "claude" },
      codex: null,
      adapter: { path: fakeAgent },
    },
    pathPrefix: [],
  };
}

/** A fresh state root and its child, stopped (hosts too) after the test. */
function childFor(name: string, hostCommand?: string[]) {
  const stateRoot = path.join(root, name);
  process.env.DISPATCH_AGENT_HOST_COMMAND = JSON.stringify(
    hostCommand ?? [bun, mainTs, "agent-host"]
  );
  const runner = startTestLocalRunner(stateRoot, { backoffMs: 50 });
  cleanups.push(() => runner.stop().catch(() => {}));
  return { stateRoot, runner };
}

/** Stop every host under `stateRoot` through a child, then check none is left. */
async function stopAll(runner: TestLocalRunner, ...agentIds: string[]) {
  for (const agentId of agentIds)
    await runner.session
      .call(
        "session.stop",
        { session: sessionFromWire(agentId), force: true },
        { timeoutMs: null }
      )
      .catch(() => {});
}

describe("the local runner child is the only spawner", () => {
  it("child killed after it spawned a host and before it answered: the retried launch adopts that host; one host, one answer", async () => {
    const proof = "kill-after-spawn";
    const { stateRoot, runner } = childFor(
      "kill-spawn",
      hostCommandWithDelay(2)
    );
    const agentId = "agt_kill_spawn";
    const dir = path.join(stateRoot, agentId);
    cleanups.push(() => stopAll(runner, agentId));
    await runner.ready();
    const firstChild = runner.current()!.pid;
    const t0 = performance.now();
    let answers = 0;
    const launch = requestLocalSession(
      runner.session,
      "session.launch",
      requestFor(agentId, "launch-1")
    ).then((value) => {
      answers += 1;
      return value;
    });
    // Spawned: the marker is recorded and the launch record says so, but the
    // host has not written its pid, so the child has not answered.
    await until(
      () =>
        existsSync(path.join(dir, "ownership")) &&
        readFileSync(
          path.join(stateRoot, ".launches", `${agentId}.json`),
          "utf8"
        ).includes("spawning") &&
        hostProcesses(dir).length === 1
    );
    expect(existsSync(path.join(dir, "host.pid"))).toBe(false);
    expect(answers).toBe(0);
    mark(proof, "spawned", t0);
    process.kill(firstChild, "SIGKILL");
    const killed = performance.now();
    await runner.ready(1);
    mark(proof, "childBack", killed);
    await launch;
    mark(proof, "answeredAfterKill", killed);
    expect(answers).toBe(1);
    expect(runner.pids.length).toBe(2);
    const hosts = hostProcesses(dir);
    expect(hosts).toHaveLength(1);
    expect(Number(readFileSync(path.join(dir, "host.pid"), "utf8"))).toBe(
      hosts[0]
    );
    // The record names the marker the running host carries.
    const marker = readFileSync(path.join(dir, "ownership"), "utf8").trim();
    expect(
      execFileSync(
        "/bin/ps",
        ["eww", "-p", String(hosts[0]), "-o", "command="],
        {
          encoding: "utf8",
        }
      ).includes(marker)
    ).toBe(true);
    // A late repeat of the same launch answers for the same host.
    await requestLocalSession(
      runner.session,
      "session.launch",
      requestFor(agentId, "launch-1")
    );
    expect(hostProcesses(dir)).toEqual(hosts);
    // Another launch while it runs is refused: never a second host.
    await expect(
      requestLocalSession(
        runner.session,
        "session.launch",
        requestFor(agentId, "launch-2")
      )
    ).rejects.toMatchObject({ code: "conflict" });
    mark(proof, "total", t0);
  }, 90_000);

  it("child killed mid-stop: the stop is sent again and completes; no host or record is left half-stopped", async () => {
    const proof = "kill-mid-stop";
    const { stateRoot, runner } = childFor("kill-stop");
    const agentId = "agt_kill_stop";
    const dir = path.join(stateRoot, agentId);
    cleanups.push(() => stopAll(runner, agentId));
    await runner.ready();
    await requestLocalSession(
      runner.session,
      "session.launch",
      requestFor(agentId, "launch-1")
    );
    const [host] = hostProcesses(dir);
    expect(host).toBeGreaterThan(0);
    const t0 = performance.now();
    let answers = 0;
    // Not forced: the child waits main's grace for the host to exit by
    // itself (it will not: nobody asked it to), then SIGTERM, then SIGKILL.
    const stop = requestLocalSession(runner.session, "session.stop", {
      session: sessionFromWire(agentId),
      force: false,
    }).then(() => (answers += 1));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(pidAlive(host!)).toBe(true);
    process.kill(runner.current()!.pid, "SIGKILL");
    const killed = performance.now();
    mark(proof, "killedAt", t0);
    await stop;
    mark(proof, "stoppedAfterKill", killed);
    expect(answers).toBe(1);
    expect(runner.pids.length).toBe(2);
    expect(pidAlive(host!)).toBe(false);
    expect(hostProcesses(dir)).toEqual([]);
    for (const name of ["ownership", "host.pid", "host.sock"])
      expect(existsSync(path.join(dir, name))).toBe(false);
    // The session can start again.
    await requestLocalSession(
      runner.session,
      "session.launch",
      requestFor(agentId, "launch-2")
    );
    expect(hostProcesses(dir)).toHaveLength(1);
    mark(proof, "total", t0);
  }, 90_000);

  it("a stop racing a launch for one session runs after it, under the session lock", async () => {
    const proof = "stop-races-launch";
    const { stateRoot, runner } = childFor("race", hostCommandWithDelay(1));
    const agentId = "agt_race";
    const dir = path.join(stateRoot, agentId);
    cleanups.push(() => stopAll(runner, agentId));
    await runner.ready();
    const t0 = performance.now();
    const order: string[] = [];
    const launch = requestLocalSession(
      runner.session,
      "session.launch",
      requestFor(agentId, "launch-1")
    ).then(() => order.push("launch"));
    await until(() => existsSync(path.join(dir, "ownership")));
    const stop = requestLocalSession(runner.session, "session.stop", {
      session: sessionFromWire(agentId),
      force: true,
    }).then(() => order.push("stop"));
    await Promise.all([launch, stop]);
    mark(proof, "both", t0);
    expect(order).toEqual(["launch", "stop"]);
    expect(hostProcesses(dir)).toEqual([]);
    expect(existsSync(path.join(dir, "ownership"))).toBe(false);

    // The other order: the launch waits for the stop, then starts one host.
    const t1 = performance.now();
    await requestLocalSession(
      runner.session,
      "session.launch",
      requestFor(agentId, "launch-2")
    );
    const [first] = hostProcesses(dir);
    const order2: string[] = [];
    const stop2 = requestLocalSession(runner.session, "session.stop", {
      session: sessionFromWire(agentId),
      force: true,
      expectedLaunchId: "launch-2",
    }).then(() => order2.push("stop"));
    const launch2 = requestLocalSession(
      runner.session,
      "session.launch",
      requestFor(agentId, "launch-3")
    ).then(() => order2.push("launch"));
    await Promise.all([stop2, launch2]);
    mark(proof, "stopThenLaunch", t1);
    expect(order2).toEqual(["stop", "launch"]);
    expect(pidAlive(first!)).toBe(false);
    expect(hostProcesses(dir)).toHaveLength(1);
    const newest = hostProcesses(dir);
    await requestLocalSession(runner.session, "session.stop", {
      session: sessionFromWire(agentId),
      force: true,
      expectedLaunchId: "launch-2",
    });
    expect(hostProcesses(dir)).toEqual(newest);
  }, 90_000);

  it("a second app's child on the same root is refused; the first child and its host are untouched", async () => {
    const proof = "second-child";
    const { stateRoot, runner } = childFor("second");
    const agentId = "agt_second";
    const dir = path.join(stateRoot, agentId);
    cleanups.push(() => stopAll(runner, agentId));
    await runner.ready();
    await requestLocalSession(
      runner.session,
      "session.launch",
      requestFor(agentId, "launch-1")
    );
    const [host] = hostProcesses(dir);
    const script = path.join(root, "second-app.ts");
    writeFileSync(
      script,
      `
      import {startTestLocalRunner} from ${JSON.stringify(pathToFileURL(path.join(here, "helpers/local-runner-child.ts")).href)};
      const runner = startTestLocalRunner(${JSON.stringify(stateRoot)}, {backoffMs: 60000});
      setTimeout(async () => { console.log(JSON.stringify({pids: runner.pids})); await runner.stop(); process.exit(0); }, 6000);
      `
    );
    const t0 = performance.now();
    const app = spawn(bun, [script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let out = "";
    let err = "";
    app.stdout!.on("data", (chunk) => (out += chunk));
    app.stderr!.on("data", (chunk) => (err += chunk));
    // The refused child says why on stderr; the app only sees no ready.
    cleanups.push(() => {
      if (app.exitCode === null) app.kill("SIGKILL");
    });
    await new Promise((resolve) => app.once("exit", resolve));
    mark(proof, "secondAppDone", t0);
    expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({ pids: [] });
    void err;
    expect(runner.pids.length).toBe(1);
    expect(hostProcesses(dir)).toEqual([host]);
    const { state } = await runner.session.call("session.alive", {
      session: sessionFromWire(agentId),
    });
    expect(state).toBe("live");
  }, 60_000);

  it("a launch into a missing directory fails as main's did and leaves no record", async () => {
    const { stateRoot, runner } = childFor("missing-dir");
    const agentId = "agt_missing_dir";
    await runner.ready();
    await expect(
      requestLocalSession(runner.session, "session.launch", {
        ...requestFor(agentId, "launch-1"),
        directory: pathFromWire(path.join(cwd, "gone")),
      })
    ).rejects.toThrow("the agent host exited before it answered");
    expect(existsSync(path.join(stateRoot, agentId, "ownership"))).toBe(false);
    expect(hostProcesses(path.join(stateRoot, agentId))).toEqual([]);
  }, 60_000);

  it("rollback: main's in-app code stops a host this build's child started", async () => {
    const proof = "rollback-stop";
    const { stateRoot, runner } = childFor("rollback");
    const agentId = "agt_rollback";
    const dir = path.join(stateRoot, agentId);
    await runner.ready();
    const runtime = createAcpRuntime({
      config: {
        agentStateRoot: stateRoot,
        agentRuntime: "acp",
        acpAdapter: { bin: fakeAgent },
        dispatchBinDir: path.join(repoRoot, "bin"),
      },
      logger,
      hostSeq: async () => ({ seq: 0, journalId: null }),
      syncJournal: async () => {},
      localRunner: () => runner.session,
    });
    await runtime.launch(launchFor(agentId));
    const [host] = hostProcesses(dir);
    expect(host).toBeGreaterThan(0);
    await runner.stop();
    const t0 = performance.now();
    await mainLocalHosts(stateRoot).requestSession({
      kind: "stop",
      agentId,
      force: true,
    });
    mark(proof, "mainStop", t0);
    expect(pidAlive(host!)).toBe(false);
    expect(hostProcesses(dir)).toEqual([]);
  }, 60_000);
});
