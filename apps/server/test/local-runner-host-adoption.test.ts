/*
 * Local hosts tracked by the runner child, with real processes: a host the
 * app started (main's in-app launch code) is adopted from its records by a
 * child started after it; the child dies and restarts under an attached
 * host; the child stays down past the 25 s bound; a stale pid record; and
 * the app killed with hosts running. Each proof checks there is still one
 * host and that nothing was killed or rewritten that was not asked for.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DriverEvent } from "../src/agents/acp/driver.js";
import { createAcpRuntime } from "../src/agents/acp/runtime.js";
import { mainLocalHosts } from "./helpers/main-local-hosts.js";
import type { AgentRuntime, RuntimeLaunch } from "../src/agents/runtime.js";
import { readLocalSession } from "../src/runners/local.js";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import {
  startTestLocalRunner,
  type TestLocalRunner,
} from "./helpers/local-runner-child.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const mainTs = path.resolve(here, "../src/main.ts");
const fakeAgent = path.join(repoRoot, "e2e/fixtures/fake-acp-agent.mjs");

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

type Seen = { agentId: string; event: DriverEvent; seq: number };

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
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

let stateRoot: string;
let cwd: string;
const cleanups: Array<() => void | Promise<void>> = [];

beforeAll(() => {
  stateRoot = mkdtempSync("/tmp/dispatch-adopt-");
  cwd = mkdtempSync(path.join(os.tmpdir(), "adopt-cwd-"));
  process.env.DISPATCH_AGENT_HOST_COMMAND = JSON.stringify([
    process.execPath.includes("bun") ? process.execPath : "bun",
    mainTs,
    "agent-host",
  ]);
});

afterEach(async () => {
  for (const run of cleanups.splice(0).reverse()) await run();
});

afterAll(() => {
  delete process.env.DISPATCH_AGENT_HOST_COMMAND;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
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

/** Start a host with main's in-app launch code, as an earlier app did. */
async function launchInApp(agentId: string) {
  const local = mainLocalHosts(stateRoot);
  const { bins, cwd: dir, env, pathPrefix, ...launch } = launchFor(agentId);
  await local.requestSession(
    { kind: "launch", agentId, launch: { ...launch, agentId } as never },
    {
      cwd: dir,
      env,
      pathPrefix,
      bins: { ...bins, adapter: { bin: fakeAgent } },
    }
  );
  const pidFile = path.join(stateRoot, agentId, "host.pid");
  await until(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  cleanups.push(async () => {
    await local.requestSession({ kind: "stop", agentId, force: true });
  });
  return pid;
}

function runtimeWith(child: () => TestLocalRunner["session"] | undefined) {
  const seen: Seen[] = [];
  const runtime: AgentRuntime = createAcpRuntime({
    config: {
      agentStateRoot: stateRoot,
      agentRuntime: "acp",
      acpAdapter: { bin: fakeAgent },
      dispatchBinDir: path.join(repoRoot, "bin"),
    },
    logger,
    hostSeq: async () => ({ seq: 0, journalId: null }),
    syncJournal: async () => {},
    localRunner: child,
  });
  runtime.onEvent((agentId, event, seq) => {
    seen.push({ agentId, event, seq });
  });
  return { runtime, seen };
}

function echoed(seen: Seen[], agentId: string, text: string) {
  return seen.filter(
    ({ agentId: id, event }) =>
      id === agentId &&
      event.type === "update" &&
      event.update.sessionUpdate === "agent_message_chunk" &&
      event.update.content.type === "text" &&
      event.update.content.text.includes(text)
  ).length;
}

function child(options?: Parameters<typeof startTestLocalRunner>[1]) {
  const runner = startTestLocalRunner(stateRoot, options);
  cleanups.push(() => runner.stop());
  return runner;
}

describe("local hosts tracked by the runner child", () => {
  it("adopts a host the app started before the child existed: attach-only, one host", async () => {
    const agentId = "agt_adopt_live";
    const dir = path.join(stateRoot, agentId);
    const pid = await launchInApp(agentId);
    const ownership = readFileSync(path.join(dir, "ownership"), "utf8");

    const runner = child();
    await runner.ready();
    const { runtime, seen } = runtimeWith(() => runner.session);
    expect(await runtime.listHosted()).toContain(agentId);
    expect(await runtime.isAlive(agentId)).toBe(true);
    expect(await runtime.attach(agentId)).toBe(true);
    await runtime.prompt(agentId, "after adoption").settled;
    await until(() => echoed(seen, agentId, "after adoption") > 0);

    expect(hostProcesses(dir)).toEqual([pid]);
    // Adoption rewrote nothing the app or an older build reads.
    expect(readFileSync(path.join(dir, "ownership"), "utf8")).toBe(ownership);
    expect(readFileSync(path.join(dir, "host.pid"), "utf8").trim()).toBe(
      String(pid)
    );
    // The log tail reads through the child in main's wording.
    const log = readFileSync(path.join(dir, "host.log"), "utf8").trim();
    const tail = log.split("\n").slice(-20).join("\n");
    expect(await runtime.readLogTail(agentId)).toBe(
      tail ? `\n\nHost log (last 20 lines):\n${tail}` : ""
    );
  }, 60_000);

  it("child killed under an attached host: the host keeps running, the restarted child re-attaches, queued input is delivered once", async () => {
    const agentId = "agt_child_killed";
    const dir = path.join(stateRoot, agentId);
    const runner = child({ backoffMs: 1_000 });
    await runner.ready();
    const { runtime, seen } = runtimeWith(() => runner.session);
    await runtime.launch(launchFor(agentId));
    const pid = hostProcesses(dir)[0]!;
    cleanups.push(() => runtime.stop(agentId, true));
    await runtime.prompt(agentId, "before kill").settled;

    const first = runner.pids.at(-1)!;
    const killedAt = Date.now();
    process.kill(first, "SIGKILL");
    await until(() => !pidAlive(first));
    // Sent while the child is down: queued, not failed.
    const queued = runtime.prompt(agentId, "while down");
    let accepted = false;
    void queued.accepted.then(() => (accepted = true));
    await runner.ready(1);
    const back = Date.now();
    await queued.settled;
    await until(() => echoed(seen, agentId, "while down") > 0);
    const delivered = Date.now();
    expect(accepted).toBe(true);
    expect(hostProcesses(dir)).toEqual([pid]);
    expect(runner.pids.length).toBe(2);
    // The prompt reached the engine exactly once.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      seen.filter(
        ({ agentId: id, event }) =>
          id === agentId &&
          event.type === "turn" &&
          event.state === "started" &&
          event.text === "while down"
      )
    ).toHaveLength(1);
    console.info(
      `child SIGKILL → new child ready ${back - killedAt} ms, queued prompt delivered ${delivered - back} ms later`
    );
  }, 60_000);

  it("child down past the 25 s bound: the agent is not recorded as exited, its prompt is kept", async () => {
    const agentId = "agt_child_down";
    const dir = path.join(stateRoot, agentId);
    // The child restarts 32 s after it dies.
    const runner = child({ backoffMs: 32_000 });
    await runner.ready();
    const { runtime, seen } = runtimeWith(() => runner.session);
    await runtime.launch(launchFor(agentId));
    const pid = hostProcesses(dir)[0]!;
    cleanups.push(() => runtime.stop(agentId, true));

    const killedAt = Date.now();
    process.kill(runner.pids[0]!, "SIGKILL");
    await until(() => !pidAlive(runner.pids[0]!));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const queued = runtime.prompt(agentId, "kept across the outage");
    await runner.ready(1);
    const down = Date.now() - killedAt;
    await queued.accepted;
    await queued.settled;
    await until(() => echoed(seen, agentId, "kept across the outage") > 0);
    expect(down).toBeGreaterThan(30_000);
    expect(seen.some(({ event }) => event.type === "exit")).toBe(false);
    expect(hostProcesses(dir)).toEqual([pid]);
    console.info(`child down ${down} ms; no exit recorded; prompt delivered`);
  }, 90_000);

  it("a stale pid record is reported, never attached to as live, and swept without signalling the process it names", async () => {
    const agentId = "agt_stale_pid";
    const dir = path.join(stateRoot, agentId);
    mkdirSync(dir, { recursive: true });
    const foreign = spawn("sleep", ["300"], { stdio: "ignore" });
    cleanups.push(() => {
      foreign.kill("SIGKILL");
    });
    await until(() => !!foreign.pid);
    writeFileSync(path.join(dir, "host.pid"), `${foreign.pid}\n`);
    writeFileSync(
      path.join(dir, "ownership"),
      "DISPATCH_OWNED_00000000000000000000000000000000=1"
    );
    const runner = child();
    await runner.ready();
    const { runtime } = runtimeWith(() => runner.session);
    const session = sessionFromWire(agentId);
    expect(
      await readLocalSession(runner.session, "session.alive", { session })
    ).toEqual({ state: "stale" });
    expect(await runtime.listHosted()).not.toContain(agentId);
    expect(await runtime.isAlive(agentId)).toBe(false);
    expect(await runtime.attach(agentId)).toBe(false);
    // Longer than the core's sweep interval: the child, the only spawner,
    // cleans the records of a host that is not running (as main's stop
    // removes them), and the process they named is never signalled.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(pidAlive(foreign.pid!)).toBe(true);
    expect(existsSync(path.join(dir, "host.pid"))).toBe(false);
    expect(existsSync(path.join(dir, "ownership"))).toBe(false);
  }, 30_000);

  it("app killed with hosts running: the host survives, the child exits by its lifeline, the next app's child adopts it", async () => {
    const agentId = "agt_app_killed";
    const dir = path.join(stateRoot, agentId);
    const script = path.join(stateRoot, "app.ts");
    writeFileSync(
      script,
      `
      import {startTestLocalRunner} from ${JSON.stringify(pathToFileURL(path.join(here, "helpers/local-runner-child.ts")).href)};
      import {createAcpRuntime} from ${JSON.stringify(pathToFileURL(path.join(here, "../src/agents/acp/runtime.ts")).href)};
      const runner = startTestLocalRunner(${JSON.stringify(stateRoot)});
      await runner.ready();
      const runtime = createAcpRuntime({
        config: ${JSON.stringify({ agentStateRoot: stateRoot, acpAdapter: { bin: fakeAgent } })},
        logger: {info(){}, warn(){}, debug(){}, error(){}},
        hostSeq: async () => ({seq: 0, journalId: null}), syncJournal: async () => {},
        localRunner: () => runner.session,
      });
      await runtime.launch(${JSON.stringify(launchFor(agentId))});
      await runtime.prompt(${JSON.stringify(agentId)}, "first app").settled;
      console.log(JSON.stringify({child: runner.pids[0]}));
      setInterval(() => {}, 1e9);
    `
    );
    const app = spawn("bun", [script], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env },
    });
    cleanups.push(() => {
      app.kill("SIGKILL");
    });
    const line = await new Promise<string>((resolve, reject) => {
      let out = "";
      app.stdout!.on("data", (chunk) => {
        out += chunk;
        if (out.includes("\n")) resolve(out.split("\n")[0]!);
      });
      app.once("exit", () => reject(new Error("app exited early")));
    });
    const { child: firstChild } = JSON.parse(line) as { child: number };
    const [pid] = hostProcesses(dir);
    expect(pid).toBeGreaterThan(0);
    cleanups.push(async () => {
      await mainLocalHosts(stateRoot).requestSession({
        kind: "stop",
        agentId,
        force: true,
      });
    });

    const killedAt = Date.now();
    app.kill("SIGKILL");
    await until(() => !pidAlive(firstChild), 5_000);
    const childGone = Date.now() - killedAt;
    expect(pidAlive(pid!)).toBe(true);

    const runner = child();
    await runner.ready();
    const { runtime, seen } = runtimeWith(() => runner.session);
    expect(await runtime.listHosted()).toContain(agentId);
    expect(await runtime.attach(agentId)).toBe(true);
    await runtime.prompt(agentId, "next app").settled;
    await until(() => echoed(seen, agentId, "next app") > 0);
    expect(hostProcesses(dir)).toEqual([pid]);
    console.info(`app SIGKILL → its child gone in ${childGone} ms`);
  }, 60_000);
});
