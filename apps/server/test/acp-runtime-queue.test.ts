/**
 * The runtime's prompt queue against a scripted host on a real socket,
 * where the test decides how the host's messages are framed on the wire.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodeMessage,
  hostFile,
  ndjsonDecoder,
  type ClientMessage,
  type HostMessage,
} from "../src/agents/acp/host-protocol.js";
import type { PromptSource } from "../src/agents/acp/prompt-source.js";
import {
  COMBINE_MAX_CHARS,
  COMBINE_MAX_PROMPTS,
  createAcpRuntime,
} from "../src/agents/acp/runtime.js";

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

const agentId = "agt_queue_test";
let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const run of cleanup.splice(0)) run();
});

/**
 * A host that answers every prompt with a turn that fails at once, its
 * ack and both turn events written to the socket in a single chunk.
 */
async function fastFailingHost(): Promise<{
  stateRoot: string;
  prompts: string[];
}> {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-queue-"));
  const dir = path.join(stateRoot, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(hostFile(dir, "pid"), String(process.pid));
  const prompts: string[] = [];
  let seq = 0;
  const event = (e: unknown): HostMessage =>
    ({
      type: "event",
      seq: ++seq,
      at: new Date().toISOString(),
      event: e,
    }) as HostMessage;
  const server = net.createServer((socket) => {
    const decode = ndjsonDecoder<ClientMessage>();
    socket.on("data", (chunk) => {
      for (const message of decode(chunk)) {
        if (message.type === "hello") {
          socket.write(
            encodeMessage({
              type: "welcome",
              agentId,
              engine: "claude",
              sessionId: "sess",
              resumed: false,
              running: true,
              turn: null,
              journalSeq: seq,
            } satisfies HostMessage)
          );
        } else if (message.type === "prompt") {
          prompts.push(message.text);
          socket.write(
            [
              event({
                type: "turn",
                agentId,
                state: "started",
                text: message.text,
              }),
              { type: "prompt_accepted", id: message.id } satisfies HostMessage,
              event({
                type: "turn",
                agentId,
                state: "settled",
                error: "API Error: 500",
                errorKind: "server_error",
              }),
            ]
              .map(encodeMessage)
              .join("")
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(hostFile(dir, "socket"), resolve)
  );
  cleanup.push(() => {
    server.close();
    rmSync(stateRoot, { recursive: true, force: true });
  });
  return { stateRoot, prompts };
}

describe("AcpRuntime prompt queue", () => {
  it("takes the next prompt after a turn whose ack and settle arrive together", async () => {
    const { stateRoot, prompts } = await fastFailingHost();
    const runtime = createAcpRuntime({
      config: {
        agentStateRoot: stateRoot,
        agentRuntime: "acp",
        dispatchBinDir: "/nonexistent",
      },
      logger,
      hostSeq: async () => ({ seq: 0, journalId: null }),
      syncJournal: async () => {},
    });
    // No runtime.stop: the pid file names this test process.
    expect(await runtime.attach(agentId)).toBe(true);

    const first = runtime.prompt(agentId, "one");
    await first.accepted;
    await first.settled;
    expect(runtime.isBusy(agentId)).toBe(false);

    // The turn is over, so the next prompt goes straight to the host
    // rather than waiting on a settle that already happened.
    const second = runtime.prompt(agentId, "two");
    await Promise.race([
      second.accepted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("second prompt never sent")), 2_000)
      ),
    ]);
    expect(prompts).toEqual(["one", "two"]);
  });
});

describe("AcpRuntime legacy host replay", () => {
  it("reconnects with sequence zero when an old host's journal is behind the stored cursor", async () => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-legacy-"));
    const dir = path.join(stateRoot, agentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(hostFile(dir, "pid"), String(process.pid));
    const hellos: number[] = [];
    const entries: HostMessage[] = [
      {
        type: "event",
        seq: 1,
        at: new Date().toISOString(),
        event: {
          type: "turn",
          agentId,
          state: "started",
          text: "old turn",
        },
      },
      {
        type: "event",
        seq: 2,
        at: new Date().toISOString(),
        event: {
          type: "turn",
          agentId,
          state: "settled",
        },
      },
    ];
    const server = net.createServer((socket) => {
      const decode = ndjsonDecoder<ClientMessage>();
      socket.on("data", (chunk) => {
        for (const message of decode(chunk)) {
          if (message.type !== "hello") continue;
          hellos.push(message.fromSeq);
          socket.write(
            encodeMessage({
              type: "welcome",
              agentId,
              engine: "claude",
              sessionId: "legacy",
              resumed: true,
              running: true,
              turn: null,
              journalSeq: 2,
              commands: [],
            } satisfies HostMessage)
          );
          for (const entry of entries) {
            if (entry.type === "event" && entry.seq > message.fromSeq) {
              socket.write(encodeMessage(entry));
            }
          }
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(hostFile(dir, "socket"), resolve)
    );
    cleanup.push(() => {
      server.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });
    const seen: number[] = [];
    const syncs: boolean[] = [];
    const runtime = createAcpRuntime({
      config: {
        agentStateRoot: stateRoot,
        agentRuntime: "acp",
        dispatchBinDir: "/nonexistent",
      },
      logger,
      hostSeq: async () => ({ seq: 10, journalId: null }),
      syncJournal: async (_id, _journalId, reset) => {
        syncs.push(reset);
      },
    });
    runtime.onEvent((_id, _event, seq) => seen.push(seq));
    expect(await runtime.attach(agentId)).toBe(true);
    await untilPrompts(seen, 2);
    expect(hellos).toEqual([10, 0]);
    expect(syncs).toEqual([true]);
    expect(seen).toEqual([1, 2]);
  });
});

/**
 * A host whose turns stay open until the test settles them, so prompts can
 * be queued behind a running turn.
 */
async function heldTurnHost(
  steering?: "injected" | "promptRequired" | "error"
): Promise<{
  steers: string[];
  cancels: () => number;
  stateRoot: string;
  prompts: Array<{ text: string; source?: PromptSource }>;
  settle: () => void;
}> {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-queue-"));
  const dir = path.join(stateRoot, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(hostFile(dir, "pid"), String(process.pid));
  const prompts: Array<{ text: string; source?: PromptSource }> = [];
  const steers: string[] = [];
  let cancelCount = 0;
  let seq = 0;
  let live: net.Socket | null = null;
  const event = (e: unknown): HostMessage =>
    ({
      type: "event",
      seq: ++seq,
      at: new Date().toISOString(),
      event: e,
    }) as HostMessage;
  const server = net.createServer((socket) => {
    live = socket;
    const decode = ndjsonDecoder<ClientMessage>();
    socket.on("data", (chunk) => {
      for (const message of decode(chunk)) {
        if (message.type === "hello") {
          socket.write(
            encodeMessage({
              type: "welcome",
              agentId,
              engine: "claude",
              sessionId: "sess",
              resumed: false,
              running: true,
              steeringSupported: !!steering,
              turn: null,
              journalSeq: seq,
            } satisfies HostMessage)
          );
        } else if (message.type === "cancel") {
          cancelCount++;
        } else if (message.type === "steer") {
          steers.push(message.text);
          if (steering === "promptRequired") {
            socket.write(
              encodeMessage(event({ type: "turn", agentId, state: "settled" }))
            );
          }
          socket.write(
            encodeMessage(
              steering === "error"
                ? { type: "error", id: message.id, message: "unconfirmed" }
                : {
                    type: "steer_result",
                    id: message.id,
                    outcome: steering ?? "promptRequired",
                  }
            )
          );
        } else if (message.type === "prompt") {
          prompts.push({
            text: message.text,
            ...(message.source ? { source: message.source } : {}),
          });
          socket.write(
            [
              event({
                type: "turn",
                agentId,
                state: "started",
                text: message.text,
              }),
              { type: "prompt_accepted", id: message.id } satisfies HostMessage,
            ]
              .map(encodeMessage)
              .join("")
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(hostFile(dir, "socket"), resolve)
  );
  cleanup.push(() => {
    server.close();
    rmSync(stateRoot, { recursive: true, force: true });
  });
  const settle = () => {
    live?.write(
      encodeMessage(event({ type: "turn", agentId, state: "settled" }))
    );
  };
  return { stateRoot, prompts, settle, steers, cancels: () => cancelCount };
}

function withinSeconds<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out`)), 2_000)
    ),
  ]);
}

async function attached(stateRoot: string) {
  const runtime = createAcpRuntime({
    config: {
      agentStateRoot: stateRoot,
      agentRuntime: "acp",
      dispatchBinDir: "/nonexistent",
    },
    logger,
    hostSeq: async () => ({ seq: 0, journalId: null }),
    syncJournal: async () => {},
  });
  // No runtime.stop: the pid file names this test process.
  expect(await runtime.attach(agentId)).toBe(true);
  return runtime;
}

const post = (n: number): PromptSource => ({
  source: "chat",
  chatMessageId: `00000000-0000-4000-8000-00000000000${n}`,
});
const envelope = (n: number, body = `note ${n}`) =>
  `--- DISPATCH POST (id: ${(post(n) as { chatMessageId: string }).chatMessageId}, from: user) ---\n${body}\n--- END DISPATCH POST ---`;

async function untilPrompts(prompts: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (prompts.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} prompts, saw ${prompts.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("AcpRuntime combining queued posts", () => {
  it("delivers posts queued behind a running turn as one prompt", async () => {
    const { stateRoot, prompts, settle } = await heldTurnHost();
    const runtime = await attached(stateRoot);

    const work = runtime.prompt(agentId, "do the work", {
      source: "system",
      text: "do the work",
    });
    await withinSeconds(work.accepted, "the work");
    const one = runtime.prompt(agentId, envelope(1), post(1));
    const two = runtime.prompt(agentId, envelope(2), post(2));

    settle();
    await withinSeconds(work.settled, "the work's settle");
    await withinSeconds(one.accepted, "the first post accepted");
    // Were they separate, the second would wait for this settle and go as
    // a call of its own.
    settle();
    await withinSeconds(two.accepted, "the second post accepted");
    expect(prompts.map((p) => p.text.slice(0, 60))).toHaveLength(2);
    const combined = prompts[1]!;
    expect(combined.text.indexOf(envelope(1))).toBeGreaterThan(-1);
    expect(combined.text.indexOf(envelope(2))).toBeGreaterThan(
      combined.text.indexOf(envelope(1))
    );
    expect(combined.source).toEqual({
      source: "chat",
      chatMessageId: post(1).source === "chat" ? post(1).chatMessageId : "",
      chatMessageIds: [post(1), post(2)].map((p) =>
        p.source === "chat" ? p.chatMessageId : ""
      ),
    });

    await withinSeconds(
      Promise.all([one.settled, two.settled]),
      "both posts settled"
    );
    expect(runtime.isBusy(agentId)).toBe(false);
  });

  it("sends a prompt that arrives while nothing is running alone and unchanged", async () => {
    const { stateRoot, prompts, settle } = await heldTurnHost();
    const runtime = await attached(stateRoot);

    const one = runtime.prompt(agentId, envelope(1), post(1));
    await withinSeconds(one.accepted, "the post");
    expect(prompts).toEqual([{ text: envelope(1), source: post(1) }]);
    settle();
    await withinSeconds(one.settled, "the post's settle");
  });

  it("does not combine a prompt sent to interrupt", async () => {
    const { stateRoot, prompts, settle } = await heldTurnHost();
    const runtime = await attached(stateRoot);

    const work = runtime.prompt(agentId, "do the work");
    await withinSeconds(work.accepted, "the work");
    const one = runtime.prompt(agentId, envelope(1), post(1));
    const two = runtime.prompt(agentId, envelope(2), post(2));
    const cut = runtime.prompt(agentId, envelope(3), post(3), {
      alone: true,
    });
    const four = runtime.prompt(agentId, envelope(4), post(4));

    settle();
    await withinSeconds(
      Promise.all([one.accepted, two.accepted]),
      "the posts ahead of it"
    );
    expect(prompts).toHaveLength(2);
    settle();
    await withinSeconds(cut.accepted, "the interrupting post");
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toEqual({ text: envelope(3), source: post(3) });
    settle();
    await withinSeconds(four.accepted, "the post behind it");
    expect(prompts[3]).toEqual({ text: envelope(4), source: post(4) });
    settle();
    await withinSeconds(four.settled, "the last settle");
  });

  it("keeps prompts that are not posts on their own", async () => {
    const { stateRoot, prompts, settle } = await heldTurnHost();
    const runtime = await attached(stateRoot);

    const work = runtime.prompt(agentId, "do the work");
    await withinSeconds(work.accepted, "the work");
    const one = runtime.prompt(agentId, envelope(1), post(1));
    const nudge = runtime.prompt(agentId, "a job's nudge", {
      source: "system",
      text: "a job's nudge",
    });
    const two = runtime.prompt(agentId, envelope(2), post(2));
    const three = runtime.prompt(agentId, envelope(3), post(3));

    for (let i = 0; i < 3; i++) (settle(), await untilPrompts(prompts, i + 2));
    await withinSeconds(
      Promise.all([one.accepted, nudge.accepted, two.accepted, three.accepted]),
      "all accepted"
    );
    expect(prompts.map((p) => p.text)).toEqual([
      "do the work",
      envelope(1),
      "a job's nudge",
      expect.stringContaining(envelope(2)),
    ]);
    expect(prompts[3]!.text).toContain(envelope(3));
    settle();
    await withinSeconds(three.settled, "the last settle");
  });

  it("carries a backlog past the cap into the next turn, dropping nothing", async () => {
    const { stateRoot, prompts, settle } = await heldTurnHost();
    const runtime = await attached(stateRoot);

    const work = runtime.prompt(agentId, "do the work");
    await withinSeconds(work.accepted, "the work");
    const total = COMBINE_MAX_PROMPTS + 2;
    const queued = Array.from({ length: total }, (_, i) =>
      runtime.prompt(agentId, envelope(i % 10, `note ${i}`), post(i % 10))
    );

    settle();
    await untilPrompts(prompts, 2);
    settle();
    await untilPrompts(prompts, 3);
    await withinSeconds(
      Promise.all(queued.map((q) => q.accepted)),
      "every post accepted"
    );
    settle();
    await withinSeconds(
      Promise.all(queued.map((q) => q.settled)),
      "every post settled"
    );
    expect(prompts).toHaveLength(3);
    const body = prompts
      .slice(1)
      .map((p) => p.text)
      .join("\n");
    for (let i = 0; i < total; i++) {
      expect(body).toContain(`note ${i}\n`);
    }
    const first = prompts[1]!.source as { chatMessageIds?: string[] };
    expect(first.chatMessageIds).toHaveLength(COMBINE_MAX_PROMPTS);
  });

  it("holds the combined text under the size cap", async () => {
    const { stateRoot, prompts, settle } = await heldTurnHost();
    const runtime = await attached(stateRoot);

    const work = runtime.prompt(agentId, "do the work");
    await withinSeconds(work.accepted, "the work");
    // Two of these fit under the cap with their envelopes; three do not.
    const big = "x".repeat(Math.floor(COMBINE_MAX_CHARS * 0.4));
    const queued = [1, 2, 3].map((n) =>
      runtime.prompt(agentId, envelope(n, big), post(n))
    );

    settle();
    await untilPrompts(prompts, 2);
    settle();
    await untilPrompts(prompts, 3);
    await withinSeconds(
      Promise.all(queued.map((q) => q.accepted)),
      "every post accepted"
    );
    expect(prompts[1]!.text).toContain(envelope(1, big));
    expect(prompts[1]!.text).toContain(envelope(2, big));
    expect(prompts[1]!.text.length).toBeLessThanOrEqual(COMBINE_MAX_CHARS);
    expect(prompts[2]).toEqual({ text: envelope(3, big), source: post(3) });
    settle();
  });
});

describe("queued post controls", () => {
  const id = (n: number) =>
    (post(n) as { chatMessageId: string }).chatMessageId;
  it("deletes only an unsent prompt and leaves the remaining queue intact", async () => {
    const host = await heldTurnHost();
    const runtime = await attached(host.stateRoot);
    const first = runtime.prompt(agentId, envelope(1), post(1));
    await first.accepted;
    const removed = runtime.prompt(agentId, envelope(2), post(2));
    const kept = runtime.prompt(agentId, envelope(3), post(3));
    expect(runtime.controlQueuedPrompt([agentId], id(1), "delete")).toBe(false);
    expect(
      runtime.controlQueuedPrompt([agentId, "absent"], id(2), "delete")
    ).toBe(false);
    expect(runtime.controlQueuedPrompt([agentId], id(2), "delete")).toBe(true);
    await expect(removed.accepted).rejects.toThrow("deleted");
    expect(runtime.controlQueuedPrompt([agentId], id(2), "send-now")).toBe(
      false
    );
    host.settle();
    await withinSeconds(kept.accepted, "remaining prompt");
    host.settle();
    await Promise.all([first.settled, removed.settled, kept.settled]);
    expect(host.prompts.map((p) => p.text)).toEqual([envelope(1), envelope(3)]);
  });

  it("prioritizes the selected post alone without losing older waiting posts", async () => {
    const host = await heldTurnHost();
    const runtime = await attached(host.stateRoot);
    const first = runtime.prompt(agentId, envelope(1), post(1));
    await first.accepted;
    const older = runtime.prompt(agentId, envelope(2), post(2));
    const urgent = runtime.prompt(agentId, envelope(3), post(3));
    expect(runtime.controlQueuedPrompt([agentId], id(3), "send-now")).toBe(
      true
    );
    host.settle();
    await withinSeconds(urgent.accepted, "urgent post");
    expect(host.prompts.map((p) => p.text)).toEqual([envelope(1), envelope(3)]);
    host.settle();
    await withinSeconds(older.accepted, "older post");
    host.settle();
    await Promise.all([first.settled, older.settled, urgent.settled]);
    expect(host.prompts.map((p) => p.text)).toEqual([
      envelope(1),
      envelope(3),
      envelope(2),
    ]);
  });
});

describe("AcpRuntime delivery during a turn", () => {
  it("steers consecutive messages while explicit queue waits, without canceling", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work");
    await work.accepted;
    const later = runtime.prompt(agentId, envelope(1), post(1), {
      delivery: "queue",
    });
    const sends = [2, 3].map((n) =>
      runtime.prompt(agentId, envelope(n), post(n), { delivery: "auto" })
    );
    await withinSeconds(Promise.all(sends.map((p) => p.accepted)), "steering");
    expect(host.steers).toEqual([envelope(2), envelope(3)]);
    expect(host.prompts).toHaveLength(1);
    expect(host.cancels()).toBe(0);
    let finished = false;
    void sends[0]!.settled.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    host.settle();
    await withinSeconds(later.accepted, "queued post");
    host.settle();
    await Promise.all([
      work.settled,
      later.settled,
      ...sends.map((p) => p.settled),
    ]);
  });

  it("starts exactly one tracked prompt when the engine wins the idle race", async () => {
    const host = await heldTurnHost("promptRequired");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work");
    await work.accepted;
    const next = runtime.prompt(agentId, envelope(1), post(1), {
      delivery: "auto",
    });
    await withinSeconds(next.accepted, "fallback");
    expect(host.steers).toEqual([envelope(1)]);
    expect(host.prompts.map((p) => p.text)).toEqual(["work", envelope(1)]);
    host.settle();
    await next.settled;
    expect(host.cancels()).toBe(0);
  });

  it("keeps messages queued with an older host that does not advertise steering", async () => {
    const host = await heldTurnHost();
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work");
    await work.accepted;
    const next = runtime.prompt(agentId, envelope(1), post(1), {
      delivery: "auto",
    });
    expect(host.steers).toEqual([]);
    expect(host.prompts).toHaveLength(1);
    host.settle();
    await withinSeconds(next.accepted, "old host fallback");
    host.settle();
    await next.settled;
  });

  it("promotes a queued post into the running turn without canceling", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work");
    await work.accepted;
    const next = runtime.prompt(agentId, envelope(1), post(1));
    expect(
      runtime.controlQueuedPrompt(
        [agentId],
        (post(1) as { chatMessageId: string }).chatMessageId,
        "send-now"
      )
    ).toBe(true);
    await withinSeconds(next.accepted, "promotion");
    expect(host.steers).toEqual([envelope(1)]);
    expect(host.cancels()).toBe(0);
    host.settle();
    await next.settled;
  });

  it("does not resend a steer whose delivery failed ambiguously", async () => {
    const host = await heldTurnHost("error");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work");
    await work.accepted;
    const next = runtime.prompt(agentId, envelope(1), post(1), {
      delivery: "auto",
    });
    await expect(next.accepted).rejects.toThrow("unconfirmed");
    host.settle();
    await next.settled;
    expect(host.prompts).toHaveLength(1);
    expect(host.steers).toHaveLength(1);
  });
});
