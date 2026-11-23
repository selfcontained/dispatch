/**
 * The host client's mode is negotiated from what the host advertises, never
 * from placement. Fixture hosts on real Unix sockets speak the two feature
 * sets: origin/main and v1.7.28 hosts (no `replay_complete`, receipts,
 * quiesce lease or build identity; every connection evicts the previous one)
 * and this branch's hosts (advertise `replayCompleteSupported`). Hosts built
 * from this branch before that flag existed send `replay_complete` without
 * advertising it, and are told apart from main-era hosts by the welcome
 * fields only this branch's hosts send.
 */
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";

import { HostClient } from "../src/agents/acp/host-client.js";
import {
  encodeMessage,
  ndjsonDecoder,
  type ClientMessage,
  type HostMessage,
} from "../src/agents/acp/host-protocol.js";
import { hostReconnectDisposition } from "../src/agents/acp/runtime.js";

const agentId = "agt_mode_test";
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const run of cleanups.splice(0).reverse()) run();
});

type Era = "main" | "branch" | "current";

/** Welcome fields of a pre-flag branch host (`replay_complete`, no flag). */
type BranchFields = Record<string, unknown>;

/** A host's welcome for its era, as the real hosts write it. */
function welcome(
  era: Era,
  journal: { id: string; seq: number },
  running = true,
  branchFields: BranchFields = {}
): HostMessage {
  return {
    type: "welcome",
    agentId,
    engine: "claude",
    sessionId: "sess",
    resumed: false,
    running,
    mcpInventorySupported: false,
    backgroundWorkSupported: true,
    steeringSupported: true,
    interruptSupported: true,
    ...(era === "current"
      ? {
          promptReceiptSupported: true,
          quiesceSupported: true,
          replayCompleteSupported: true,
          hostBuild: { version: "0.0.0", revision: null },
          hostInstanceId: "instance",
        }
      : era === "branch"
        ? branchFields
        : {}),
    turn: null,
    journalSeq: journal.seq,
    journalId: journal.id,
    commands: [],
    configOptions: [],
    permissions: [],
  } as HostMessage;
}

/**
 * A scripted host. It replays by the real hosts' rule: from 0 when the
 * journal changed or `fromSeq` is past its head, else after `fromSeq`.
 */
async function fixtureHost(
  era: Era,
  options: {
    journalId?: string;
    seq?: number;
    markerDelayMs?: number;
    branchFields?: BranchFields;
  } = {}
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "host-mode-"));
  const socketPath = path.join(dir, "host.sock");
  const journal = { id: options.journalId ?? "journal-1", seq: 0 };
  const entries: HostMessage[] = [];
  const event = (seq: number): HostMessage =>
    ({
      type: "event",
      seq,
      at: new Date(0).toISOString(),
      event: { type: "update", agentId, update: { seq } },
    }) as unknown as HostMessage;
  for (let i = 0; i < (options.seq ?? 0); i++)
    entries.push(event(++journal.seq));
  let client: net.Socket | null = null;
  let open = 0;
  const stats = {
    connections: 0,
    maxOpen: 0,
    hellos: [] as ClientMessage[],
    prompts: [] as string[],
  };
  const server = net.createServer((socket) => {
    stats.connections += 1;
    open += 1;
    stats.maxOpen = Math.max(stats.maxOpen, open);
    // Hosts evict the current client when another connects.
    if (client && client !== socket) client.destroy();
    client = socket;
    socket.on("close", () => {
      open -= 1;
      if (client === socket) client = null;
    });
    socket.on("error", () => {});
    const decode = ndjsonDecoder<ClientMessage>();
    socket.on("data", (chunk) => {
      for (const message of decode(chunk)) {
        if (message.type === "hello") {
          stats.hellos.push(message);
          socket.write(
            encodeMessage(welcome(era, journal, true, options.branchFields))
          );
          const from =
            (message.journalId && message.journalId !== journal.id) ||
            message.fromSeq > journal.seq
              ? 0
              : message.fromSeq;
          for (const entry of entries)
            if ((entry as { seq: number }).seq > from)
              socket.write(encodeMessage(entry));
          if (era !== "main" && message.replayComplete) {
            const marker = () =>
              socket.write(encodeMessage({ type: "replay_complete" }));
            if (options.markerDelayMs)
              setTimeout(marker, options.markerDelayMs);
            else marker();
          }
        } else if (message.type === "prompt") {
          stats.prompts.push(message.text);
          socket.write(
            encodeMessage({ type: "prompt_accepted", id: message.id })
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    socketPath,
    stats,
    journal,
    append() {
      const entry = event(++journal.seq);
      entries.push(entry);
      client?.write(encodeMessage(entry));
    },
    /** Drop the current client, as a host restart or runner loss would. */
    drop() {
      client?.destroy();
    },
  };
}

function dial(socketPath: string): () => Promise<Duplex> {
  return () =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
}

function client(
  openSocket: () => Promise<Duplex>,
  cursor: { seq: number; journalId: string | null } = {
    seq: 0,
    journalId: null,
  },
  extra: Partial<ConstructorParameters<typeof HostClient>[0]> = {}
) {
  const events: number[] = [];
  /** Each applied entry with whether the client was ready when it arrived. */
  const seen: Array<[number, boolean]> = [];
  const onReady = vi.fn();
  const onGone = vi.fn();
  const host = new HostClient({
    agentId,
    remote: true,
    openSocket,
    reconnectError: hostReconnectDisposition,
    onReady,
    logger,
    fromSeq: () => cursor.seq,
    journalId: () => cursor.journalId,
    onEvent: (entry) => {
      events.push(entry.seq);
      seen.push([entry.seq, host.isReady()]);
      cursor.seq = entry.seq;
    },
    onWelcome: (w) => {
      if (w.journalId) cursor.journalId = w.journalId;
    },
    onGone,
    ...extra,
  });
  cleanups.push(() => host.close());
  return { host, events, seen, onReady, onGone, cursor };
}

async function until(condition: () => boolean, ms = 3_000) {
  const began = Date.now();
  while (!condition()) {
    if (Date.now() - began > ms) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("host client mode, negotiated from the host", () => {
  for (const remote of [true, false]) {
    it(`a main-era host becomes ready once the replay reaches the welcome's journalSeq (remote: ${remote})`, async () => {
      const host = await fixtureHost("main", { seq: 3 });
      const c = client(dial(host.socketPath), undefined, { remote });
      const w = await c.host.connect(2_000, undefined, true);
      expect(w.replayCompleteSupported).toBeUndefined();
      expect(c.events).toEqual([1, 2, 3]);
      // Not ready while the replay was being applied; ready after its last entry.
      expect(c.seen).toEqual([
        [1, false],
        [2, false],
        [3, false],
      ]);
      expect(c.host.isReady()).toBe(true);
      expect(c.onReady).toHaveBeenCalledTimes(1);
      // The client asked for the marker; the host ignored the field.
      expect(host.stats.hellos[0]).toMatchObject({ replayComplete: true });

      // Drive: a prompt is accepted; a live event is applied.
      await expect(c.host.prompt("p1", "hello")).resolves.toBe("accepted");
      host.append();
      await until(() => c.events.length === 4);
      expect(host.stats.prompts).toEqual(["hello"]);
      expect(await c.host.promptReceipt("p1")).toBe("unsupported");
      expect(await c.host.quiesce()).toBeNull();
    });
  }

  it("a main-era host with nothing to replay is ready at its welcome", async () => {
    const host = await fixtureHost("main", { seq: 3 });
    const c = client(dial(host.socketPath), { seq: 3, journalId: "journal-1" });
    await c.host.connect(2_000, undefined, true);
    expect(c.events).toEqual([]);
    expect(c.host.isReady()).toBe(true);
  });

  it("a main-era host replays from 0 after a journal change and is ready after the full replay", async () => {
    const host = await fixtureHost("main", {
      seq: 2,
      journalId: "journal-new",
    });
    const c = client(dial(host.socketPath), {
      seq: 5,
      journalId: "journal-old",
    });
    await c.host.connect(2_000, undefined, true);
    expect(c.events).toEqual([1, 2]);
    expect(c.host.isReady()).toBe(true);
  });

  it("a current host is ready only after replay_complete, even with the replay applied", async () => {
    const host = await fixtureHost("current", { seq: 3, markerDelayMs: 150 });
    const c = client(dial(host.socketPath));
    const connected = c.host.connect(2_000);
    await connected;
    await until(() => c.events.length === 3);
    expect(c.host.isReady()).toBe(false);
    await until(() => c.host.isReady());
    expect(c.onReady).toHaveBeenCalledTimes(1);
    expect(c.host.welcome?.replayCompleteSupported).toBe(true);
  });

  it("a current host with an empty journal still waits for the marker", async () => {
    const host = await fixtureHost("current", { seq: 0, markerDelayMs: 100 });
    const c = client(dial(host.socketPath));
    await c.host.connect(2_000);
    expect(c.host.isReady()).toBe(false);
    await c.host.connect(2_000, undefined, true);
    expect(c.host.isReady()).toBe(true);
  });

  // Hosts started by earlier builds of this branch, e.g. those still running
  // on an enrolled runner when this build attaches them after an update.
  it.each([
    [
      "host identity, receipts and quiesce",
      {
        hostInstanceId: "instance",
        hostBuild: { version: "0.0.0", revision: null },
        promptReceiptSupported: true,
        quiesceSupported: true,
      },
    ],
    [
      "host identity only",
      {
        hostInstanceId: "instance",
        hostBuild: { version: "0.0.0", revision: null },
      },
    ],
    ["prompt receipts only", { promptReceiptSupported: true }],
  ] as const)(
    "an earlier branch host without the flag (%s) still waits for replay_complete",
    async (_case, branchFields) => {
      for (const remote of [true, false]) {
        const host = await fixtureHost("branch", {
          seq: 0,
          markerDelayMs: 150,
          branchFields,
        });
        const c = client(dial(host.socketPath), undefined, { remote });
        const w = await c.host.connect(2_000);
        expect(w.replayCompleteSupported).toBeUndefined();
        // Nothing to replay, but the host speaks the marker: not ready yet.
        expect(c.host.isReady()).toBe(false);
        expect(c.onReady).not.toHaveBeenCalled();
        await c.host.connect(2_000, undefined, true);
        expect(c.host.isReady()).toBe(true);
        expect(c.onReady).toHaveBeenCalledTimes(1);
      }
    }
  );

  it("opens one connection per attach and never probes: reconnects replace, never overlap", async () => {
    const host = await fixtureHost("main", { seq: 1 });
    const c = client(dial(host.socketPath));
    await c.host.connect(2_000, undefined, true);
    for (let i = 0; i < 2; i++) {
      host.drop();
      await until(() => !c.host.isConnected());
      await until(() => c.host.isReady(), 5_000);
    }
    host.append();
    await until(() => c.events.length === 2);
    expect(c.events).toEqual([1, 2]);
    expect(host.stats.connections).toBe(3);
    expect(host.stats.maxOpen).toBe(1);
    expect(c.onGone).not.toHaveBeenCalled();
  });
});

/** An in-memory main-era host on one duplex, for fake-timer tests. */
function memoryHost(prompts: string[]): Duplex {
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  const decode = ndjsonDecoder<ClientMessage>();
  toHost.on("data", (chunk) => {
    for (const message of decode(chunk)) {
      if (message.type === "hello")
        toClient.write(encodeMessage(welcome("main", { id: "j", seq: 0 })));
      if (message.type === "prompt") {
        prompts.push(message.text);
        toClient.write(
          encodeMessage({ type: "prompt_accepted", id: message.id })
        );
      }
    }
  });
  return Duplex.from({ readable: toClient, writable: toHost });
}

describe("reconnect while the runner is unavailable", () => {
  it("retries for as long as the app runs and loses nothing; plain errors keep main's ~25 s bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const prompts: string[] = [];
    let mode: "up" | "unavailable" | "plain" = "up";
    let socket: Duplex | null = null;
    const open = async () => {
      if (mode === "unavailable")
        throw new RunnerCallError({ code: "unavailable", message: "down" });
      if (mode === "plain") throw new Error("connect ENOENT host.sock");
      socket = memoryHost(prompts);
      return socket;
    };
    const c = client(open);
    await c.host.connect(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.host.isReady()).toBe(true);

    mode = "unavailable";
    socket!.destroy();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.onGone).not.toHaveBeenCalled();
    expect(c.host.isConnected()).toBe(false);

    mode = "up";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.host.isReady()).toBe(true);
    const accepted = c.host.prompt("after", "queued text");
    await vi.advanceTimersByTimeAsync(0);
    await expect(accepted).resolves.toBe("accepted");
    expect(prompts).toEqual(["queued text"]);

    // Today's local failure (a plain error): recorded as gone after ~25 s.
    mode = "plain";
    socket!.destroy();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(c.onGone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.onGone).toHaveBeenCalledTimes(1);
  });

  it("classifies runner errors the same way for every placement", () => {
    const code = (c: RunnerCallError["code"]) =>
      hostReconnectDisposition(new RunnerCallError({ code: c, message: "" }));
    expect(code("unavailable")).toBe("retry");
    expect(code("unknown_outcome")).toBe("retry");
    expect(code("host_gone")).toBe("gone");
    expect(code("failed")).toBeUndefined();
    expect(hostReconnectDisposition(new Error("ENOENT"))).toBeUndefined();
  });
});
