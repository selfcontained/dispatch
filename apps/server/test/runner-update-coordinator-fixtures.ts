/**
 * An update world without systemd: the real service, holds, coordinator, ACP
 * runtime and runner update agent, with a scripted updater and scripted hosts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import type { UpdateStatusFrame } from "@dispatch/runner-protocol";
import type { FastifyBaseLogger } from "fastify";
import { vi } from "vitest";

import {
  encodeMessage,
  ndjsonDecoder,
  type ClientMessage,
  type HostMessage,
} from "../src/agents/acp/host-protocol.js";
import { createAcpRuntime } from "../src/agents/acp/runtime.js";
import { AgentManager } from "../src/agents/manager.js";
import { wireFrames } from "../src/agents/remote/protocol.js";
import {
  RemoteRunnerService,
  RunnerUnavailable,
} from "../src/agents/remote/service.js";
import { UpdateAdmission } from "../src/agents/remote/update-admission.js";
import {
  createRunnerUpdateAgent,
  type HandoffInventory,
  type RunnerUpdater,
  type StageReport,
} from "../src/agents/remote/update-agent.js";
import {
  RunnerUpdateCoordinator,
  type RunnerUpdateRecord,
} from "../src/agents/remote/update-coordinator.js";
import {
  RunnerUpdateHolds,
  type RunnerHoldState,
} from "../src/agents/remote/update-hold.js";
import type { TrialRecord } from "../src/agents/remote/update-trial.js";
import { identity, memoryStore, target } from "./runner-update-fixtures.js";

export const RUNNER = "rnr_one";
export const AGENT = "agt_retained";
export const INSTANCE = "00000000-0000-4000-8000-000000000001";
export const build = { version: target.version, revision: target.revision };

function socketPair(): [Duplex, Duplex] {
  let a!: Duplex;
  let b!: Duplex;
  const side = (other: () => Duplex) =>
    Object.assign(
      new Duplex({
        read() {},
        write(chunk, _encoding, done) {
          if (!other().destroyed) other().push(chunk);
          done();
        },
        destroy(error, done) {
          queueMicrotask(() => other().destroy());
          done(error);
        },
      }),
      { setKeepAlive() {} }
    );
  a = side(() => b);
  b = side(() => a);
  return [a, b];
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as FastifyBaseLogger;

export async function updateWorld(
  options: {
    agents?: number;
    automaticUpdates?: boolean;
    identity?: typeof identity;
    build?: { version: string; revision: string | null };
  } = {}
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dr-coordinator-"));
  let now = 1_800_000_000_000;
  let controllerBuild = options.build ?? build;
  const saved = {
    records: [] as RunnerUpdateRecord[],
    holds: { holds: [], resuming: [] } as RunnerHoldState,
    fail: null as null | ((records: RunnerUpdateRecord[]) => boolean),
  };
  const artifacts = {
    updateEnabled: true,
    getUpdate: vi.fn(async (arch: "x64" | "arm64") => ({
      manifest: {
        version: controllerBuild.version,
        os: "linux" as const,
        arch,
        // A different build has different bytes.
        sha256:
          controllerBuild.version === target.version
            ? target.sha256
            : "e".repeat(64),
      },
    })),
  };

  /** What an attach gets back from the retained hosts. */
  const hosts = {
    reply: "ready" as "ready" | "socket" | "no-replay" | "gone",
    instance: INSTANCE,
    attaches: 0,
  };

  // --- The runner, surviving restarts of either side ---
  const runner = {
    identity: options.identity ?? identity,
    fence: memoryStore(),
    trial: null as TrialRecord | null,
    suppressed: new Set<string>(),
    report: null as StageReport | null,
    inventory: null as HandoffInventory | null,
    staging: Promise.resolve() as Promise<void>,
    previous: options.identity ?? identity,
    capable: true,
    fenceUnreadable: false,
    /** Everything Dispatch sent, across connections. */
    frames: [] as any[],
    statuses: [] as UpdateStatusFrame[],
    decisions: [] as string[],
  };
  const retained = () =>
    Array.from({ length: options.agents ?? 1 }, () => ({
      sessionId: AGENT,
      instanceId: INSTANCE,
      build: { version: identity.version, revision: identity.revision },
    }));
  const updater: RunnerUpdater = {
    canActivate: true,
    async stage(offered) {
      await runner.staging;
      return (
        runner.report ?? {
          outcome: "staged",
          compatibility: {
            version: offered.version,
            revision: offered.revision,
            handoff: { reads: [1, 2], writes: 2 },
          },
        }
      );
    },
    suppressed: async ({ sha256 }) => runner.suppressed.has(sha256),
    async activate(fence) {
      runner.trial ??= {
        fence,
        previous: { ...runner.previous },
        deadline: now + 240_000,
        phase: "prepared",
      };
    },
    async confirm() {
      runner.decisions.push("confirm");
      await api.endTrial("confirmed");
    },
    async cancelTrial(_fence, reason) {
      runner.decisions.push(reason);
      await api.rollBack(
        reason === "trial_failed" ? "reattach_failed" : "cancelled"
      );
      return true;
    },
    durable: {
      read: async () => runner.trial,
      fenceCleared: async () => runner.fence.record === null,
      async signal(_fence, signal) {
        if (signal.kind !== "reject") return;
        runner.decisions.push(signal.reason);
        await api.rollBack(signal.reason);
      },
    },
  };
  let supervisor!: ReturnType<typeof createRunnerUpdateAgent>;
  let admission!: UpdateAdmission;
  let link: { socket: Duplex; send(frame: unknown): void } | undefined;

  async function boot() {
    const store = runner.fenceUnreadable
      ? {
          ...runner.fence,
          read: async () => {
            throw new Error("unreadable");
          },
          clear: async () => {
            runner.fenceUnreadable = false;
          },
        }
      : runner.fence;
    admission = await UpdateAdmission.load(store, {
      log: () => {},
      terminalGraceMs: 1,
    });
    supervisor = createRunnerUpdateAgent({
      identity: runner.identity,
      admission,
      updater,
      log: () => {},
      inspect: async () =>
        runner.inventory ?? {
          retained: retained(),
          requiresQuiescence: false,
          live: options.agents ?? 1,
        },
    });
  }

  const drain = {
    hosts: new Map<string, "busy" | "unattached" | "idle">(),
    stopped: [] as string[],
    resumed: [] as Array<{ id: string; revision: string }>,
    recovery: Promise.resolve(),
  };

  // --- The controller, rebuilt on restart ---
  function controller() {
    const service = new RemoteRunnerService();
    const internals = service as any;
    const registration = {
      id: RUNNER,
      fingerprint: "fp",
      automaticUpdates: options.automaticUpdates,
    };
    internals.enrolled.set("fp", registration);

    const holds = new RunnerUpdateHolds({
      store: {
        read: async () => structuredClone(saved.holds),
        write: async (state) => void (saved.holds = structuredClone(state)),
      },
      logger,
      now: () => now,
    });
    const channels = new Set<Duplex>();
    service.onConnectionChange(() => {
      for (const channel of channels) channel.destroy();
      channels.clear();
    });
    const runtime = createAcpRuntime({
      config: {
        agentStateRoot: directory,
        agentRuntime: "acp",
        dispatchBinDir: directory,
      },
      logger,
      holds,
      hostSeq: async () => ({ seq: 0, journalId: null }),
      syncJournal: async () => {},
      placement: async (agentId) =>
        agentId === AGENT ? { runner: RUNNER, workspace: "work" } : null,
      remote: {
        available: () => service.connectionEpoch(RUNNER) !== undefined,
        connectionEpoch: (id) => service.connectionEpoch(id),
        requestSession: (async (_placement: unknown, operation: any) => {
          if (service.connectionEpoch(RUNNER) === undefined)
            throw new RunnerUnavailable("offline");
          if (operation.kind === "alive")
            return { value: hosts.reply !== "gone" };
          if (operation.kind !== "attach") return { value: "" };
          if (hosts.reply === "gone") throw new RunnerUnavailable("gone");
          hosts.attaches++;
          const [ours, theirs] = socketPair();
          channels.add(ours);
          const decode = ndjsonDecoder<ClientMessage>();
          theirs.on("data", (chunk) => {
            for (const message of decode(chunk)) {
              if (message.type !== "hello" || hosts.reply === "socket")
                continue;
              const welcome = {
                type: "welcome",
                agentId: AGENT,
                engine: "claude",
                sessionId: "session",
                resumed: true,
                running: true,
                turn: null,
                journalSeq: 0,
                journalId: "journal",
                hostInstanceId: hosts.instance,
              } satisfies HostMessage;
              theirs.write(encodeMessage(welcome));
              if (hosts.reply === "ready")
                theirs.write(encodeMessage({ type: "replay_complete" }));
            }
          });
          return { channel: ours };
        }) as RemoteRunnerService["requestSession"],
      },
    });
    const manager = {
      runtime,
      streamRecorder: { setCwd: () => {} },
      getAgent: async (id: string) =>
        id === AGENT ? { id, cwd: `runner://${RUNNER}/work` } : null,
    };
    const agents = {
      isRunnerSessionAttached:
        AgentManager.prototype.isRunnerSessionAttached.bind(manager as never),
      attachRunnerSession: vi.fn(
        AgentManager.prototype.attachRunnerSession.bind(manager as never)
      ),
      runnerHostRecycleProgress: vi.fn(
        () =>
          null as null | { oldBuild: number; recycled: number; waiting: number }
      ),
      settleRunnerHostRecycling: vi.fn(async () => {}),
      startRunnerHostRecycling: vi.fn(),
      runnerDrainHosts: vi.fn(async () =>
        [...drain.hosts].map(([id, state]) => ({
          id,
          host:
            state === "unattached"
              ? undefined
              : {
                  agentId: id,
                  attachedEpoch: service.connectionEpoch(RUNNER),
                  build: runner.identity,
                  instanceId: INSTANCE,
                  quiesceSupported: true,
                },
        }))
      ),
      stopRunnerHostForDrain: vi.fn(
        async (_runner, host, _epoch, _mayStop, record) => {
          const id = host.agentId as string;
          if (drain.hosts.get(id) !== "idle") return;
          await record({ id, updatedAt: "2026-11-21 12:00:00+00" });
          drain.stopped.push(id);
          drain.hosts.delete(id);
          runner.inventory = {
            retained: [],
            requiresQuiescence: true,
            live: drain.hosts.size,
          };
        }
      ),
      resumeRunnerDrainHost: vi.fn(async (_runner, _attempt, { id }) => {
        await drain.recovery;
        drain.resumed.push({ id, revision: runner.identity.revision });
      }),
      setRunnerDrainReceipt: vi.fn(),
      endedRunnerResumes: vi.fn(async (): Promise<string[]> => []),
      stopRunnerHostRecycling: vi.fn(),
    };
    const coordinator = new RunnerUpdateCoordinator({
      service,
      holds,
      agents,
      artifacts: () => artifacts as never,
      build: controllerBuild,
      logger,
      now: () => now,
      store: {
        read: async () => structuredClone(saved.records),
        async write(records) {
          if (saved.fail?.(records)) throw new Error("disk full");
          saved.records = structuredClone(records);
        },
      },
    });
    return { service, internals, holds, runtime, agents, coordinator };
  }

  let current = controller();

  const api = {
    runner,
    drain,
    hosts,
    saved,
    artifacts,
    get service() {
      return current.service;
    },
    get coordinator() {
      return current.coordinator;
    },
    get holds() {
      return current.holds;
    },
    get agents() {
      return current.agents;
    },
    get admission() {
      return admission;
    },
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    flush,
    async start() {
      await current.holds.load();
      await current.coordinator.load();
      current.holds.start();
      await current.coordinator.start();
      await flush();
    },
    async connect() {
      if (!supervisor) await boot();
      link?.socket.destroy();
      const [server, client] = socketPair();
      const { internals } = current;
      internals.attachPeer(server, {
        key: RUNNER,
        registrationId: RUNNER,
        approved: () => internals.enrolled.has("fp"),
        allows: () => true,
      });
      let connection: ReturnType<typeof supervisor.connect> | undefined;
      const send = wireFrames<any, any>(client, (frame) => {
        runner.frames.push(frame);
        if (runner.capable) void connection?.receive(frame);
      });
      const safeSend = (frame: unknown) => {
        if (!client.destroyed) send(frame);
      };
      client.on("close", () => connection?.close());
      link = { socket: client, send: safeSend };
      safeSend({
        type: "ready",
        version: 1,
        workspaces: ["work"],
        ...(runner.capable && { selfUpdate: supervisor.advert() }),
      });
      if (runner.capable)
        connection = supervisor.connect((frame) => {
          runner.statuses.push(frame);
          safeSend(frame);
        });
      await flush();
      await flush();
    },
    async disconnect() {
      link?.socket.destroy();
      link = undefined;
      await flush();
      await flush();
    },
    /** A status the runner's agent would not send by itself. */
    inject(frame: Partial<UpdateStatusFrame> & { attemptId: string }) {
      link!.send({
        type: "update_status",
        phase: "deferred",
        installed: {
          version: runner.identity.version,
          revision: runner.identity.revision,
          sha256: runner.identity.sha256,
        },
        ...frame,
      });
    },
    async restartRunner() {
      await api.disconnect();
      await boot();
      await api.connect();
    },
    /** The updater swaps to the fenced candidate and starts its trial. */
    async swap(installed?: Partial<typeof identity>) {
      await api.until(() => runner.trial?.phase === "prepared");
      const { fence } = runner.trial!;
      runner.previous = { ...runner.identity };
      await api.disconnect();
      runner.identity = {
        ...runner.identity,
        version: fence.target.version,
        revision: fence.target.revision,
        sha256: fence.target.sha256,
        ...installed,
      };
      runner.trial = { ...runner.trial, phase: "trial" } as TrialRecord;
      await boot();
      await api.connect();
    },
    async endTrial(phase: TrialRecord["phase"], reason?: any) {
      runner.trial = {
        fence: runner.trial!.fence,
        phase,
        ...(reason && { reason }),
      } as TrialRecord;
      runner.fence.record = null;
    },
    async rollBack(reason: any) {
      const swapped = runner.identity.sha256 !== runner.previous.sha256;
      await api.disconnect();
      runner.identity = runner.previous;
      if (swapped) runner.suppressed.add(runner.trial!.fence.target.sha256);
      await api.endTrial(swapped ? "rolled_back" : "deferred", reason);
      await boot();
      await api.connect();
    },
    /** Dispatch stops and a new process loads the saved state. */
    async restartController(
      next: {
        build?: typeof controllerBuild;
        beforeStart?: () => Promise<void>;
      } = {}
    ) {
      current.coordinator.close();
      current.holds.close();
      await api.disconnect();
      controllerBuild = next.build ?? controllerBuild;
      current = controller();
      await next.beforeStart?.();
      await api.start();
    },
    revoke() {
      current.internals.enrolled.clear();
    },
    /** Tick until true, without moving the clock. */
    async until(check: () => unknown, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() > deadline)
          throw new Error(
            `not reached: ${check}\nframes ${JSON.stringify(
              runner.frames.map((f) => f.type)
            )}\nstatuses ${JSON.stringify(
              runner.statuses.map((s) => [s.phase, s.reason])
            )}\nview ${JSON.stringify(current.coordinator.view(RUNNER))}`
          );
        await current.coordinator.tick();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async settle(ms = 50) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        await current.coordinator.tick();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    sent(type: string) {
      return runner.frames.filter((frame) => frame.type === type);
    },
    phase() {
      return current.coordinator.view(RUNNER)?.attempt?.phase;
    },
    result() {
      return current.coordinator.view(RUNNER)?.result;
    },
    attempt() {
      return saved.records[0]?.attempt;
    },
    async close() {
      current.coordinator.close();
      current.holds.close();
      link?.socket.destroy();
      await flush();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return api;
}
