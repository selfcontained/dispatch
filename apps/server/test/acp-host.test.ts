/**
 * The agent host end to end: a real `dispatch agent-host` process (bun
 * running src/main.ts) driving the fake ACP agent from e2e/fixtures, with
 * the server-side AcpRuntime on the other end of its socket. Covers what
 * the design promises and unit tests cannot: a host that outlives its
 * client, replay from a sequence number, and a clean stop.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DriverEvent } from "../src/agents/acp/driver.js";
import { createAcpRuntime } from "../src/agents/acp/runtime.js";
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
  journalId: string | null = null
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
      dispatchBinDir: path.join(repoRoot, "bin"),
    },
    logger,
    hostSeq: async () => ({ seq: hostSeq(), journalId }),
    syncJournal: async (_agentId, id, reset) => {
      synced.push({ journalId: id, reset });
    },
  });
  runtime.onEvent((agentId, event, seq) => {
    seen.push({ agentId, event, seq });
  });
  return { runtime, seen, synced };
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
      trimmedGuidance: false,
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
