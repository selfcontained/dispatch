import { scopedEngineCalls } from "../src/runners/local.js";
import { Duplex } from "node:stream";
import type { EngineInventoryEntry } from "@dispatch/runner-protocol/engine-management";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineManager } from "../src/agents/remote/engine-manager.js";

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
    let entries: EngineInventoryEntry[] = [claude];
    const socket = Object.assign(
      new Duplex({
        read() {},
        write(chunk, _encoding, done) {
          done();
          for (const line of String(chunk).trim().split("\n")) {
            const frame = JSON.parse(line);
            const { id, op } = frame;
            const answer = (result: object) =>
              queueMicrotask(() =>
                socket.push(JSON.stringify({ id, ...result }) + "\n")
              );
            if (op === "runner.describe")
              answer({
                ok: true,
                value: {
                  runnerId: scope.runnerId,
                  displayName: "Fixture",
                  build: { version: "1" },
                  protocol: 1,
                  engines: [],
                  capabilities: {},
                },
              });
            else if (op === "runner.health")
              answer({
                ok: false,
                error: { code: "unavailable", message: "No sample" },
              });
            else if (fenced)
              answer({
                ok: false,
                error: { code: "fenced", message: "Updating" },
              });
            else if (op === "engine.list")
              queueMicrotask(() => answer({ ok: true, value: { entries } }));
            else {
              requests.push(frame);
              if (dropRequest) queueMicrotask(() => socket.destroy());
              else if (reply && typeof reply === "object" && "failure" in reply)
                answer({ ok: false, error: reply.failure });
              else
                answer({
                  ok: true,
                  value:
                    reply === undefined
                      ? { alive: [false], version: "1.2.3" }
                      : reply,
                });
            }
          }
        },
      }),
      { setKeepAlive() {} }
    );
    sockets.push(socket);
    (service as any).attachPeer(socket, {
      key: scope.runnerId,
      approved: () => approved,
      allows: () => true,
    });
    return {
      push: (next: EngineInventoryEntry[]) => {
        entries = next;
      },
      drop: () => socket.destroy(),
    };
  }
  const manager = new EngineManager({
    engineActions: {
      models: () => ({ defaultModel: null, models: [] }),
      usage: () => {
        throw new Error("Unexpected fixture usage request");
      },
      calls: (target) => scopedEngineCalls({} as never, service, target),
      updates: () => ({}) as never,
    },
    local: { engines: {} as never, updates: {} as never },
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

  it("reads the inventory from the new connection", async () => {
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
  it("sends the typed probe directly on the authenticated connection", async () => {
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
      op: "engine.update.probe",
      input: { pids: [123] },
    });
  });
  it("preserves typed failures and rejects malformed probe results", async () => {
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
    ).rejects.toMatchObject({ code: "failed" });
  });
  it("distinguishes a lost acknowledgement from a request never sent", async () => {
    const lost = world();
    lost.connect({ dropRequest: true });
    await vi.waitFor(() =>
      expect(lost.service.connectionEpoch(scope.runnerId)).not.toBeUndefined()
    );
    await expect(
      lost.service.call(scope.runnerId, "engine.update.release", {
        operationId: "fixture",
      })
    ).rejects.toMatchObject({ code: "unknown_outcome" });
    const absent = world();
    await expect(
      absent.service.call(scope.runnerId, "engine.update.release", {
        operationId: "fixture",
      })
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
