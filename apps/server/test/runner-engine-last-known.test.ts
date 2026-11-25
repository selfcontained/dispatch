import { scopedEngineCalls } from "../src/runners/local.js";
import { Duplex } from "node:stream";
import type { EngineInventoryEntry } from "@dispatch/runner-protocol/engine-management";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineManager } from "../src/agents/remote/engine-manager.js";

import { remoteEngineTransport } from "../src/agents/remote/engine-transport.js";
import { RemoteRunnerService } from "../src/agents/remote/service.js";

const scope = { kind: "runner", runnerId: "rnr_one" } as const;
const claude: EngineInventoryEntry = {
  id: "claude",
  label: "Claude Code",
  installed: true,
  signedIn: true,
  version: "2.1.325",
  actions: ["update", "login"],
};

const sockets: Duplex[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

/** A runner on the real service; a fenced one refuses the status read. */
function world() {
  const service = new RemoteRunnerService();
  let approved = true;
  const requests: any[] = [];
  function connect({
    fenced = false,
    reply,
    dropRequest = false,
  }: { fenced?: boolean; reply?: unknown; dropRequest?: boolean } = {}) {
    const socket = Object.assign(
      new Duplex({
        read() {},
        write(chunk, _encoding, done) {
          done();
          for (const line of String(chunk).trim().split("\n")) {
            const frame = JSON.parse(line);
            if (frame.type === "request") requests.push(frame.command);
            if (frame.type === "request" && dropRequest) {
              queueMicrotask(() => socket.destroy());
              continue;
            }
            if (frame.type === "request" && !fenced) {
              const operation = frame.command.operation;
              const result =
                operation.type === "contract" &&
                operation.call.op === "engine.update.probe"
                  ? { alive: [false], version: "1.2.3" }
                  : { entries: [claude] };
              send({
                type: "result",
                id: frame.id,
                value: JSON.stringify(
                  reply !== undefined
                    ? reply
                    : operation.type === "contract"
                      ? { ok: true, result }
                      : { ok: true }
                ),
              });
            }
            if (frame.type === "request" && fenced)
              send({
                type: "result",
                id: frame.id,
                code: "update-fenced",
                error: "The runner is updating; the operation was not started.",
              });
          }
        },
      }),
      { setKeepAlive() {} }
    );
    sockets.push(socket);
    const send = (frame: object) => socket.push(JSON.stringify(frame) + "\n");
    (service as any).attachPeer(socket, {
      key: scope.runnerId,
      approved: () => approved,
      allows: () => true,
    });
    send({
      type: "ready",
      version: 1,
      workspaces: ["work"],
      health: true,
      engineManagement: true,
    });
    return {
      push: (entries: EngineInventoryEntry[]) =>
        send({ type: "engine_inventory", entries }),
      drop: () => socket.destroy(),
    };
  }
  const manager = new EngineManager({
    engineActions: {
      usage: () => {
        throw new Error("Unexpected fixture usage request");
      },
      calls: (target) => scopedEngineCalls({} as never, service, target),
      updates: () => ({}) as never,
    },
    local: { engines: {} as never, updates: {} as never },
    remote: remoteEngineTransport(service),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const read = async () => {
    await settle();
    return manager.inventory(scope);
  };
  return { service, requests, connect, read, revoke: () => (approved = false) };
}

describe("a runner's engines across its update", () => {
  it("keeps the last known state, without actions, behind the fence", async () => {
    const { connect, read } = world();
    connect().push([claude]);
    expect(await read()).toEqual([claude]);
    // The candidate build reconnects fenced, so it pushes and answers nothing.
    connect({ fenced: true });
    expect(await read()).toEqual([{ ...claude, actions: [] }]);
  });

  it("keeps it while the runner is between supervisors", async () => {
    const { connect, read } = world();
    const runner = connect();
    runner.push([claude]);
    expect(await read()).toEqual([claude]);
    runner.drop();
    expect(await read()).toEqual([{ ...claude, actions: [] }]);
  });

  it("is unknown, not uninstalled, with nothing known", async () => {
    const { connect, read } = world();
    connect({ fenced: true });
    expect(await read()).toBeNull();
  });

  it("follows what the new connection pushes", async () => {
    const { connect, read } = world();
    connect().push([claude]);
    await read();
    const updated = { ...claude, version: "2.2.0" };
    connect().push([updated]);
    expect(await read()).toEqual([updated]);
  });

  it("forgets a revoked runner", async () => {
    const { connect, read, revoke } = world();
    connect().push([claude]);
    await read();
    revoke();
    expect(await read()).toBeNull();
  });
  it("carries typed engine calls over the existing request envelope and retains legacy commands", async () => {
    const { service, requests, connect } = world();
    connect();
    await vi.waitFor(() =>
      expect(service.connectionEpoch(scope.runnerId)).not.toBeUndefined()
    );
    expect(
      await service.callEngine(scope.runnerId, "engine.update.probe", {
        pids: [123],
      })
    ).toEqual({ alive: [false], version: "1.2.3" });
    expect(requests.at(-1)).toMatchObject({
      kind: "engine",
      operation: {
        type: "contract",
        call: { op: "engine.update.probe", request: { pids: [123] } },
      },
    });
    const legacy = await service.requestRunner(scope.runnerId, {
      kind: "engine",
      operation: { type: "status" },
    });
    legacy.channel?.destroy();
    expect(JSON.parse(legacy.value as string)).toEqual({ ok: true });
    expect(requests.at(-1)).toMatchObject({
      kind: "engine",
      operation: { type: "status" },
    });
    expect(Object.keys(requests.at(-1).operation)).toEqual(["type"]);
  });
  it("preserves typed failures and treats malformed results as an unknown outcome", async () => {
    const failed = world();
    failed.connect({
      reply: {
        ok: false,
        error: "Fixture busy",
        failure: {
          code: "busy",
          message: "Fixture busy",
          details: { phase: "updating" },
        },
      },
    });
    await vi.waitFor(() =>
      expect(failed.service.connectionEpoch(scope.runnerId)).not.toBeUndefined()
    );
    await expect(
      failed.service.callEngine(scope.runnerId, "engine.update.probe", {
        pids: [],
      })
    ).rejects.toMatchObject({ code: "busy", details: { phase: "updating" } });
    const corrupt = world();
    corrupt.connect({ reply: null });
    await vi.waitFor(() =>
      expect(
        corrupt.service.connectionEpoch(scope.runnerId)
      ).not.toBeUndefined()
    );
    await expect(
      corrupt.service.callEngine(scope.runnerId, "engine.update.probe", {
        pids: [],
      })
    ).rejects.toMatchObject({ code: "unknown_outcome" });
  });
  it("distinguishes a lost acknowledgement from a request never sent", async () => {
    const lost = world();
    lost.connect({ dropRequest: true });
    await vi.waitFor(() =>
      expect(lost.service.connectionEpoch(scope.runnerId)).not.toBeUndefined()
    );
    await expect(
      lost.service.callEngine(scope.runnerId, "engine.update.probe", {
        pids: [],
      })
    ).rejects.toMatchObject({ code: "unknown_outcome" });
    const absent = world();
    await expect(
      absent.service.callEngine(scope.runnerId, "engine.update.probe", {
        pids: [],
      })
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
