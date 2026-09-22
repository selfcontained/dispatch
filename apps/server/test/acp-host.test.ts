/**
 * The agent host end to end: a real `dispatch agent-host` process (bun
 * running src/main.ts) driving the fake ACP agent from e2e/fixtures, with
 * the server-side AcpRuntime on the other end of its socket. Covers what
 * the design promises and unit tests cannot: a host that outlives its
 * client, replay from a sequence number, and a clean stop.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DriverEvent } from "../src/agents/acp/driver.js";
import { createAcpRuntime } from "../src/agents/acp/runtime.js";
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
  hostSeq: () => number
): { runtime: AgentRuntime; seen: Seen[] } {
  const seen: Seen[] = [];
  const runtime = createAcpRuntime({
    config: {
      agentStateRoot: stateRoot,
      agentRuntime: "acp",
      dispatchBinDir: path.join(repoRoot, "bin"),
    },
    logger,
    hostSeq: async () => hostSeq(),
  });
  runtime.onEvent((agentId, event, seq) => {
    seen.push({ agentId, event, seq });
  });
  return { runtime, seen };
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
      // Stands a fake engine in place of the adapter this binary carries.
      adapter: { bin: fakeAgent },
    },
    systemPrompt: "Be brief.",
    mcp: { url: "http://127.0.0.1:1/api/mcp/agt_1", token: "tok" },
    env: {},
    pathPrefix: [],
    resumeSessionId: null,
  };
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
    stateRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-host-state-"));
    cwd = mkdtempSync(path.join(os.tmpdir(), "dispatch-host-cwd-"));
    process.env.DISPATCH_AGENT_HOST_COMMAND = JSON.stringify([
      process.execPath.includes("bun") ? process.execPath : "bun",
      mainTs,
      "agent-host",
    ]);
  });

  afterAll(() => {
    delete process.env.DISPATCH_AGENT_HOST_COMMAND;
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("launches, runs a turn, survives its client, replays, and stops", async () => {
    // A first "server": launch and run one turn.
    const first = runtimeWith(stateRoot, () => 0);
    const session = await first.runtime.launch(launchFor(agentId, cwd));
    expect(session.sessionId).toMatch(/^fake_claude_/);
    expect(await first.runtime.isAlive(agentId)).toBe(true);
    expect(await first.runtime.hostPid(agentId)).toBeGreaterThan(0);
    expect(await first.runtime.listHosted()).toEqual([agentId]);

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

    // Stop: the host exits and its pid and socket go away.
    await third.runtime.stop(agentId, false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await third.runtime.isAlive(agentId)).toBe(false);
    expect(await third.runtime.listHosted()).toEqual([]);
  }, 60_000);

  it("fails a launch whose engine CLI cannot be found instead of falling back to the adapter's own", async () => {
    const { runtime } = runtimeWith(stateRoot, () => 0);
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
    const { runtime } = runtimeWith(stateRoot, () => 0);
    await expect(
      runtime.launch({
        ...launchFor("agt_host_test_2", cwd),
        bins: {
          claudeBin: "claude",
          codexBin: null,
          adapter: { bin: "/definitely/not/a/binary" },
        },
      })
    ).rejects.toThrow(/engine failed|not executable|Host log/);
    expect(await runtime.isAlive("agt_host_test_2")).toBe(false);
  }, 60_000);
});
