import { Duplex } from "node:stream";
import type { EngineInventoryEntry } from "@dispatch/runner-protocol/engine-management";
import { afterEach, describe, expect, it } from "vitest";

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
  function connect({ fenced = false } = {}) {
    const socket = Object.assign(
      new Duplex({
        read() {},
        write(chunk, _encoding, done) {
          done();
          for (const line of String(chunk).trim().split("\n")) {
            const frame = JSON.parse(line);
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
    local: { logins: {} as never, updates: {} as never },
    remote: remoteEngineTransport(service),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const read = async () => {
    await settle();
    return manager.inventory(scope);
  };
  return { connect, read, revoke: () => (approved = false) };
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
});
