import type { AddressInfo } from "node:net";
import { connect, type TLSSocket } from "node:tls";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { exchangeCode } from "../src/agents/remote/enrollment.js";
import { remoteEngineTransport } from "../src/agents/remote/engine-transport.js";
import {
  MANAGED_WORKSPACE,
  wireFrames,
  type EngineOperationEvent,
  type Frame,
} from "../src/agents/remote/protocol.js";
import { RunnerRegistry } from "../src/agents/remote/registry.js";
import { RemoteRunnerService } from "../src/agents/remote/service.js";
import { generateRunnerKey } from "../src/agents/remote/x509.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

const HOST = "127.0.0.1";

function parseCommand(command: string) {
  const value = (flag: string) =>
    new RegExp(`--${flag} (\\S+)`).exec(command)?.[1] ?? "";
  return {
    endpoint: value("endpoint"),
    pin: value("ca-sha256"),
    code: value("code"),
  };
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached");
}

/** A fake runner that answers `"engine"` requests the way runner.ts does. */
function dialEngineRunner(input: {
  endpoint: string;
  ca: string;
  cert: string;
  key: string;
  workspaces: string[];
  engineManagement?: boolean;
  onEngine?: (
    id: string,
    reply: (frame: Frame) => void,
    operation: unknown
  ) => void;
  inventoryEntries?: unknown[];
}) {
  const url = new URL(input.endpoint);
  return new Promise<{
    socket: TLSSocket;
    pushInventory: (entries: unknown) => void;
  }>((resolve, reject) => {
    const socket = connect({
      host: url.hostname,
      port: Number(url.port),
      ca: input.ca,
      cert: input.cert,
      key: input.key,
      rejectUnauthorized: true,
    });
    socket.on("error", reject);
    const send = wireFrames(socket, (frame) => {
      if (frame.type === "request" && frame.command.kind === "engine") {
        input.onEngine?.(frame.id, send, frame.command.operation);
      }
    });
    socket.once("secureConnect", () => {
      send({
        type: "ready",
        version: 1,
        health: true,
        ...(input.engineManagement !== false ? { engineManagement: true } : {}),
        workspaces: input.workspaces,
      });
      resolve({
        socket,
        pushInventory: (entries) =>
          send({ type: "engine_inventory", entries } as Frame),
      });
    });
  });
}

describe("engine wire integration", () => {
  let pool: Pool;
  const services: RemoteRunnerService[] = [];
  const sockets: TLSSocket[] = [];

  const makeService = () => {
    const service = new RemoteRunnerService(undefined, {
      registry: new RunnerRegistry(pool),
      host: HOST,
      endpointHost: HOST,
    });
    services.push(service);
    return service;
  };

  async function enroll(service: RemoteRunnerService, name: string) {
    const created = await service.createRegistration(name);
    const { endpoint, pin, code } = parseCommand(created.command);
    const runnerKey = generateRunnerKey();
    const enrolled = await exchangeCode({
      endpoint,
      pin,
      code,
      publicKey: runnerKey.publicKey,
    });
    return { created, endpoint, key: runnerKey.key, ...enrolled };
  }

  beforeAll(async () => {
    pool = await setupTestDb();
    await runTestMigrations();
  }, 60_000);

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const service of services.splice(0)) service.close();
    await pool.query("DELETE FROM runner_registrations");
    await pool.query("DELETE FROM runner_authority");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("round-trips an engine operation with streamed progress and a final ack", async () => {
    const service = makeService();
    const alpha = await enroll(service, "alpha");
    const { socket } = await dialEngineRunner({
      endpoint: alpha.endpoint,
      ca: alpha.ca,
      cert: alpha.cert,
      key: alpha.key,
      workspaces: [MANAGED_WORKSPACE],
      onEngine: (id, reply, operation) => {
        expect(operation).toEqual({ type: "update", engine: "claude" });
        const event: EngineOperationEvent = {
          type: "operation_progress",
          operationId: "op-1",
          engine: "claude",
          phase: "update",
          message: "Updating…",
        };
        reply({
          type: "data",
          id,
          data: Buffer.from(JSON.stringify(event) + "\n", "utf8").toString(
            "base64"
          ),
        });
        reply({
          type: "result",
          id,
          value: JSON.stringify({ ok: true, operationId: "op-1" }),
        });
      },
    });
    sockets.push(socket);
    await waitFor(() =>
      service.available({
        runner: alpha.created.id,
        workspace: MANAGED_WORKSPACE,
      })
    );

    const transport = remoteEngineTransport(service);
    const events: EngineOperationEvent[] = [];
    const ack = await transport.send(
      alpha.created.id,
      { type: "update", engine: "claude" },
      (event) => events.push(event)
    );
    expect(ack).toEqual({ ok: true, operationId: "op-1" });
    expect(events).toEqual([
      {
        type: "operation_progress",
        operationId: "op-1",
        engine: "claude",
        phase: "update",
        message: "Updating…",
      },
    ]);
  });

  it("routes engine commands over a configured-folder workspace when @session isn't advertised", async () => {
    const service = makeService();
    const alpha = await enroll(service, "alpha");
    const { socket } = await dialEngineRunner({
      endpoint: alpha.endpoint,
      ca: alpha.ca,
      cert: alpha.cert,
      key: alpha.key,
      // No MANAGED_WORKSPACE at all — a runner with only named folders
      // and no managed-session support, per the real runner.ts shape.
      workspaces: ["proof"],
      onEngine: (id, reply, operation) => {
        expect(operation).toEqual({ type: "status" });
        reply({ type: "result", id, value: JSON.stringify({ ok: true }) });
      },
    });
    sockets.push(socket);
    await waitFor(() =>
      service.available({ runner: alpha.created.id, workspace: "proof" })
    );

    const transport = remoteEngineTransport(service);
    const ack = await transport.send(alpha.created.id, { type: "status" });
    expect(ack).toEqual({ ok: true });
  });

  it("distinguishes a disconnected peer from a connected peer lacking engine management", async () => {
    const service = makeService();
    const alpha = await enroll(service, "alpha");
    const transport = remoteEngineTransport(service);
    const ack = await transport.send(alpha.created.id, { type: "status" });
    expect(ack).toMatchObject({
      ok: false,
      error: expect.stringContaining("disconnected"),
    });
    expect(ack).not.toHaveProperty("unsupported");
    let received = 0;
    const { socket } = await dialEngineRunner({
      ...alpha,
      workspaces: ["proof"],
      engineManagement: false,
      onEngine: () => {
        received++;
      },
    });
    sockets.push(socket);
    await waitFor(() =>
      service.available({ runner: alpha.created.id, workspace: "proof" })
    );
    expect(
      await transport.send(alpha.created.id, { type: "status" })
    ).toMatchObject({
      ok: false,
      unsupported: true,
    });
    expect(received).toBe(0);
  });

  it("stores and validates a pushed engine inventory, exposed via list()", async () => {
    const service = makeService();
    const alpha = await enroll(service, "alpha");
    const { socket, pushInventory } = await dialEngineRunner({
      endpoint: alpha.endpoint,
      ca: alpha.ca,
      cert: alpha.cert,
      key: alpha.key,
      workspaces: [MANAGED_WORKSPACE],
    });
    sockets.push(socket);
    await waitFor(() =>
      service.available({
        runner: alpha.created.id,
        workspace: MANAGED_WORKSPACE,
      })
    );

    const entries = [
      {
        id: "claude",
        label: "Claude Code",
        installed: true,
        signedIn: true,
        version: "1.2.3",
        actions: ["update", "login", "login_cancel"],
      },
    ];
    pushInventory(entries);
    await waitFor(
      () => service.engineInventorySnapshot(alpha.created.id) !== undefined
    );
    expect(service.engineInventorySnapshot(alpha.created.id)).toEqual(entries);
    const summary = (await service.list())[0];
    expect(summary?.engines).toEqual(entries);
    expect(summary?.engineManagement).toBe(true);
  });

  it("reports engineManagement false for a runner that never advertised it", async () => {
    const service = makeService();
    const alpha = await enroll(service, "alpha");
    const { socket } = await dialEngineRunner({
      endpoint: alpha.endpoint,
      ca: alpha.ca,
      cert: alpha.cert,
      key: alpha.key,
      workspaces: [MANAGED_WORKSPACE],
      engineManagement: false,
    });
    sockets.push(socket);
    await waitFor(() =>
      service.available({
        runner: alpha.created.id,
        workspace: MANAGED_WORKSPACE,
      })
    );
    expect((await service.list())[0]?.engineManagement).toBe(false);
  });

  it("drops the connection on a malformed pushed inventory", async () => {
    const service = makeService();
    const alpha = await enroll(service, "alpha");
    const { socket, pushInventory } = await dialEngineRunner({
      endpoint: alpha.endpoint,
      ca: alpha.ca,
      cert: alpha.cert,
      key: alpha.key,
      workspaces: [MANAGED_WORKSPACE],
    });
    sockets.push(socket);
    await waitFor(() =>
      service.available({
        runner: alpha.created.id,
        workspace: MANAGED_WORKSPACE,
      })
    );
    pushInventory([
      {
        id: "not-a-real-engine",
        label: "x",
        installed: true,
        signedIn: null,
        version: null,
        actions: [],
      },
    ]);
    await waitFor(() => socket.destroyed);
  });
});
