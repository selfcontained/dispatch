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
import type {
  PromptSource,
  PromptImage,
} from "../src/agents/acp/prompt-source.js";
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
                source: message.source,
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
  steering?: "injected" | "promptRequired" | "error",
  interrupt?: "supported" | "error" | "deferred"
): Promise<{
  steers: string[];
  cancels: () => number;
  interruptTargets: number[];
  finishInterrupt: () => void;
  rejectInterrupt: () => void;
  disconnect: () => void;
  stateRoot: string;
  prompts: Array<{
    text: string;
    source?: PromptSource;
    images?: PromptImage[];
  }>;
  settle: () => void;
}> {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-queue-"));
  const dir = path.join(stateRoot, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(hostFile(dir, "pid"), String(process.pid));
  const prompts: Array<{
    text: string;
    source?: PromptSource;
    images?: PromptImage[];
  }> = [];
  const steers: string[] = [];
  let cancelCount = 0;
  const interruptTargets: number[] = [];
  let finishInterrupt = () => {};
  let rejectInterrupt = () => {};
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
              interruptSupported: !!interrupt,
              turn: null,
              journalSeq: seq,
            } satisfies HostMessage)
          );
        } else if (message.type === "interrupt") {
          cancelCount++;
          interruptTargets.push(message.turnSeq);
          rejectInterrupt = () =>
            socket.write(
              encodeMessage({
                type: "error",
                id: message.id,
                message: "cancel rejected",
              })
            );
          finishInterrupt = () =>
            socket.write(
              encodeMessage(
                interrupt === "error"
                  ? {
                      type: "error",
                      id: message.id,
                      message: "cancel rejected",
                    }
                  : { type: "interrupt_result", id: message.id }
              )
            );
          if (interrupt !== "deferred") finishInterrupt();
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
            ...(message.images ? { images: message.images } : {}),
          });
          socket.write(
            [
              event({
                type: "turn",
                agentId,
                state: "started",
                text: message.text,
                source: message.source,
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
  return {
    stateRoot,
    prompts,
    settle,
    steers,
    cancels: () => cancelCount,
    interruptTargets,
    finishInterrupt: () => finishInterrupt(),
    rejectInterrupt: () => rejectInterrupt(),
    disconnect: () => live?.destroy(),
  };
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
  conversation: { streamId: agentId, threadId: null },
  userMessage: true,
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
    const images = [
      { path: "/tmp/one.png", mimeType: "image/png" },
      { path: "/tmp/two.jpg", mimeType: "image/jpeg" },
    ];
    const one = runtime.prompt(agentId, envelope(1), post(1), {
      images: [images[0]!],
    });
    const two = runtime.prompt(agentId, envelope(2), post(2), {
      images: [images[1]!],
    });

    settle();
    await withinSeconds(work.settled, "the work's settle");
    await withinSeconds(one.accepted, "the first post accepted");
    // Were they separate, the second would wait for this settle and go as
    // a call of its own.
    settle();
    await withinSeconds(two.accepted, "the second post accepted");
    expect(prompts.map((p) => p.text.slice(0, 60))).toHaveLength(2);
    const combined = prompts[1]!;
    expect(combined.images).toEqual(images);
    expect(combined.text.indexOf(envelope(1))).toBeGreaterThan(-1);
    expect(combined.text.indexOf(envelope(2))).toBeGreaterThan(
      combined.text.indexOf(envelope(1))
    );
    expect(combined.source).toEqual({
      ...post(1),
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
    const images = [
      { path: "/tmp/one.png", mimeType: "image/png" },
      { path: "/tmp/two.jpg", mimeType: "image/jpeg" },
    ];
    const one = runtime.prompt(agentId, envelope(1), post(1), {
      images: [images[0]!],
    });
    const two = runtime.prompt(agentId, envelope(2), post(2), {
      images: [images[1]!],
    });
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

  it("interrupts the running turn for a queued post and opens it alone next", async () => {
    const host = await heldTurnHost("injected", "supported");
    const runtime = await attached(host.stateRoot);
    const active = runtime.prompt(agentId, "active", post(0));
    await active.accepted;
    const older = runtime.prompt(agentId, envelope(1), post(1), {
      delivery: "queue",
    });
    const urgent = runtime.prompt(agentId, envelope(2), post(2), {
      delivery: "queue",
    });
    expect(host.cancels()).toBe(0);
    expect(runtime.controlQueuedPrompt([agentId], id(2), "interrupt")).toBe(
      true
    );
    await expect.poll(host.cancels).toBe(1);
    expect(host.interruptTargets).toEqual([1]);
    // Already asked for: not asked for twice, and no longer steerable.
    expect(runtime.controlQueuedPrompt([agentId], id(2), "interrupt")).toBe(
      false
    );
    expect(runtime.controlQueuedPrompt([agentId], id(2), "send-now")).toBe(
      false
    );
    expect(host.prompts).toHaveLength(1);
    host.settle();
    await withinSeconds(urgent.accepted, "interrupting post");
    expect(host.prompts.map((p) => p.text)).toEqual(["active", envelope(2)]);
    host.settle();
    await withinSeconds(older.accepted, "older post");
    host.settle();
    await Promise.all([active.settled, older.settled, urgent.settled]);
    expect(host.prompts.map((p) => p.text)).toEqual([
      "active",
      envelope(2),
      envelope(1),
    ]);
    expect(host.cancels()).toBe(1);
  });

  it("refuses to interrupt on a host that cannot stop its turn", async () => {
    const host = await heldTurnHost();
    const runtime = await attached(host.stateRoot);
    const active = runtime.prompt(agentId, "active", post(0));
    await active.accepted;
    const queued = runtime.prompt(agentId, envelope(1), post(1));
    expect(runtime.controlQueuedPrompt([agentId], id(1), "interrupt")).toBe(
      false
    );
    expect(host.cancels()).toBe(0);
    host.settle();
    await withinSeconds(queued.accepted, "queued post still delivered");
    host.settle();
    await Promise.all([active.settled, queued.settled]);
  });
});

describe("AcpRuntime delivery during a turn", () => {
  it("keeps image prompts queued until a turn can carry their images", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work", post(0));
    await work.accepted;
    const image = { path: "/tmp/queued.png", mimeType: "image/png" };
    const next = runtime.prompt(agentId, envelope(1), post(1), {
      delivery: "auto",
      images: [image],
    });
    expect(host.steers).toEqual([]);
    expect(host.prompts).toHaveLength(1);
    host.settle();
    await withinSeconds(next.accepted, "image prompt");
    expect(host.prompts[1]).toEqual({
      text: envelope(1),
      source: post(1),
      images: [image],
    });
    host.settle();
    await Promise.all([work.settled, next.settled]);
  });

  it("steers consecutive messages while explicit queue waits, without canceling", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work", post(0));
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
    const work = runtime.prompt(agentId, "work", post(0));
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
    const work = runtime.prompt(agentId, "work", post(0));
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
    const work = runtime.prompt(agentId, "work", post(0));
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
    const work = runtime.prompt(agentId, "work", post(0));
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

describe("conversation-authoritative delivery", () => {
  const inThread = (
    n: number,
    threadId: string | null,
    userMessage = true
  ): PromptSource => ({
    ...post(n),
    conversation: { streamId: agentId, threadId },
    userMessage,
  });

  it.each([null, "thread-a"])(
    "steers only the exact active conversation (%s)",
    async (threadId) => {
      const host = await heldTurnHost("injected");
      const runtime = await attached(host.stateRoot);
      const work = runtime.prompt(
        agentId,
        "work",
        inThread(0, threadId, false)
      );
      await work.accepted;
      const other = runtime.prompt(
        agentId,
        "other",
        inThread(1, threadId === null ? "thread-a" : null),
        { delivery: "auto" }
      );
      const same = runtime.prompt(agentId, "same", inThread(2, threadId), {
        delivery: "auto",
      });
      await withinSeconds(same.accepted, "same conversation");
      expect(host.steers).toEqual(["same"]);
      expect(
        runtime.controlQueuedPrompt(
          [agentId],
          (post(1) as { chatMessageId: string }).chatMessageId,
          "send-now"
        )
      ).toBe(false);
      host.settle();
      await withinSeconds(other.accepted, "other conversation");
      expect(host.prompts.map((item) => item.text)).toEqual(["work", "other"]);
      host.settle();
      await Promise.all([work.settled, same.settled, other.settled]);
    }
  );

  it("never combines queued sources from different threads, or drops answerIn", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work", inThread(0, null));
    await work.accepted;
    const firstSource = { ...inThread(1, "a"), answerIn: "a" };
    const first = runtime.prompt(agentId, "a1", firstSource, {
      delivery: "queue",
    });
    const second = runtime.prompt(agentId, "a2", inThread(2, "a"), {
      delivery: "queue",
    });
    const third = runtime.prompt(agentId, "b", inThread(3, "b"), {
      delivery: "auto",
    });
    const fourth = runtime.prompt(agentId, "a3", inThread(4, "a"), {
      delivery: "queue",
    });
    host.settle();
    await withinSeconds(
      Promise.all([first.accepted, second.accepted]),
      "thread a batch"
    );
    expect(host.prompts[1]!.source).toMatchObject({
      ...firstSource,
      chatMessageIds: [
        (post(1) as { chatMessageId: string }).chatMessageId,
        (post(2) as { chatMessageId: string }).chatMessageId,
      ],
    });
    expect(host.prompts[1]!.text).not.toContain("a3");
    expect(host.steers).toEqual([]);
    host.settle();
    await withinSeconds(third.accepted, "thread b");
    expect(host.prompts[2]!.text).toBe("b");
    host.settle();
    await withinSeconds(fourth.accepted, "remaining thread a");
    host.settle();
    await Promise.all([
      work.settled,
      first.settled,
      second.settled,
      third.settled,
      fourth.settled,
    ]);
  });

  it("steers what the agent is waiting on into its turn, whatever conversation it is in", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work", inThread(0, null, false));
    await work.accepted;
    // A review, or a finding settled: from an agent, in its own thread.
    const awaited = runtime.prompt(
      agentId,
      "finding fixed",
      {
        ...inThread(1, "finding-a", false),
        awaited: true,
        answerIn: "finding-a",
      },
      { delivery: "auto" }
    );
    await withinSeconds(awaited.accepted, "awaited steering");
    expect(host.steers).toEqual(["finding fixed"]);
    // Sending a queued awaited post now is allowed for the same reason.
    const later = runtime.prompt(
      agentId,
      "review posted",
      { ...inThread(2, "launch-b", false), awaited: true },
      { delivery: "queue" }
    );
    expect(
      runtime.controlQueuedPrompt(
        [agentId],
        (post(2) as { chatMessageId: string }).chatMessageId,
        "send-now"
      )
    ).toBe(true);
    await withinSeconds(later.accepted, "awaited send-now");
    expect(host.steers).toEqual(["finding fixed", "review posted"]);
    host.settle();
    await Promise.all([work.settled, awaited.settled, later.settled]);
  });

  it("scheduled messages steer without cancelling, while cancelled queued schedules never submit", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work", inThread(0, null));
    await work.accepted;
    const scheduled = runtime.prompt(
      agentId,
      "timer",
      { source: "system", text: "timer", scheduleId: "schedule" },
      { delivery: "auto", beforeSubmit: async () => true }
    );
    await withinSeconds(scheduled.accepted, "scheduled steering");
    expect(host.steers).toEqual(["timer"]);
    const controller = new AbortController();
    const cancelled = runtime.prompt(
      agentId,
      "cancelled timer",
      { source: "system", text: "timer", scheduleId: "schedule2" },
      {
        delivery: "queue",
        signal: controller.signal,
        beforeSubmit: async () => false,
      }
    );
    controller.abort();
    await expect(cancelled.accepted).rejects.toThrow("cancelled");
    host.settle();
    await Promise.all([work.settled, scheduled.settled, cancelled.settled]);
    expect(host.prompts).toHaveLength(1);
  });

  it("does not requeue a scheduled message cancelled as steering is declined", async () => {
    const host = await heldTurnHost("promptRequired");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work", inThread(0, null));
    await work.accepted;
    const controller = new AbortController();
    const scheduled = runtime.prompt(
      agentId,
      "timer",
      { source: "system", text: "timer", scheduleId: "schedule" },
      {
        delivery: "auto",
        signal: controller.signal,
        beforeSubmit: async () => true,
        onDeferred: async () => controller.abort(),
      }
    );
    await expect(scheduled.accepted).rejects.toThrow("cancelled");
    await scheduled.settled;
    host.settle();
    await work.settled;
    expect(host.prompts).toHaveLength(1);
  });

  it("steers another agent's post into the open turn, whatever conversation it is in", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work", inThread(0, "thread-a"));
    await work.accepted;
    const { conversation: _none, ...agentPost } = inThread(1, null, false);
    const advice = runtime.prompt(agentId, "advice", agentPost, {
      delivery: "auto",
    });
    await withinSeconds(advice.accepted, "agent post steering");
    expect(host.steers).toEqual(["advice"]);
    host.settle();
    await Promise.all([work.settled, advice.settled]);
  });

  it("an agent's answer resuming a conversation steers only that conversation", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work", inThread(0, "thread-a"));
    await work.accepted;
    const other = runtime.prompt(
      agentId,
      "answer elsewhere",
      inThread(1, "thread-b", false),
      { delivery: "auto" }
    );
    const same = runtime.prompt(
      agentId,
      "answer here",
      inThread(2, "thread-a", false),
      { delivery: "auto" }
    );
    await withinSeconds(same.accepted, "same-conversation answer");
    expect(host.steers).toEqual(["answer here"]);
    host.settle();
    await withinSeconds(other.accepted, "other conversation turn");
    expect(host.prompts.map((item) => item.text)).toEqual([
      "work",
      "answer elsewhere",
    ]);
    host.settle();
    await Promise.all([work.settled, same.settled, other.settled]);
  });

  it("an agent post sent with queue waits for the turn to finish", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work", inThread(0, null));
    await work.accepted;
    const later = runtime.prompt(agentId, "later", inThread(1, null, false), {
      delivery: "queue",
    });
    const system = runtime.prompt(
      agentId,
      "nudge",
      { source: "system", text: "nudge" },
      { delivery: "auto" }
    );
    host.settle();
    await withinSeconds(later.accepted, "queued agent post");
    host.settle();
    await withinSeconds(system.accepted, "system prompt");
    expect(host.steers).toEqual([]);
    expect(host.prompts.map((item) => item.text)).toEqual([
      "work",
      "later",
      "nudge",
    ]);
    host.settle();
    await Promise.all([work.settled, later.settled, system.settled]);
  });

  it("rechecks against the newly started turn when the previous turn settles", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "work", inThread(0, "a"));
    await work.accepted;
    const next = runtime.prompt(agentId, "b", inThread(1, "b"), {
      delivery: "queue",
    });
    const follow = runtime.prompt(agentId, "b follow-up", inThread(2, "b"), {
      delivery: "auto",
    });
    const old = runtime.prompt(agentId, "a later", inThread(3, "a"), {
      delivery: "queue",
    });
    host.settle();
    await withinSeconds(
      Promise.all([next.accepted, follow.accepted]),
      "new conversation"
    );
    expect(host.steers).toEqual([]);
    expect(host.prompts[1]!.source?.conversation?.threadId).toBe("b");
    expect(
      runtime.controlQueuedPrompt(
        [agentId],
        (post(3) as { chatMessageId: string }).chatMessageId,
        "send-now"
      )
    ).toBe(false);
    host.settle();
    await withinSeconds(
      old.accepted,
      "previous conversation gets its own turn"
    );
    host.settle();
    await old.settled;
  });

  it("unknown legacy active sources queue user input safely", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    const work = runtime.prompt(agentId, "legacy");
    await work.accepted;
    const user = runtime.prompt(agentId, "root user", inThread(1, null), {
      delivery: "auto",
    });
    expect(host.steers).toEqual([]);
    host.settle();
    await withinSeconds(user.accepted, "legacy fallback");
    host.settle();
    await user.settled;
  });
});

describe("AcpRuntime explicit interruption", () => {
  it("keeps interrupts ahead of declined steering without cancelling a later turn", async () => {
    const host = await heldTurnHost("promptRequired", "supported");
    const runtime = await attached(host.stateRoot);
    const active = runtime.prompt(agentId, "active", post(0));
    await active.accepted;
    const fallback = runtime.prompt(agentId, "ordinary fallback", post(1), {
      delivery: "auto",
    });
    const urgent = runtime.prompt(agentId, "urgent", post(2), {
      delivery: "interrupt",
    });
    const second = runtime.prompt(agentId, "urgent two", post(3), {
      delivery: "interrupt",
    });
    await withinSeconds(urgent.accepted, "urgent before fallback");
    expect(host.steers).toEqual(["ordinary fallback"]);
    expect(host.prompts.map((p) => p.text)).toEqual(["active", "urgent"]);
    expect(host.interruptTargets).toEqual([]);
    host.settle();
    await withinSeconds(second.accepted, "second urgent before fallback");
    expect(host.interruptTargets).toEqual([]);
    host.settle();
    await withinSeconds(fallback.accepted, "ordinary fallback after urgent");
    expect(host.prompts.map((p) => p.text)).toEqual([
      "active",
      "urgent",
      "urgent two",
      "ordinary fallback",
    ]);
    expect(host.interruptTargets).toEqual([]);
    host.settle();
    await Promise.all([
      active.settled,
      urgent.settled,
      second.settled,
      fallback.settled,
    ]);
  });

  it("cancels once, waits for settlement, then opens urgent origin before old queue", async () => {
    const host = await heldTurnHost("injected", "supported");
    const runtime = await attached(host.stateRoot);
    const active = runtime.prompt(agentId, "active", post(0));
    await active.accepted;
    const old = runtime.prompt(agentId, "old", post(1), { delivery: "queue" });
    const origin = {
      ...post(2),
      conversation: { streamId: "other", threadId: "urgent-thread" },
    } as PromptSource;
    const image = { path: "/tmp/urgent.png", mimeType: "image/png" };
    const urgent = runtime.prompt(agentId, "urgent", origin, {
      delivery: "interrupt",
      images: [image],
    });
    await expect.poll(host.cancels).toBe(1);
    expect(host.prompts).toHaveLength(1);
    expect(host.steers).toEqual([]);
    expect(host.interruptTargets).toEqual([1]);
    expect(
      runtime.controlQueuedPrompt([agentId], post(2).chatMessageId!, "send-now")
    ).toBe(false);
    host.settle();
    await withinSeconds(urgent.accepted, "urgent accepted");
    expect(host.prompts[1]).toEqual({
      text: "urgent",
      source: origin,
      images: [image],
    });
    expect(host.prompts).toHaveLength(2);
    host.settle();
    await withinSeconds(old.accepted, "old accepted");
    host.settle();
    await Promise.all([active.settled, urgent.settled, old.settled]);
    expect(host.cancels()).toBe(1);
  });

  it("holds dispatch until a late cancel response and never cancels the following urgent turn", async () => {
    const host = await heldTurnHost("injected", "deferred");
    const runtime = await attached(host.stateRoot);
    const active = runtime.prompt(agentId, "active", post(0));
    await active.accepted;
    const urgent = runtime.prompt(agentId, "urgent one", post(1), {
      delivery: "interrupt",
    });
    await expect.poll(host.cancels).toBe(1);
    const second = runtime.prompt(agentId, "urgent two", post(2), {
      delivery: "interrupt",
    });
    host.settle();
    await active.settled;
    // A new urgent post after settlement also must not target the next turn.
    const third = runtime.prompt(agentId, "urgent three", post(3), {
      delivery: "interrupt",
    });
    expect(host.prompts).toHaveLength(1);
    host.finishInterrupt();
    await withinSeconds(urgent.accepted, "first urgent");
    expect(host.cancels()).toBe(1);
    host.settle();
    await withinSeconds(second.accepted, "second urgent");
    host.settle();
    await withinSeconds(third.accepted, "third urgent");
    host.settle();
    await Promise.all([urgent.settled, second.settled, third.settled]);
    expect(host.prompts.map((p) => p.text)).toEqual([
      "active",
      "urgent one",
      "urgent two",
      "urgent three",
    ]);
    expect(host.cancels()).toBe(1);
  });

  it("fails cancellation visibly without sending urgent or disturbing old queued work", async () => {
    const host = await heldTurnHost("injected", "error");
    const runtime = await attached(host.stateRoot);
    const active = runtime.prompt(agentId, "active", post(0));
    await active.accepted;
    const old = runtime.prompt(agentId, "old", post(1), { delivery: "queue" });
    const urgent = runtime.prompt(agentId, "urgent", post(2), {
      delivery: "interrupt",
    });
    await expect(urgent.accepted).rejects.toThrow("cancel rejected");
    await urgent.settled;
    expect(runtime.hasOpenTurn(agentId)).toBe(true);
    expect(host.prompts.map((p) => p.text)).toEqual(["active"]);
    expect(host.steers).toEqual([]);
    // Explicit retry makes a fresh cancel attempt on the same active turn.
    const retry = runtime.prompt(agentId, "urgent", post(2), {
      delivery: "interrupt",
    });
    await expect(retry.accepted).rejects.toThrow("cancel rejected");
    expect(host.cancels()).toBe(2);
    host.settle();
    await withinSeconds(old.accepted, "old queued work");
    host.settle();
    await Promise.all([active.settled, old.settled, retry.settled]);
  });

  it("fails a disconnected cancellation instead of retaining the submission lock", async () => {
    const host = await heldTurnHost("injected", "deferred");
    const runtime = await attached(host.stateRoot);
    const active = runtime.prompt(agentId, "active", post(0));
    await active.accepted;
    const urgent = runtime.prompt(agentId, "urgent", post(1), {
      delivery: "interrupt",
    });
    await expect.poll(host.cancels).toBe(1);
    host.disconnect();
    await expect(
      withinSeconds(urgent.accepted, "disconnected cancel")
    ).rejects.toThrow("connection closed");
    await urgent.settled;
    expect(host.prompts).toHaveLength(1);
  });

  it("a late cancel rejection only fails posts targeting that turn", async () => {
    const host = await heldTurnHost("injected", "deferred");
    const runtime = await attached(host.stateRoot);
    const active = runtime.prompt(agentId, "active", post(0));
    await active.accepted;
    const urgent = runtime.prompt(agentId, "urgent", post(1), {
      delivery: "interrupt",
    });
    await expect.poll(host.cancels).toBe(1);
    host.settle();
    await active.settled;
    const later = runtime.prompt(agentId, "idle urgent", post(2), {
      delivery: "interrupt",
    });
    host.rejectInterrupt();
    await expect(urgent.accepted).rejects.toThrow("cancel rejected");
    await withinSeconds(later.accepted, "idle urgent after cancel error");
    host.settle();
    await Promise.all([urgent.settled, later.settled]);
    expect(host.cancels()).toBe(1);
    expect(host.prompts.map((p) => p.text)).toEqual(["active", "idle urgent"]);
  });

  it("rejects unsupported active interruption and accepts interrupt when idle without cancellation", async () => {
    const host = await heldTurnHost("injected");
    const runtime = await attached(host.stateRoot);
    expect(runtime.inputState?.(agentId).interruptSupported).toBe(false);
    const active = runtime.prompt(agentId, "active", post(0));
    await active.accepted;
    const urgent = runtime.prompt(agentId, "urgent", post(1), {
      delivery: "interrupt",
    });
    await expect(urgent.accepted).rejects.toThrow("cannot safely interrupt");
    host.settle();
    await active.settled;
    const idle = runtime.prompt(agentId, "idle urgent", post(2), {
      delivery: "interrupt",
    });
    await withinSeconds(idle.accepted, "idle urgent");
    expect(host.cancels()).toBe(0);
    host.settle();
    await idle.settled;
  });

  it("does not cancel when active work settles before the interrupt pump resumes", async () => {
    const host = await heldTurnHost("injected", "supported");
    const runtime = await attached(host.stateRoot);
    const active = runtime.prompt(agentId, "active", post(0));
    await active.accepted;
    host.settle();
    await active.settled;
    const urgent = runtime.prompt(agentId, "urgent", post(1), {
      delivery: "interrupt",
    });
    await withinSeconds(urgent.accepted, "urgent after settlement");
    expect(host.cancels()).toBe(0);
    host.settle();
    await urgent.settled;
  });
});
