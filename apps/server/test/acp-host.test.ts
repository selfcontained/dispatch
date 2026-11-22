/**
 * The agent host end to end: a real `dispatch agent-host` process (bun
 * running src/main.ts) driving the fake ACP agent from e2e/fixtures, with
 * the server-side AcpRuntime on the other end of its socket. Covers what
 * the design promises and unit tests cannot: a host that outlives its
 * client, replay from a sequence number, and a clean stop.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { Duplex } from "node:stream";
import os from "node:os";
import net from "node:net";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { rootCertificates } from "node:tls";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  encodeMessage,
  HOST_FILES,
  ndjsonDecoder,
  parseClientMessage,
  type HostLaunch,
  type ClientMessage,
  type HostMessage,
} from "../src/agents/acp/host-protocol.js";
import { embeddedBuild } from "../src/agents/build-identity.js";
import type { DriverEvent } from "../src/agents/acp/driver.js";
import { createAcpRuntime } from "../src/agents/acp/runtime.js";
import { preparePersonaContext } from "../src/agents/acp/persona-context.js";
import { HostClient } from "../src/agents/acp/host-client.js";
import { createLocalRunner } from "../src/agents/local-runner.js";
import { RunnerUnavailable } from "../src/agents/remote/service.js";
import { RunnerUpdateHolds } from "../src/agents/remote/update-hold.js";
import { buildSystemPrompt } from "../src/agents/acp/system-prompt.js";
import type { AgentRuntime, RuntimeLaunch } from "../src/agents/runtime.js";

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

function runtimeWith(
  stateRoot: string,
  hostSeq: () => number,
  journalId: string | null = null,
  adapter: { bin: string; args?: string[] } | null = { bin: fakeAgent },
  overrides?: Partial<Parameters<typeof createAcpRuntime>[0]>
): {
  runtime: AgentRuntime;
  seen: Seen[];
  synced: Array<{ journalId: string | null; reset: boolean }>;
} {
  const seen: Seen[] = [];
  const synced: Array<{ journalId: string | null; reset: boolean }> = [];
  const runtime = createAcpRuntime({
    config: {
      agentStateRoot: stateRoot,
      agentRuntime: "acp",
      acpAdapter: adapter ?? undefined,
      dispatchBinDir: path.join(repoRoot, "bin"),
    },
    logger,
    hostSeq: async () => ({ seq: hostSeq(), journalId }),
    syncJournal: async (_agentId, id, reset) => {
      synced.push({ journalId: id, reset });
    },
    ...overrides,
  });
  runtime.onEvent((agentId, event, seq) => {
    seen.push({ agentId, event, seq });
  });
  return { runtime, seen, synced };
}

/** A launch file for a host started by hand, with the adapter the runtime would add. */
function hostLaunchFor(agentId: string, cwd: string): HostLaunch {
  const launch = launchFor(agentId, cwd);
  return { ...launch, bins: { ...launch.bins, adapter: { bin: fakeAgent } } };
}

function launchFor(agentId: string, cwd: string): RuntimeLaunch {
  return {
    agentId,
    cwd,
    engine: "claude",
    model: null,
    bins: {
      claudeBin: "claude",
      codexBin: null,
    },
    systemPrompt: "Be brief.",
    mcp: { url: "http://127.0.0.1:1/api/mcp/agt_1", token: "tok" },
    env: {},
    pathPrefix: [],
    resumeSessionId: null,
  };
}

async function expectEcho(
  runtime: AgentRuntime,
  seen: Seen[],
  agentId: string,
  text: string
) {
  const start = seen.length;
  const turn = runtime.prompt(agentId, text);
  await turn.accepted;
  await turn.settled;
  await until(() =>
    seen
      .slice(start)
      .some(
        ({ agentId: id, event }) =>
          id === agentId &&
          event.type === "update" &&
          event.update.sessionUpdate === "agent_message_chunk" &&
          event.update.content.type === "text" &&
          event.update.content.text.includes(text)
      )
  );
}

const until = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("agent host", () => {
  let stateRoot: string;
  let cwd: string;
  const agentId = "agt_host_test_1";

  beforeAll(() => {
    // Keep the socket path within macOS’s Unix socket path limit.
    stateRoot = mkdtempSync("/tmp/dispatch-host-state-");
    cwd = mkdtempSync(path.join(os.tmpdir(), "unrelated-user-repo-"));
    execFileSync("git", ["init", "-q", cwd]);
    writeFileSync(path.join(cwd, "user-notes.txt"), "preserve user work\n");
    process.env.DISPATCH_AGENT_HOST_COMMAND = JSON.stringify([
      process.execPath.includes("bun") ? process.execPath : "bun",
      mainTs,
      "agent-host",
    ]);
  });

  afterAll(async () => {
    // Preserve the owned state until all hosts are stopped, even on assertion failure.
    const { runtime } = runtimeWith(stateRoot, () => 0);
    for (const id of await runtime.listHosted()) await runtime.stop(id, true);
    delete process.env.DISPATCH_AGENT_HOST_COMMAND;
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("uses native ACP in a checkout whose dotenv and launch env specify an override", async () => {
    const id = "agt_checkout_dotenv";
    const checkout = path.join(cwd, "checkout");
    mkdirSync(checkout);
    const override = JSON.stringify([fakeAgent]);
    writeFileSync(
      path.join(checkout, ".env"),
      `DISPATCH_ACP_ADAPTER_COMMAND='${override}'\n`
    );
    // Stand in for the installed OpenCode CLI. The fixture reports OpenCode
    // only when the native launch path passes the "acp" subcommand.
    const { runtime, seen } = runtimeWith(stateRoot, () => 0, null, null);
    try {
      const session = await runtime.launch({
        ...launchFor(id, checkout),
        engine: "opencode",
        bins: { claudeBin: "", codexBin: null, opencodeBin: fakeAgent },
        env: { DISPATCH_ACP_ADAPTER_COMMAND: override },
      });
      expect(session.sessionId).toMatch(/^fake_opencode_/);
      await until(() =>
        seen.some(
          ({ event }) =>
            event.type === "config" && event.catalogSource === "engine"
        )
      );
    } finally {
      await runtime.stop(id, true);
    }
  }, 30_000);

  it.each(["server startup", "direct config import"])(
    "ignores dotenv's adapter during %s",
    (mode) => {
      const configUrl = pathToFileURL(
        path.resolve(here, "../src/config.ts")
      ).href;
      const startupUrl = pathToFileURL(
        path.resolve(here, "../src/startup/acp-adapter.ts")
      ).href;
      const dotenv = path.join(cwd, "server.env");
      writeFileSync(
        dotenv,
        `DISPATCH_ACP_ADAPTER_COMMAND='${JSON.stringify([fakeAgent])}'\n`
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_URL: "postgres://unused",
        DISPATCH_HOST: "127.0.0.1",
        DOTENV_CONFIG_PATH: dotenv,
      };
      delete env.DISPATCH_ACP_ADAPTER_COMMAND;
      const result = execFileSync(
        "bun",
        [
          "--no-env-file",
          "-e",
          `const { captureStartupAcpAdapter } = await import(${JSON.stringify(startupUrl)});
         if (${mode === "server startup"}) captureStartupAcpAdapter();
         const { loadConfig } = await import(${JSON.stringify(configUrl)});
         console.log(JSON.stringify([!!process.env.DISPATCH_ACP_ADAPTER_COMMAND, loadConfig().acpAdapter ?? null]));`,
        ],
        { cwd, env, encoding: "utf8" }
      );
      expect(JSON.parse(result)).toEqual([true, null]);
    }
  );

  it("uses the adapter exported before server startup", async () => {
    const id = "agt_server_adapter";
    const configUrl = pathToFileURL(
      path.resolve(here, "../src/config.ts")
    ).href;
    const startupUrl = pathToFileURL(
      path.resolve(here, "../src/startup/acp-adapter.ts")
    ).href;
    const result = execFileSync(
      "bun",
      [
        "--no-env-file",
        "-e",
        `const { captureStartupAcpAdapter } = await import(${JSON.stringify(startupUrl)});
         captureStartupAcpAdapter();
         const { loadConfig } = await import(${JSON.stringify(configUrl)});
         console.log(JSON.stringify(loadConfig().acpAdapter));`,
      ],
      {
        cwd,
        env: {
          ...process.env,
          DATABASE_URL: "postgres://unused",
          DISPATCH_ACP_ADAPTER_COMMAND: JSON.stringify([fakeAgent]),
        },
        encoding: "utf8",
      }
    );
    const { runtime, seen } = runtimeWith(
      stateRoot,
      () => 0,
      null,
      JSON.parse(result)
    );
    try {
      const session = await runtime.launch(launchFor(id, cwd));
      expect(session.sessionId).toMatch(/^fake_claude_/);
      await until(() =>
        seen.some(
          ({ event }) =>
            event.type === "config" && event.catalogSource === "override"
        )
      );
    } finally {
      await runtime.stop(id, true);
    }
  }, 30_000);

  it("stops an idle orphan without replay and resumes the same session for the next prompt", async () => {
    const id = "agt_recovery_idle";
    const first = runtimeWith(stateRoot, () => 0);
    const session = await first.runtime.launch(launchFor(id, cwd));
    await expectEcho(first.runtime, first.seen, id, "before update");
    await until(() => !first.runtime.isBusy(id));
    const probation = runtimeWith(stateRoot, () => 0);
    try {
      expect(await probation.runtime.listHosted()).toContain(id);
      expect(await probation.runtime.stopIdleHostForRecovery!(id)).toBe(true);
      expect(await probation.runtime.listHosted()).not.toContain(id);
      expect(probation.seen).toEqual([]);
      const next = await probation.runtime.launch({
        ...launchFor(id, cwd),
        resumeSessionId: session.sessionId,
      });
      expect(next.sessionId).toBe(session.sessionId);
      expect(next.resumed).toBe(true);
      await expectEcho(probation.runtime, probation.seen, id, "after update");
    } finally {
      await probation.runtime.stop(id, true);
      await first.runtime.stop(id, true);
    }
  }, 30_000);

  it("leaves an orphan host with an unsettled turn running", async () => {
    const id = "agt_recovery_busy";
    const first = runtimeWith(stateRoot, () => 0);
    await first.runtime.launch(launchFor(id, cwd));
    const active = first.runtime.prompt(id, "sleep:60000");
    void active.settled.catch(() => {});
    try {
      await active.accepted;
      const probation = runtimeWith(stateRoot, () => 0);
      expect(await probation.runtime.stopIdleHostForRecovery!(id)).toBe(false);
      expect(await probation.runtime.listHosted()).toContain(id);
      expect(probation.seen).toEqual([]);
    } finally {
      await first.runtime.stop(id, true);
    }
  }, 30_000);

  it("refuses an idle-only shutdown mid-turn, finishes the turn, then exits once idle", async () => {
    // A turn can open after probation read the welcome, so the host itself
    // must refuse. The test above never gets as far as sending the shutdown.
    const id = "agt_idle_only";
    const { runtime, seen } = runtimeWith(stateRoot, () => 0);
    await runtime.launch(launchFor(id, cwd));
    const active = runtime.prompt(id, "sleep:2000");
    void active.settled.catch(() => {});
    let socket: net.Socket | undefined;
    let idle: net.Socket | undefined;
    try {
      await active.accepted;
      await until(() =>
        seen.some(
          ({ event }) => event.type === "turn" && event.state === "started"
        )
      );
      socket = net.createConnection(path.join(stateRoot, id, "host.sock"));
      await once(socket, "connect");
      const decode = ndjsonDecoder<HostMessage>();
      // A host that shuts down answers nothing more and closes.
      const reply = new Promise<string>((resolve) => {
        socket!.on("data", (chunk) => {
          if (decode(chunk).some((message) => message.type === "pong"))
            resolve("pong");
        });
        socket!.once("close", () => resolve("closed"));
      });
      socket.write(
        encodeMessage({ type: "shutdown", idleOnly: true }) +
          encodeMessage({ type: "ping" })
      );
      expect(await reply).toBe("pong");
      expect(await runtime.isAlive(id)).toBe(true);

      socket.destroy();
      const journal = () =>
        readFileSync(path.join(stateRoot, id, "journal.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).event);
      const settled = () =>
        journal().find(
          (event) => event?.type === "turn" && event.state === "settled"
        );
      await until(() => Boolean(settled()));
      expect(settled()).toMatchObject({ stopReason: "end_turn" });
      expect(settled().error).toBeFalsy();

      idle = net.createConnection(path.join(stateRoot, id, "host.sock"));
      await once(idle, "connect");
      idle.write(encodeMessage({ type: "shutdown", idleOnly: true }));
      await until(() => !existsSync(path.join(stateRoot, id, "host.pid")));
    } finally {
      socket?.destroy();
      idle?.destroy();
      await runtime.stop(id, true);
    }
  }, 30_000);

  it("never falls back to a plain stop when a turn opens after probation's welcome", async () => {
    const id = "agt_recovery_race";
    // No runtime attached: its reconnect would displace probation's client.
    const host = createLocalRunner(stateRoot, logger);
    const {
      cwd: folder,
      bins,
      env,
      pathPrefix,
      ...launch
    } = launchFor(id, cwd);
    await host.requestSession(
      { kind: "launch", agentId: id, launch },
      {
        cwd: folder,
        bins: { ...bins, adapter: { bin: fakeAgent } },
        env,
        pathPrefix,
      }
    );
    await until(() => existsSync(path.join(stateRoot, id, "session.json")));
    const { runtime } = runtimeWith(stateRoot, () => 0);
    const connect = HostClient.prototype.connect;
    const spy = vi
      .spyOn(HostClient.prototype, "connect")
      .mockImplementation(async function (this: HostClient, ...args) {
        const welcome = { ...(await connect.apply(this, args)) };
        await this.prompt("race", "sleep:60000");
        return welcome;
      });
    try {
      expect(await runtime.stopIdleHostForRecovery!(id)).toBe(false);
      expect(await runtime.listHosted()).toContain(id);
    } finally {
      spy.mockRestore();
      await runtime.stop(id, true);
    }
  }, 30_000);

  it.each([
    [{ type: "shutdown", force: false, idleOnly: true }, "kept"],
    [{ type: "shutdown", quiesceId: "lease" }, "kept"],
    [{ type: "shutdown", idleOnly: "yes" }, "rejected"],
  ] as const)("parses shutdown %j: %s", (message, outcome) => {
    expect(parseClientMessage(message)).toEqual(
      outcome === "kept" ? message : null
    );
  });

  it("does not count a foreign reused PID as an agent host", async () => {
    const id = "agt_foreign_pid";
    mkdirSync(path.join(stateRoot, id), { recursive: true });
    writeFileSync(path.join(stateRoot, id, "host.pid"), String(process.pid));
    const { runtime } = runtimeWith(stateRoot, () => 0);
    expect(await runtime.listHosted()).not.toContain(id);
  });

  it.each(["graceful", "force", "early-exit"])(
    "cleans detached owned children through real runtime (%s)",
    async (mode) => {
      const force = mode === "force";
      const id = `agt_owned_${mode[0]}`;
      const wrapper = path.join(stateRoot, `adapter-${mode}.mjs`);
      const pidFile = path.join(stateRoot, `child-${mode}.pid`);
      writeFileSync(
        wrapper,
        `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: child.pid, adapter: process.pid }));
child.unref();
await import(${JSON.stringify(pathToFileURL(fakeAgent).href)});
`,
        { mode: 0o755 }
      );
      const control = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore" }
      );
      const { runtime, seen } = runtimeWith(stateRoot, () => 0, null, {
        bin: wrapper,
      });
      const launch = launchFor(id, cwd);
      const alive = (pid: number) => {
        try {
          return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          })
            .trim()
            .startsWith("Z");
        } catch {
          return false;
        }
      };
      const secondId = `agt_peer_${mode[0]}`;
      const before = execFileSync("git", ["status", "--porcelain"], {
        cwd,
        encoding: "utf8",
      });
      try {
        await runtime.launch(launchFor(secondId, cwd));
        await expectEcho(
          runtime,
          seen,
          secondId,
          "normal completion before cleanup"
        );
        await runtime.launch(launch);
        const { child: pid, adapter } = JSON.parse(
          readFileSync(pidFile, "utf8")
        );
        expect(alive(pid)).toBe(true);
        if (mode === "early-exit") process.kill(adapter, "SIGKILL");
        else await runtime.stop(id, force);
        await until(() => !alive(pid));
        expect(alive(control.pid!)).toBe(true);
        expect(await runtime.isAlive(secondId)).toBe(true);
        await expectEcho(
          runtime,
          seen,
          secondId,
          "normal completion after other session cleanup"
        );
        expect(readFileSync(path.join(cwd, "user-notes.txt"), "utf8")).toBe(
          "preserve user work\n"
        );
        expect(
          execFileSync("git", ["status", "--porcelain"], {
            cwd,
            encoding: "utf8",
          })
        ).toBe(before);
      } finally {
        try {
          await runtime.stop(id, true);
        } finally {
          try {
            await runtime.stop(secondId, true);
          } finally {
            control.kill("SIGKILL");
          }
        }
      }
    }
  );

  it("reports unavailable enumeration without claiming another session", async () => {
    const { runtime, seen } = runtimeWith(stateRoot, () => 0);
    const target = "agt_scan";
    const peer = "agt_peer";
    const originalPath = process.env.PATH;
    const before = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
    });
    try {
      await runtime.launch(launchFor(target, cwd));
      await runtime.launch(launchFor(peer, cwd));
      process.env.PATH = "/nonexistent-owned-test";
      try {
        await expect(runtime.stop(target, true)).rejects.toThrow(
          "Unable to enumerate owned processes"
        );
      } finally {
        process.env.PATH = originalPath;
      }
      expect(await runtime.isAlive(target)).toBe(false);
      expect(await runtime.isAlive(peer)).toBe(true);
      await expectEcho(
        runtime,
        seen,
        peer,
        "still usable after enumeration failure"
      );
      expect(
        execFileSync("git", ["status", "--porcelain"], {
          cwd,
          encoding: "utf8",
        })
      ).toBe(before);
      expect(readFileSync(path.join(cwd, "user-notes.txt"), "utf8")).toBe(
        "preserve user work\n"
      );
    } finally {
      process.env.PATH = originalPath;
      try {
        await runtime.stop(target, true);
      } finally {
        await runtime.stop(peer, true);
      }
    }
  });

  it("interrupts real host work then starts urgent input in a separate turn", async () => {
    const id = "agt_interrupt";
    const { runtime, seen } = runtimeWith(stateRoot, () => 0);
    await runtime.launch(launchFor(id, cwd));
    try {
      expect(runtime.inputState?.(id).interruptSupported).toBe(true);
      const active = runtime.prompt(id, "sleep:60000");
      await active.accepted;
      await until(() =>
        seen.some(
          ({ event }) =>
            event.type === "update" &&
            event.update.sessionUpdate === "agent_message_chunk"
        )
      );
      const urgent = runtime.prompt(
        id,
        "Urgent new work",
        {
          source: "chat",
          chatMessageId: "urgent",
          userMessage: true,
          conversation: { streamId: id, threadId: "urgent-thread" },
        },
        { delivery: "interrupt" }
      );
      await urgent.settled;
      await active.settled;
      // Settlement releases prompt waiters before serialized event listeners.
      await until(
        () => seen.filter(({ event }) => event.type === "turn").length === 4
      );
      const turns = seen
        .filter(({ event }) => event.type === "turn")
        .map(({ event }) => event);
      expect(
        turns.map((event) => event.type === "turn" && event.state)
      ).toEqual(["started", "settled", "started", "settled"]);
      expect(turns[2]).toMatchObject({
        source: {
          chatMessageId: "urgent",
          conversation: { streamId: id, threadId: "urgent-thread" },
        },
      });
    } finally {
      await runtime.stop(id, true);
    }
  });

  it("keeps approval pending across server reconnects, validates choices and cancels on stop", async () => {
    const id = "agt_perm";
    const first = runtimeWith(stateRoot, () => 0);
    const second = runtimeWith(stateRoot, () => 0);
    try {
      await first.runtime.launch({ ...launchFor(id, cwd), fullAccess: false });
      const turn = first.runtime.prompt(id, "permission-test");
      await turn.accepted;
      await until(() => first.runtime.getPermissions(id).requests.length === 1);
      const pending = first.runtime.getPermissions(id).requests[0]!;
      expect(first.runtime.hasOpenTurn(id)).toBe(true);
      expect(await second.runtime.attach(id)).toBe(true);
      expect(second.runtime.getPermissions(id).requests[0]?.id).toBe(
        pending.id
      );
      await expect(
        second.runtime.answerPermission(id, pending.id, "invented")
      ).rejects.toThrow(/did not offer/);
      expect(second.runtime.getPermissions(id).requests).toHaveLength(1);
      await second.runtime.answerPermission(id, pending.id, "once");
      await until(() => !second.runtime.hasOpenTurn(id));
      expect(second.runtime.getPermissions(id).requests).toEqual([]);
      await expect(
        second.runtime.answerPermission(id, pending.id, "once")
      ).rejects.toThrow(/no longer pending/);

      const denied = second.runtime.prompt(id, "permission-test deny");
      await until(
        () => second.runtime.getPermissions(id).requests.length === 1
      );
      await second.runtime.answerPermission(
        id,
        second.runtime.getPermissions(id).requests[0]!.id,
        "no"
      );
      await denied.settled;
      const cancelled = second.runtime.prompt(id, "permission-test cancel");
      await until(
        () => second.runtime.getPermissions(id).requests.length === 1
      );
      await second.runtime.cancel(id);
      await cancelled.settled;
      expect(second.runtime.getPermissions(id).requests).toEqual([]);
      const results = second.seen.flatMap(({ event }) =>
        event.type === "update" &&
        event.update.sessionUpdate === "agent_message_chunk" &&
        event.update.content.type === "text"
          ? [event.update.content.text]
          : []
      );
      expect(results).toContain("Permission result: once");
      expect(results).toContain("Permission result: no");
      expect(results).toContain("Permission result: cancelled");
    } finally {
      await second.runtime.stop(id, true);
      await first.runtime.stop(id, true);
    }
  }, 30_000);
  it.each(["claude", "codex", "opencode"] as const)(
    "%s host delivers oversized context through a complete launch file, including after restart",
    async (engine) => {
      const id = `agt_p_${engine}`;
      const context = "Persona rule\n".repeat(6000) + "FINAL BRIEFING RULE";
      let resumeSessionId: string | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const { runtime, seen } = runtimeWith(stateRoot, () => 0);
        const session = await runtime.launch({
          ...launchFor(id, cwd),
          engine,
          personaContext: context,
          resumeSessionId,
        });
        resumeSessionId = session.sessionId;
        try {
          const file = path.join(stateRoot, id, "persona-context.md");
          expect(readFileSync(file, "utf8")).toBe(context);
          const launch = JSON.parse(
            readFileSync(path.join(stateRoot, id, "launch.json"), "utf8")
          );
          expect(launch.systemPrompt).toBe("Be brief.");
          expect(launch.personaContext).toContain(JSON.stringify(file));
          await runtime.prompt(id, "Begin the review.").settled;
          await until(() =>
            seen.some(
              ({ event }) => event.type === "turn" && event.state === "settled"
            )
          );
          const answer = seen
            .flatMap(({ event }) =>
              event.type === "update" &&
              event.update.sessionUpdate === "agent_message_chunk" &&
              event.update.content.type === "text"
                ? [event.update.content.text]
                : []
            )
            .join("");
          expect(answer).toContain("read the entire UTF-8 launch context file");
          expect(answer).toContain(file);
          expect(answer).toContain("Begin the review.");
        } finally {
          await runtime.stop(id);
        }
      }
    },
    30_000
  );

  it("delivers the full Codex launch bundle through the host, not just the recorded system prompt", async () => {
    const id = "agt_host_guidance";
    const { runtime, seen } = runtimeWith(stateRoot, () => 0);
    const guidance = buildSystemPrompt({
      agent: {
        id,
        type: "codex",
        persona: "reviewer",
        agentArgs: [
          "--append-system-prompt",
          "Review only the parent's diff and report findings.",
        ],
      },
      personalityPrompt: null,
      suggestSessionRename: false,
    });
    await runtime.launch({
      ...launchFor(id, cwd),
      engine: "codex",
      systemPrompt: guidance,
    });
    try {
      expect(seen.some(({ event }) => event.type === "turn")).toBe(false);
      await runtime.prompt(id, "Begin the requested review.").settled;
      await until(() =>
        seen.some(
          ({ event }) => event.type === "turn" && event.state === "settled"
        )
      );
      const answer = seen
        .flatMap(({ event }) =>
          event.type === "update" &&
          event.update.sessionUpdate === "agent_message_chunk" &&
          event.update.content.type === "text"
            ? [event.update.content.text]
            : []
        )
        .join("");
      expect(answer).toContain(guidance);
      expect(answer).toContain("Review only the parent's diff");
      expect(answer).toContain("Your replies stream live");
      expect(answer).toContain("DISPATCH_FILES_DIR");
      expect(answer).toContain("Begin the requested review.");
      const starts = seen.filter(
        ({ event }) => event.type === "turn" && event.state === "started"
      );
      expect(starts).toHaveLength(1);
      expect(starts[0].event).toMatchObject({
        text: "Begin the requested review.",
      });
    } finally {
      await runtime.stop(id);
    }
  });

  it("launches, runs a turn, survives its client, replays, and stops", async () => {
    // A first "server": launch and run one turn.
    const first = runtimeWith(stateRoot, () => 0);
    const session = await first.runtime.launch(launchFor(agentId, cwd));
    expect(session.sessionId).toMatch(/^fake_claude_/);
    expect(await first.runtime.isAlive(agentId)).toBe(true);
    expect(await first.runtime.hostPid(agentId)).toBeGreaterThan(0);
    expect(await first.runtime.listHosted()).toEqual([agentId]);
    await until(() => first.runtime.getCommands(agentId)?.length === 2);
    expect(first.runtime.getCommands(agentId)?.map((c) => c.name)).toEqual([
      "review",
      "compact",
    ]);

    const turn = first.runtime.prompt(agentId, "hello there");
    await turn.accepted;
    expect(first.runtime.isBusy(agentId)).toBe(true);
    await turn.settled;
    expect(first.runtime.isBusy(agentId)).toBe(false);
    await until(() =>
      first.seen.some(
        (s) => s.event.type === "turn" && s.event.state === "settled"
      )
    );
    const text = first.seen
      .map((s) => s.event)
      .filter(
        (e): e is Extract<DriverEvent, { type: "update" }> =>
          e.type === "update" &&
          e.update.sessionUpdate === "agent_message_chunk"
      )
      .map((e) =>
        e.update.content.type === "text" ? e.update.content.text : ""
      )
      .join("");
    expect(text).toBe("You said: hello there");
    const lastSeq = Math.max(...first.seen.map((s) => s.seq));
    expect(lastSeq).toBeGreaterThan(0);
    // Every seq arrived exactly once, in order.
    expect(first.seen.map((s) => s.seq)).toEqual(
      first.seen.map((_, i) => i + 1)
    );

    // The "server" goes away: drop its socket without stopping the host.
    // A second server attaches with the watermark and gets only what it
    // missed (nothing yet), then runs a turn of its own.
    const second = runtimeWith(stateRoot, () => lastSeq);
    expect(await second.runtime.attach(agentId)).toBe(true);
    expect(second.runtime.getCommands(agentId)?.map((c) => c.name)).toEqual([
      "review",
      "compact",
    ]);
    expect(second.seen).toEqual([]);
    const again = second.runtime.prompt(agentId, "still here?");
    await again.settled;
    await until(() => second.seen.some((s) => s.event.type === "turn"));
    expect(second.seen[0]?.seq).toBe(lastSeq + 1);

    // A third server with no watermark at all gets the whole journal
    // replayed, in order, matching what the file holds.
    const third = runtimeWith(stateRoot, () => 0);
    expect(await third.runtime.attach(agentId)).toBe(true);
    const journalLines = readFileSync(
      path.join(stateRoot, agentId, "journal.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n").length;
    await until(() => third.seen.length >= journalLines);
    expect(third.seen.map((s) => s.seq)).toEqual(
      third.seen.map((_, i) => i + 1)
    );
    expect(third.seen.length).toBe(journalLines);

    // A stored position from another journal must replay from the start
    // even when the current journal has already passed that position.
    const replacement = runtimeWith(stateRoot, () => 1, "another-journal");
    expect(await replacement.runtime.attach(agentId)).toBe(true);
    await until(() => replacement.seen.length >= journalLines);
    expect(replacement.seen[0]?.seq).toBe(1);
    expect(replacement.synced).toContainEqual({
      journalId: expect.any(String),
      reset: true,
    });

    // Stop: the host exits and its pid and socket go away.
    await replacement.runtime.stop(agentId, false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await replacement.runtime.isAlive(agentId)).toBe(false);
    expect(await replacement.runtime.listHosted()).toEqual([]);
  }, 60_000);

  it("reattaches to an active native host after its controller exits", async () => {
    const id = "agt_native_handoff";
    const parentId = "agt_native_parent";
    const folder = mkdtempSync(path.join(cwd, "session-"));
    const input = launchFor(id, folder);
    input.fullAccess = false;
    const adapter = {
      bin: "bun",
      args: [path.join(here, "helpers/remote-acp-fixture.ts")],
    };
    const controller = path.join(stateRoot, "handoff.ts");
    // Exit only after the engine has begun the turn. Nothing in this process
    // runs the host's stop path or can resolve a promise in the new controller.
    writeFileSync(
      controller,
      `
      import {createAcpRuntime} from ${JSON.stringify(pathToFileURL(path.join(here, "../src/agents/acp/runtime.ts")).href)};
      const runtime = createAcpRuntime({
        config: ${JSON.stringify({ agentStateRoot: stateRoot, acpAdapter: adapter })},
        logger: {info(){}, warn(){}, debug(){}, error(){}},
        hostSeq:async()=>({seq:0,journalId:null}), syncJournal:async()=>{}
      });
      const input = ${JSON.stringify(input)};
      await runtime.launch({...input, agentId: ${JSON.stringify(parentId)}});
      const {sessionId}=await runtime.launch(input);
      const pid=await runtime.hostPid(input.agentId);
      let cursor = 0;
      runtime.onEvent((id, _, seq) => {
        if (id === input.agentId) cursor = Math.max(cursor, seq);
      });
      const turn = runtime.prompt(input.agentId, "proof-count prove-permission");
      await turn.accepted;
      for (;;) {
        const [permission] = runtime.getPermissions(input.agentId).requests;
        if (permission && cursor > 0) {
          console.log(JSON.stringify({sessionId, pid, seq: cursor, permissionId: permission.id}));
          process.exit(0);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    `
    );
    const result = execFileSync("bun", [controller], {
      timeout: 20_000,
      encoding: "utf8",
    });
    const checkpoint = JSON.parse(result.trim());
    expect(checkpoint.pid).toBeGreaterThan(0);
    const journalId = readFileSync(
      path.join(stateRoot, id, "journal.id"),
      "utf8"
    ).trim();
    const { runtime, seen } = runtimeWith(
      stateRoot,
      () => checkpoint.seq,
      journalId
    );
    const parent = runtimeWith(stateRoot, () => 0);
    try {
      expect(await runtime.listHosted()).toContain(id);
      expect(await runtime.inspectNativeHost!(id)).toMatchObject({
        sessionHandle: id,
        processState: "live",
        attached: false,
        activity: "unknown",
        capabilities: null,
      });
      expect(await runtime.attach(id)).toBe(true);
      expect(await runtime.inspectNativeHost!(id)).toMatchObject({
        processState: "live",
        attached: true,
        activity: "busy",
        cursor: { journalId },
      });
      expect(await runtime.hostPid(id)).toBe(checkpoint.pid);
      expect(runtime.getPermissions(id).requests[0]?.id).toBe(
        checkpoint.permissionId
      );
      await runtime.answerPermission(id, checkpoint.permissionId, "allow");
      await until(() =>
        seen.some(
          ({ event }) => event.type === "turn" && event.state === "settled"
        )
      );
      expect(
        seen.filter(
          ({ event }) => event.type === "turn" && event.state === "settled"
        )
      ).toHaveLength(1);
      expect(seen.find(({ seq }) => seq > 0)?.seq).toBe(checkpoint.seq + 1);
      expect(
        readFileSync(path.join(folder, "provider-invocations"), "utf8")
      ).toBe("called\n");
      expect(await runtime.inspectNativeHost!(id)).toMatchObject({
        processState: "live",
        activity: "idle",
        capabilities: { steering: expect.any(Boolean) },
      });
      writeFileSync(path.join(folder, "review-marker.txt"), "native-handoff");
      expect(readFileSync(path.join(folder, "protected-action"), "utf8")).toBe(
        "allowed\n"
      );
      expect(await parent.runtime.attach(parentId)).toBe(true);
      await parent.runtime.prompt(parentId, "proof-reviewed-checkout").settled;
      await until(() =>
        parent.seen.some(
          ({ agentId, event }) =>
            agentId === parentId &&
            event.type === "update" &&
            event.update.sessionUpdate === "agent_message_chunk" &&
            event.update.content.type === "text" &&
            event.update.content.text.includes("Checkout marker native-handoff")
        )
      );
    } finally {
      await parent.runtime.stop(parentId, true);
      await parent.runtime.discard(parentId);
      await runtime.stop(id, true);
      await runtime.discard(id);
    }
    expect(await runtime.inspectNativeHost!(id)).toMatchObject({
      processState: "gone",
      attached: false,
    });
    mkdirSync(path.join(stateRoot, id));
    writeFileSync(path.join(stateRoot, id, "host.pid"), String(process.pid));
    expect(await runtime.inspectNativeHost!(id)).toMatchObject({
      processState: "stale",
      attached: false,
    });
    expect(await runtime.listHosted()).not.toContain(id);
    expect(readFileSync(path.join(folder, "review-marker.txt"), "utf8")).toBe(
      "native-handoff"
    );
  }, 40_000);

  it("sends one running welcome when a client attaches during the session write", async () => {
    const dir = mkdtempSync("/tmp/dispatch-acp-welcome-");
    const preload = path.join(dir, "hold-session-write.mjs");
    const pending = path.join(dir, "write-pending");
    const release = path.join(dir, "release-write");
    writeFileSync(
      preload,
      `import { mock } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
const { writeFile } = fs;
mock.module("node:fs/promises", () => ({
  ...fs,
  async writeFile(file, ...args) {
    if (file === ${JSON.stringify(path.join(dir, "session.json"))}) {
      writeFileSync(${JSON.stringify(pending)}, "");
      while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
    }
    return writeFile(file, ...args);
  },
}));
`
    );
    writeFileSync(
      path.join(dir, "launch.json"),
      JSON.stringify(hostLaunchFor("agt_starting", cwd))
    );
    const host = spawn(
      "bun",
      ["--preload", preload, mainTs, "agent-host", "--state", dir],
      { stdio: "ignore" }
    );
    const exited = once(host, "exit");
    let socket: net.Socket | undefined;
    try {
      await until(() => existsSync(pending), 5000);
      socket = net.createConnection(path.join(dir, "host.sock"));
      const messages: HostMessage[] = [];
      const decode = ndjsonDecoder<HostMessage>();
      socket.on("data", (chunk) => messages.push(...decode(chunk)));
      await once(socket, "connect");
      socket.write(
        encodeMessage({ type: "hello", fromSeq: 0, replayComplete: true })
      );
      await until(() => messages.some((m) => m.type === "replay_complete"));

      writeFileSync(release, "");
      const welcomes = () => messages.filter((m) => m.type === "welcome");
      await until(() => welcomes().length >= 2);
      expect(welcomes().map((m) => m.running)).toEqual([false, true]);
    } finally {
      socket?.destroy();
      host.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("lists every file a host writes into its directory", async () => {
    const ca = path.join(cwd, "host-files-ca.pem");
    writeFileSync(ca, rootCertificates[0]!);
    const written = new Set<string>();
    // Between them the two engines reach every writer.
    for (const engine of ["codex", "opencode"] as const) {
      const dir = mkdtempSync("/tmp/dispatch-acp-files-");
      writeFileSync(
        path.join(dir, HOST_FILES.launch),
        JSON.stringify({
          ...hostLaunchFor(`agt_files_${engine}`, cwd),
          engine,
          reportTurnActivity: true,
          env: { DISPATCH_LOCAL_CA_CERTIFICATE: ca },
          personaContext: await preparePersonaContext(
            dir,
            "Persona rule\n".repeat(6000)
          ),
        })
      );
      const host = spawn("bun", [mainTs, "agent-host", "--state", dir], {
        stdio: "ignore",
      });
      const closed = once(host, "exit");
      let socket: net.Socket | undefined;
      try {
        await until(() => existsSync(path.join(dir, HOST_FILES.session)));
        socket = net.createConnection(path.join(dir, HOST_FILES.socket));
        const messages: HostMessage[] = [];
        const decode = ndjsonDecoder<HostMessage>();
        socket.on("data", (chunk) => messages.push(...decode(chunk)));
        await once(socket, "connect");
        socket.write(encodeMessage({ type: "hello", fromSeq: 0 }));
        await until(() =>
          messages.some((m) => m.type === "welcome" && m.running)
        );
        const { journalId } = messages.find((m) => m.type === "welcome")!;
        socket.write(
          encodeMessage({
            type: "prompt",
            id: "hold",
            journalId,
            text: "hold-turn",
          })
        );
        // Sample with the turn open, while the transient files still exist.
        await until(
          () =>
            existsSync(path.join(dir, HOST_FILES.turnActive)) &&
            existsSync(path.join(dir, HOST_FILES.receipts))
        );
        for (const name of readdirSync(dir)) written.add(name);
      } finally {
        socket?.destroy();
        host.kill();
        await closed;
        rmSync(dir, { recursive: true, force: true });
      }
    }
    // The launcher writes the log and the service CA; no host run does.
    const { log, serviceMcpCa, ...byHost } = HOST_FILES;
    expect([...written].sort()).toEqual(Object.values(byHost).sort());
  }, 30_000);

  it("keeps a runner attachment across a passive inventory connection", async () => {
    const dir = mkdtempSync("/tmp/dispatch-acp-inventory-");
    const instanceId = "01234567-89ab-4cde-8fab-0123456789ab";
    writeFileSync(
      path.join(dir, "launch.json"),
      JSON.stringify({
        ...hostLaunchFor("agt_inventory", cwd),
        hostInstanceId: instanceId,
      })
    );
    const host = spawn("bun", [mainTs, "agent-host", "--state", dir], {
      stdio: "ignore",
    });
    const closed = once(host, "exit");
    const socketPath = path.join(dir, "host.sock");
    const clients: net.Socket[] = [];
    async function attach() {
      const messages: HostMessage[] = [];
      const socket = net.createConnection(socketPath);
      clients.push(socket);
      const decode = ndjsonDecoder<HostMessage>();
      socket.on("data", (chunk) => messages.push(...decode(chunk)));
      await once(socket, "connect");
      socket.write(encodeMessage({ type: "hello", fromSeq: 0 }));
      await until(() =>
        messages.some(
          (message) => message.type === "welcome" && message.running
        )
      );
      return { socket, messages };
    }
    try {
      await until(() => {
        try {
          readFileSync(path.join(dir, "session.json"));
          return true;
        } catch {
          return false;
        }
      });
      const first = await attach();
      const passive = net.createConnection(socketPath);
      clients.push(passive);
      await once(passive, "connect");
      passive.end();
      await once(passive, "close");

      first.socket.write(encodeMessage({ type: "hello", fromSeq: 0 }));
      await until(
        () => first.messages.filter((m) => m.type === "welcome").length === 2
      );

      const second = await attach();
      for (const message of [...first.messages, ...second.messages]) {
        if (message.type !== "welcome") continue;
        expect(message.hostInstanceId).toBe(instanceId);
        expect(message.hostBuild).toEqual(embeddedBuild);
      }
    } finally {
      for (const client of clients) client.destroy();
      host.kill();
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks live host quiescence and invalidates the lease on lost attachment", async () => {
    const dir = mkdtempSync("/tmp/dispatch-acp-quiesce-");
    const folder = mkdtempSync(path.join(cwd, "quiesce-"));
    const launch = launchFor("agt_quiesce", folder);
    launch.fullAccess = false;
    const adapter = {
      bin: "bun",
      args: [path.join(here, "helpers/recycle-acp-fixture.ts")],
    };
    writeFileSync(
      path.join(dir, "launch.json"),
      JSON.stringify({
        ...launch,
        bins: { ...launch.bins, adapter },
        hostInstanceId: "01234567-89ab-4cde-8fab-0123456789ab",
      })
    );
    const host = spawn("bun", [mainTs, "agent-host", "--state", dir], {
      stdio: "ignore",
    });
    const exited = once(host, "exit");
    const clients: net.Socket[] = [];
    async function attach() {
      const socket = net.createConnection(path.join(dir, "host.sock"));
      clients.push(socket);
      const messages: HostMessage[] = [];
      const decode = ndjsonDecoder<HostMessage>();
      socket.on("data", (chunk) => messages.push(...decode(chunk)));
      await once(socket, "connect");
      const send = (...commands: ClientMessage[]) =>
        socket.write(commands.map(encodeMessage).join(""));
      send({ type: "hello", fromSeq: 0 });
      await until(() =>
        messages.some(
          (m) =>
            m.type === "welcome" && m.running && m.quiesceSupported === true
        )
      );
      const quiesce = async (id: string, state: "idle" | "busy") => {
        send({ type: "quiesce", id });
        await until(() =>
          messages.some((m) => m.type === "quiesce_result" && m.id === id)
        );
        expect(messages).toContainEqual({ type: "quiesce_result", id, state });
      };
      const shutdown = async (id: string, accepted: boolean) => {
        send({ type: "shutdown", quiesceId: id });
        await until(() =>
          messages.some(
            (m) => m.type === "quiesce_shutdown_result" && m.id === id
          )
        );
        expect(messages).toContainEqual({
          type: "quiesce_shutdown_result",
          id,
          accepted,
        });
      };
      return { socket, messages, send, quiesce, shutdown };
    }
    const controlFile = path.join(folder, "recycle-command");
    async function control(value: unknown) {
      const next = controlFile + ".next";
      writeFileSync(next, value === "ask" ? "ask" : JSON.stringify(value));
      renameSync(next, controlFile);
      await until(() => !existsSync(controlFile));
    }
    try {
      await until(() => existsSync(path.join(dir, "session.json")));
      const a = await attach();
      await a.quiesce("release", "idle");
      a.send(
        { type: "release_quiesce", id: "wrong" },
        { type: "prompt", id: "deferred", text: "must not run" }
      );
      await until(() => a.messages.some((m) => m.type === "prompt_deferred"));
      a.send(
        { type: "release_quiesce", id: "release" },
        { type: "prompt", id: "submitted", text: "hold-turn" },
        { type: "quiesce", id: "during-pickup" }
      );
      await until(() =>
        a.messages.some(
          (m) => m.type === "quiesce_result" && m.id === "during-pickup"
        )
      );
      expect(a.messages).toContainEqual({
        type: "quiesce_result",
        id: "during-pickup",
        state: "busy",
      });
      await until(() =>
        a.messages.some(
          (m) =>
            m.type === "event" &&
            m.event.type === "turn" &&
            m.event.state === "settled"
        )
      );

      await control("ask");
      await until(() =>
        a.messages.some(
          (m) => m.type === "permissions" && m.requests.length > 0
        )
      );
      await a.quiesce("pending-permission", "busy");
      const permissions = a.messages.find(
        (m) => m.type === "permissions" && m.requests.length > 0
      );
      if (permissions?.type !== "permissions")
        throw new Error("missing permission");
      a.send({
        type: "answer_permission",
        id: "answer",
        requestId: permissions.requests[0]!.id,
        optionId: "allow",
      });
      await until(() => existsSync(controlFile + ".answered"));

      // A state-only background entry is awaiting its metadata and cannot be
      // shown yet. It must still keep the host alive.
      await control({
        sessionUpdate: "async_task_state_update",
        asyncTaskId: "watch",
        state: "running",
      });
      await a.quiesce("background", "busy");
      await control({
        sessionUpdate: "async_task_state_update",
        asyncTaskId: "watch",
        state: "completed",
      });

      await a.quiesce("before-background", "idle");
      await control({
        sessionUpdate: "async_task_state_update",
        asyncTaskId: "new",
        state: "running",
      });
      await a.shutdown("before-background", false);
      await control({
        sessionUpdate: "async_task_state_update",
        asyncTaskId: "new",
        state: "completed",
      });

      await a.quiesce("before-self-turn", "idle");
      await control({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "woke itself" },
      });
      await until(() =>
        a.messages.some(
          (m) =>
            m.type === "event" &&
            m.event.type === "turn" &&
            m.event.state === "started" &&
            m.event.source?.source === "engine"
        )
      );
      await a.shutdown("before-self-turn", false);
      await a.quiesce("self-turn", "busy");
      await control({
        sessionUpdate: "usage_update",
        used: 1,
        size: 10,
        cost: { amount: 0, currency: "USD" },
      });
      await until(
        () =>
          a.messages.filter(
            (m) =>
              m.type === "event" &&
              m.event.type === "turn" &&
              m.event.state === "settled"
          ).length === 2
      );

      await a.quiesce("lost", "idle");
      const disconnected = once(a.socket, "close");
      a.socket.destroy();
      await disconnected;
      const b = await attach();
      await b.shutdown("lost", false);
      await b.quiesce("replacement-lease", "idle");
      await b.shutdown("replacement-lease", true);
      await exited;
    } finally {
      for (const client of clients) client.destroy();
      host.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
      rmSync(folder, { recursive: true, force: true });
    }
  }, 20_000);

  const uncertain =
    "Runner connection dropped before acknowledgement; execution is unknown.";
  const attempt = "11111111-1111-4111-8111-111111111111";

  async function updateFixture(adapter?: { bin: string; args?: string[] }) {
    const root = mkdtempSync("/tmp/dispatch-ack-");
    const folder = mkdtempSync(path.join(cwd, "update-"));
    const id = "agt_update_ack";
    const input = launchFor(id, folder);
    input.fullAccess = false;
    const hostAdapter = adapter ?? {
      bin: "bun",
      args: [path.join(here, "helpers/remote-acp-fixture.ts")],
    };
    const hosts: ReturnType<typeof createLocalRunner>[] = [];
    async function launchHost(dir: string) {
      const host = createLocalRunner(dir, logger);
      const { cwd, bins, env, pathPrefix, ...launch } = input;
      await host.requestSession(
        { kind: "launch", agentId: id, launch },
        { cwd, bins: { ...bins, adapter: hostAdapter }, env, pathPrefix }
      );
      hosts.push(host);
      const socket = path.join(dir, id, "host.sock");
      await until(() => existsSync(path.join(dir, id, "session.json")));
      return socket;
    }
    let socketPath = await launchHost(root);
    const holds = new RunnerUpdateHolds({
      store: { read: async () => [], write: async () => {} },
      logger,
    });
    const commands: ClientMessage[] = [];
    const replies: HostMessage[] = [];
    const links: Duplex[] = [];
    const tap: {
      outbound?: (message: ClientMessage, drop: () => void) => boolean | void;
      inbound?: (
        message: HostMessage,
        drop: () => void
      ) => HostMessage | false | void;
      offline: boolean;
    } = { offline: false };
    let seq = 0;
    let journal: string | null = null;
    const { runtime, seen } = runtimeWith(root, () => seq, null, undefined, {
      hostSeq: async () => ({ seq, journalId: journal }),
      syncJournal: async (_agentId, next, reset) => {
        journal = next;
        if (reset) seq = 0;
      },
      holds,
      placement: async () => ({ runner: "update-runner", workspace: "test" }),
      remote: {
        available: () => true,
        async requestSession(_placement, operation) {
          if (operation.kind !== "attach") return { value: true };
          if (tap.offline) throw new RunnerUnavailable("swapping");
          const host = net.createConnection(socketPath);
          const outgoing = ndjsonDecoder<ClientMessage>();
          const incoming = ndjsonDecoder<HostMessage>();
          const link = new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
              for (const message of outgoing(chunk)) {
                commands.push(message);
                if (tap.outbound?.(message, drop) !== false)
                  host.write(encodeMessage(message));
              }
              callback();
            },
            destroy(error, callback) {
              host.destroy();
              callback(error);
            },
          });
          const drop = () => {
            tap.offline = true;
            link.destroy();
          };
          links.push(link);
          host.on("close", () => link.destroy());
          host.on("error", (error) => link.destroy(error));
          host.on("data", (chunk) => {
            for (const message of incoming(chunk)) {
              if (link.destroyed) break;
              replies.push(message);
              const result = tap.inbound?.(message, drop);
              if (result !== false && !link.destroyed)
                link.push(encodeMessage(result ?? message));
            }
          });
          return { channel: link, value: true };
        },
      },
    });
    runtime.onEvent((_id, _event, next) => {
      if (next > 0) seq = next;
    });
    expect(await runtime.attach(id)).toBe(true);
    const invocations = () => {
      const file = path.join(folder, "provider-invocations");
      return existsSync(file)
        ? readFileSync(file, "utf8").trim().split("\n").length
        : 0;
    };
    return {
      id,
      runtime,
      seen,
      holds,
      commands,
      replies,
      tap,
      folder,
      invocations,
      async rotate() {
        const rotated = path.join(root, "rotated");
        socketPath = await launchHost(rotated);
      },
      async close() {
        await holds.release("update-runner", attempt, "cancelled");
        await runtime.stop(id, true);
        for (const link of links) link.destroy();
        holds.close();
        for (const host of hosts)
          await host.requestSession({ kind: "stop", agentId: id, force: true });
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  it.each([
    "unclaimed",
    "claimed",
    "claimed-without-receipt",
    "accepted",
    "rotated",
    "old-host",
    "interrupted-replay",
    "expired",
    "unheld",
    "wrong-receipt-journal",
    "silent-receipt",
    "receipt-channel-lost",
    "aborted",
  ] as const)(
    "reconciles a lost prompt acknowledgement with a real host (%s)",
    async (mode) => {
      const f = await updateFixture();
      const fifo = path.join(f.folder, "image.png");
      const claimed = mode === "claimed" || mode === "claimed-without-receipt";
      const unclaimed = [
        "unclaimed",
        "unheld",
        "expired",
        "wrong-receipt-journal",
        "silent-receipt",
        "receipt-channel-lost",
        "aborted",
      ].includes(mode);
      const query = !["unheld", "old-host", "rotated", "expired"].includes(
        mode
      );
      const controller = new AbortController();
      let releaseImage: Promise<void> | undefined;
      try {
        if (claimed) execFileSync("mkfifo", [fifo]);
        const begin = () => {
          if (mode === "unheld") return;
          void f.holds.begin("update-runner", attempt, {
            ...(mode === "expired" ? { boundMs: 1000 } : {}),
          });
        };
        f.tap.outbound = (message, drop) => {
          if (
            message.type !== "prompt" ||
            f.commands.filter((m) => m.type === "prompt").length !== 1
          )
            return;
          begin();
          if (unclaimed) {
            drop();
            return false;
          }
        };
        let dropped = false;
        let replayInterrupted = false;
        f.tap.inbound = (message, drop) => {
          if (
            mode === "interrupted-replay" &&
            dropped &&
            !replayInterrupted &&
            message.type === "replay_complete"
          ) {
            replayInterrupted = true;
            drop();
            queueMicrotask(() => {
              f.tap.offline = false;
            });
            return false;
          }
          if (message.type === "prompt_receipt_result") {
            if (mode === "silent-receipt") return false;
            if (mode === "receipt-channel-lost") queueMicrotask(drop);
            if (
              mode === "wrong-receipt-journal" ||
              mode === "claimed-without-receipt"
            )
              return { ...message, journalId: "wrong" };
          }
          if (
            message.type === "welcome" &&
            dropped &&
            (mode === "aborted" || mode === "rotated")
          )
            return {
              ...message,
              turn: { seq: 0, startedAt: new Date().toISOString() },
            };
          if (message.type === "welcome" && mode === "old-host")
            return { ...message, promptReceiptSupported: undefined };
          if (
            !dropped &&
            ((claimed &&
              message.type === "event" &&
              message.event.type === "turn" &&
              message.event.state === "started") ||
              message.type === "prompt_accepted")
          ) {
            dropped = true;
            drop();
            return false;
          }
        };
        const turn = f.runtime.prompt(
          f.id,
          "proof-count",
          undefined,
          claimed
            ? { images: [{ path: fifo, mimeType: "image/png" }] }
            : { signal: controller.signal }
        );
        await until(
          () => f.tap.offline && !f.runtime.getPermissions(f.id).connected
        );
        if (mode === "rotated") await f.rotate();
        let outcome: string | undefined;
        const result = turn.accepted
          .then(
            () => "accepted",
            (error: Error) => error.message
          )
          .then((visible) => (outcome = visible));
        if (mode === "unheld") {
          await until(() => outcome !== undefined, 500);
          expect(outcome).toBe(uncertain);
        } else {
          // Give the close handler and its rejection handlers a turn before
          // allowing the new supervisor to attach.
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(outcome).toBeUndefined();
        }
        if (unclaimed) dropped = true;
        if (mode === "aborted") controller.abort();
        if (mode !== "expired") f.tap.offline = false;
        const accepted = [
          "unclaimed",
          "accepted",
          "interrupted-replay",
        ].includes(mode);
        expect(await result).toBe(accepted ? "accepted" : uncertain);
        await turn.settled;
        const prompts = f.commands.filter((m) => m.type === "prompt");
        const queries = f.commands.filter((m) => m.type === "prompt_receipt");
        expect(prompts).toHaveLength(mode === "unclaimed" ? 2 : 1);
        if (mode === "unclaimed") expect(prompts[1]).toEqual(prompts[0]);
        if (query) {
          expect(queries).toEqual([
            {
              type: "prompt_receipt",
              id: prompts[0]?.id,
              journalId: prompts[0]?.journalId,
            },
          ]);
          expect(f.replies).toContainEqual({
            ...queries[0],
            type: "prompt_receipt_result",
            state: unclaimed ? "unclaimed" : claimed ? "claimed" : "accepted",
          });
        } else expect(queries).toEqual([]);
        const queued = [
          "aborted",
          "rotated",
          "silent-receipt",
          "claimed",
          "claimed-without-receipt",
        ].includes(mode)
          ? f.runtime.prompt(f.id, "next prompt", undefined, {
              delivery: "queue",
            })
          : undefined;
        void queued?.accepted.catch(() => {});
        const sentNext = () =>
          f.commands.some(
            (m) => m.type === "prompt" && m.text === "next prompt"
          );
        if (claimed) {
          await f.holds.release("update-runner", attempt, "committed");
          expect(f.runtime.hasOpenTurn(f.id)).toBe(true);
          expect(sentNext()).toBe(false);
          releaseImage = writeFile(fifo, "image");
          await releaseImage;
        }
        if (mode === "unclaimed" || (!unclaimed && mode !== "rotated")) {
          await until(() =>
            f.seen.some(
              ({ event }) => event.type === "turn" && event.state === "settled"
            )
          );
          expect(
            f.seen
              .flatMap(({ event }) =>
                event.type === "turn" ? [event.state] : []
              )
              .slice(0, claimed ? 2 : undefined)
          ).toEqual(["started", "settled"]);
        }
        if (mode === "silent-receipt") {
          expect(
            f.replies.filter((m) => m.type === "welcome").at(-1)?.turn
          ).toBeNull();
        }
        if (mode === "rotated") {
          const welcomes = f.replies.filter((m) => m.type === "welcome");
          expect(welcomes.at(-1)?.journalId).not.toBe(welcomes[0]?.journalId);
          expect(
            f.seen.filter(
              ({ event }) => event.type === "turn" && event.state === "settled"
            )
          ).toHaveLength(0);
        }
        expect(f.invocations()).toBe(unclaimed && mode !== "unclaimed" ? 0 : 1);
        if (queued) {
          if (!claimed)
            await f.holds.release("update-runner", attempt, "committed");
          await until(sentNext);
          await queued.accepted;
          await queued.settled;
          expect(f.runtime.isBusy(f.id)).toBe(false);
        }
      } finally {
        if (claimed && !releaseImage)
          void writeFile(fifo, "image").catch(() => {});
        await f.close();
      }
    }
  );

  it.each([
    "matches",
    "changed",
    "already-answered",
    "different-session",
    "different-journal",
    "unlisted-option",
  ] as const)(
    "validates a pending permission answer on reconnect (%s)",
    async (mode) => {
      const f = await updateFixture();
      try {
        const turn = f.runtime.prompt(f.id, "proof-count prove-permission");
        await turn.accepted;
        await until(() => f.runtime.getPermissions(f.id).requests.length === 1);
        const [request] = f.runtime.getPermissions(f.id).requests;
        await f.holds.begin("update-runner", attempt);
        f.tap.outbound = (message, drop) => {
          if (
            message.type === "answer_permission" &&
            f.commands.filter((m) => m.type === "answer_permission").length ===
              1 &&
            mode !== "already-answered"
          ) {
            drop();
            return false;
          }
        };
        f.tap.inbound = (message, drop) => {
          if (
            mode === "already-answered" &&
            message.type === "permission_answered"
          ) {
            drop();
            return false;
          }
          if (mode === "different-session" && message.type === "welcome")
            return { ...message, sessionId: "different" };
          if (mode === "different-journal" && message.type === "welcome")
            return { ...message, journalId: "different" };
          if (mode === "changed" && message.type === "welcome")
            return {
              ...message,
              permissions: message.permissions?.map((item) => ({
                ...item,
                details: "changed operation",
              })),
            };
        };
        const result = f.runtime
          .answerPermission(
            f.id,
            request!.id,
            mode === "unlisted-option" ? "absent" : "allow"
          )
          .then(
            () => "answered",
            (error: Error) => error.message
          );
        await until(
          () => f.tap.offline && !f.runtime.getPermissions(f.id).connected
        );
        const pending = Symbol();
        expect(await Promise.race([result, Promise.resolve(pending)])).toBe(
          pending
        );
        if (mode !== "already-answered")
          expect(f.runtime.getPermissions(f.id).requests).toEqual([request]);
        f.tap.offline = false;
        expect(await result).toBe(mode === "matches" ? "answered" : uncertain);
        expect(
          f.commands.filter((m) => m.type === "answer_permission")
        ).toHaveLength(mode === "matches" ? 2 : 1);
        const consumed = mode === "matches" || mode === "already-answered";
        if (consumed) await turn.settled;
        expect(existsSync(path.join(f.folder, "protected-action"))).toBe(
          consumed
        );
      } finally {
        await f.close();
      }
    }
  );

  it("keeps steering queued during the update and never resends an in-flight steer", async () => {
    const f = await updateFixture({ bin: fakeAgent });
    try {
      const active = f.runtime.prompt(f.id, "permission-test");
      await active.accepted;
      await until(() => f.runtime.getPermissions(f.id).requests.length === 1);
      const [permission] = f.runtime.getPermissions(f.id).requests;
      let dropped = false;
      f.tap.outbound = (message) => {
        if (message.type === "steer" && !dropped)
          void f.holds.begin("update-runner", attempt);
      };
      f.tap.inbound = (message, drop) => {
        if (message.type === "steer_result" && !dropped) {
          dropped = true;
          drop();
          return false;
        }
      };
      const steer = f.runtime.prompt(
        f.id,
        "in flight",
        { source: "chat", chatMessageId: "one" },
        { delivery: "auto" }
      );
      await expect(steer.accepted).rejects.toThrow(uncertain);
      const queued = f.runtime.prompt(
        f.id,
        "queue this",
        { source: "chat", chatMessageId: "two" },
        { delivery: "auto", alone: true }
      );
      const promoted = f.runtime.prompt(
        f.id,
        "send this",
        { source: "chat", chatMessageId: "three" },
        { alone: true }
      );
      expect(f.runtime.controlQueuedPrompt([f.id], "three", "send-now")).toBe(
        true
      );
      f.tap.offline = false;
      await until(() => f.runtime.getPermissions(f.id).connected);
      expect(f.runtime.hasOpenTurn(f.id)).toBe(true);
      await f.holds.release("update-runner", attempt, "committed");
      await f.runtime.answerPermission(f.id, permission!.id, "once");
      await active.settled;
      await queued.accepted;
      await queued.settled;
      await promoted.accepted;
      await promoted.settled;
      expect(f.commands.filter((m) => m.type === "steer")).toHaveLength(1);
      expect(f.commands.filter((m) => m.type === "prompt")).toHaveLength(3);
      expect(
        f.seen.filter(({ event }) => event.type === "steered")
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("defers steering if the update hold begins during submission preparation", async () => {
    const f = await updateFixture({ bin: fakeAgent });
    try {
      const active = f.runtime.prompt(f.id, "permission-test");
      await active.accepted;
      await until(() => f.runtime.getPermissions(f.id).requests.length === 1);
      const [permission] = f.runtime.getPermissions(f.id).requests;
      const preparing = Promise.withResolvers<void>();
      const submit = Promise.withResolvers<boolean>();
      const queued = f.runtime.prompt(
        f.id,
        "keep this queued",
        { source: "chat", chatMessageId: "preparing" },
        {
          delivery: "auto",
          async beforeSubmit() {
            preparing.resolve();
            return submit.promise;
          },
        }
      );
      await preparing.promise;
      await f.holds.begin("update-runner", attempt);
      submit.resolve(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await f.holds.release("update-runner", attempt, "committed");
      await f.runtime.answerPermission(f.id, permission!.id, "once");
      await active.settled;
      await queued.accepted;
      await queued.settled;
      expect(f.commands.filter((m) => m.type === "steer")).toEqual([]);
      expect(f.commands.filter((m) => m.type === "prompt")).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it("replays a remote prompt receipt after a lost acknowledgement without invoking the provider again", async () => {
    const id = "agt_host_receipt";
    const { runtime } = runtimeWith(stateRoot, () => 0, null, {
      bin: "bun",
      args: [path.join(here, "helpers/remote-acp-fixture.ts")],
    });
    const launch = launchFor(id, cwd);
    const token = "reauthentication-is-not-required-on-attach";
    launch.mcp = { url: "https://127.0.0.1:1/service", token };
    await runtime.launch(launch);
    const dir = path.join(stateRoot, id);
    async function attach() {
      const messages: HostMessage[] = [];
      const socket = net.createConnection(path.join(dir, "host.sock"));
      const decode = ndjsonDecoder<HostMessage>();
      socket.on("data", (chunk) => messages.push(...decode(chunk)));
      await once(socket, "connect");
      socket.write(
        encodeMessage({ type: "hello", fromSeq: 0, replayComplete: true })
      );
      await until(() =>
        messages.some((message) => message.type === "replay_complete")
      );
      return { socket, messages };
    }
    const first = await attach();
    const welcome = first.messages.find(
      (message) => message.type === "welcome"
    )!;
    expect(welcome.hostBuild).toBeUndefined();
    expect(welcome.hostInstanceId).toBeUndefined();
    for (const [id, fields] of [
      ["malformed-image", { images: [{ path: true, mimeType: "image/png" }] }],
      [
        "malformed-source",
        {
          source: {
            source: "chat",
            chatMessageId: "post:1",
            conversation: { streamId: "stream:1" },
          },
        },
      ],
    ] as const) {
      first.socket.write(
        encodeMessage({
          type: "prompt",
          id,
          text: "proof-count",
          journalId: welcome.journalId,
          ...fields,
        })
      );
      await until(() =>
        first.messages.some(
          (message) =>
            message.type === "error" &&
            message.id === id &&
            message.message === "Invalid host command."
        )
      );
    }
    const command = {
      type: "prompt",
      id: "first-operation",
      text: "proof-count proof-delay:150",
      journalId: welcome.journalId,
    };
    // Keep the write but discard the response, as a transport that loses the ack.
    first.socket.removeAllListeners("data");
    first.socket.write(encodeMessage(command));
    await until(() => {
      try {
        return readFileSync(path.join(dir, "journal.jsonl"), "utf8").includes(
          '"state":"settled"'
        );
      } catch {
        return false;
      }
    });
    first.socket.destroy();

    const second = await attach();
    try {
      second.socket.write(encodeMessage(command));
      await until(() =>
        second.messages.some((message) => message.type === "prompt_accepted")
      );
      expect(readFileSync(path.join(cwd, "provider-invocations"), "utf8")).toBe(
        "called\n"
      );
      const turns = second.messages.flatMap((message) =>
        message.type === "event" && message.event.type === "turn"
          ? [message.event.state]
          : []
      );
      expect(turns).toEqual(["started", "settled"]);
      expect(JSON.stringify(second.messages)).not.toContain(token);
    } finally {
      second.socket.destroy();
      await runtime.stop(id, true);
    }
  }, 15_000);

  it("reads structured inventory through the host and runtime without journalling a turn", async () => {
    const id = "agt_host_inventory";
    const { runtime, seen } = runtimeWith(stateRoot, () => 0);
    expect((await runtime.getMcpInventory(id)).status).toBe("offline");
    await runtime.launch(launchFor(id, cwd));
    try {
      const turns = () =>
        seen.filter(
          (event) =>
            event.event.type === "turn" && event.event.state === "started"
        ).length;
      const before = turns();
      expect(await runtime.getMcpInventory(id)).toEqual({
        agentId: id,
        status: "ok",
        inventory: {
          version: 1,
          servers: [
            {
              name: "owned-test-server",
              state: "connected",
              toolsState: "known",
              tools: [{ name: "read", description: "Owned test tool" }],
            },
          ],
        },
      });
      expect(turns()).toBe(before);
      expect((await runtime.getMcpInventory("other-agent")).status).toBe(
        "offline"
      );
    } finally {
      await runtime.stop(id, false);
    }
    expect((await runtime.getMcpInventory(id)).status).toBe("offline");
  }, 60_000);

  it("sets a config option on the live session and survives a reattach", async () => {
    const id = "agt_host_cfg";
    const first = runtimeWith(stateRoot, () => 0);
    await first.runtime.launch(launchFor(id, cwd));
    const model = () =>
      first.runtime.getConfigOptions(id)?.find((o) => o.id === "model");
    await until(() => model() !== undefined);
    expect(model()?.currentValue).toBe("default-model");

    const options = await first.runtime.setConfigOption(
      id,
      "model",
      "other-model"
    );
    expect(options.find((o) => o.id === "model")?.currentValue).toBe(
      "other-model"
    );
    expect(model()?.currentValue).toBe("other-model");
    // The engine's config event follows, so the server records the model.
    await until(() =>
      first.seen.some(
        (s) =>
          s.event.type === "config" &&
          s.event.options.some(
            (o) => o.id === "model" && o.currentValue === "other-model"
          )
      )
    );

    // A server that reattaches learns the options from the welcome.
    const second = runtimeWith(stateRoot, () =>
      Math.max(...first.seen.map((s) => s.seq))
    );
    expect(await second.runtime.attach(id)).toBe(true);
    expect(
      second.runtime.getConfigOptions(id)?.find((o) => o.id === "model")
        ?.currentValue
    ).toBe("other-model");

    await second.runtime.stop(id, false);
  }, 60_000);

  it("recovers a replaced journal even when the stored sequence is far ahead", async () => {
    const id = "agt_reset";
    const stateDir = path.join(stateRoot, id);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "journal.jsonl"), "");
    writeFileSync(path.join(stateDir, "journal.id"), "previous-journal\n");
    const { runtime, seen, synced } = runtimeWith(
      stateRoot,
      () => 22_974,
      "previous-journal"
    );
    await runtime.launch(launchFor(id, cwd));
    expect(
      readFileSync(path.join(stateDir, "journal.id"), "utf8").trim()
    ).not.toBe("previous-journal");
    const turn = runtime.prompt(id, "can you hear me?");
    await Promise.race([
      turn.accepted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("accept timed out")), 10_000)
      ),
    ]);
    await Promise.race([
      turn.settled,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("settle timed out")), 10_000)
      ),
    ]);
    await until(() =>
      seen.some(
        (item) => item.event.type === "turn" && item.event.state === "settled"
      )
    );
    expect(seen.map((item) => item.seq)).toEqual(
      seen.map((_, index) => index + 1)
    );
    expect(synced).toContainEqual({
      journalId: expect.any(String),
      reset: true,
    });
    expect(runtime.isBusy(id)).toBe(false);
    await runtime.stop(id, false);
  }, 60_000);

  it("keeps an intact journal's identity when its sidecar is deleted", async () => {
    const id = "agt_sidecar";
    const first = runtimeWith(stateRoot, () => 0);
    await first.runtime.launch(launchFor(id, cwd));
    await first.runtime.prompt(id, "before restart").settled;
    await until(() =>
      first.seen.some(
        (item) => item.event.type === "turn" && item.event.state === "settled"
      )
    );
    const lastSeq = Math.max(...first.seen.map((item) => item.seq));
    const idFile = path.join(stateRoot, id, "journal.id");
    const journalId = readFileSync(idFile, "utf8").trim();
    await first.runtime.stop(id, false);
    rmSync(idFile);

    const second = runtimeWith(stateRoot, () => lastSeq, journalId);
    await second.runtime.launch(launchFor(id, cwd));
    await until(() => readFileSync(idFile, "utf8").trim() === journalId);
    expect(second.synced.some((item) => item.reset)).toBe(false);
    expect(second.seen.every((item) => item.seq > lastSeq)).toBe(true);
    await second.runtime.stop(id, false);

    writeFileSync(idFile, "");
    const third = runtimeWith(stateRoot, () => lastSeq, journalId);
    await third.runtime.launch(launchFor(id, cwd));
    expect(readFileSync(idFile, "utf8").trim()).toBe(journalId);
    expect(third.synced.some((item) => item.reset)).toBe(false);
    await third.runtime.stop(id, false);
  }, 60_000);

  it("fails a launch whose engine CLI cannot be found instead of falling back to the adapter's own", async () => {
    const { runtime } = runtimeWith(stateRoot, () => 0, null, null);
    await expect(
      runtime.launch({
        ...launchFor("agt_host_test_nocli", cwd),
        engine: "codex",
        // The real adapter, and no codex: what a service with no codex on
        // its PATH used to launch against codex-acp's bundled copy.
        bins: { claudeBin: "claude", codexBin: null },
      })
    ).rejects.toThrow(/Could not find the codex CLI/);
    expect(await runtime.isAlive("agt_host_test_nocli")).toBe(false);
  }, 60_000);

  it("fails the launch, with the host log, when the adapter cannot start", async () => {
    const { runtime } = runtimeWith(stateRoot, () => 0, null, {
      bin: "/definitely/not/a/binary",
    });
    await expect(
      runtime.launch(launchFor("agt_host_test_2", cwd))
    ).rejects.toThrow(/engine failed|not executable|Host log/);
    expect(await runtime.isAlive("agt_host_test_2")).toBe(false);
  }, 60_000);
});
