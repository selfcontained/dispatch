import { X509Certificate } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { connect, type TLSSocket } from "node:tls";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RunnerRegistry } from "../src/agents/remote/registry.js";
import { RemoteRunnerService } from "../src/agents/remote/service.js";
import {
  generateRunnerKey,
  runnerPublicKey,
} from "../src/agents/remote/x509.js";
import { wireFrames, type Frame } from "../src/agents/remote/protocol.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

const HOST = "127.0.0.1";

type FakeRunner = {
  socket: TLSSocket;
  closed: Promise<void>;
};

function dialRunner(input: {
  endpoint: string;
  ca: string;
  cert: string;
  key: string;
  workspaces: string[];
}): Promise<FakeRunner> {
  const url = new URL(input.endpoint);
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: url.hostname,
      port: Number(url.port),
      ca: input.ca,
      cert: input.cert,
      key: input.key,
      rejectUnauthorized: true,
    });
    const closed = new Promise<void>((done) => socket.on("close", done));
    socket.on("error", reject);
    const send = wireFrames(socket, () => {});
    socket.once("secureConnect", () => {
      send({
        type: "ready",
        version: 1,
        workspaces: input.workspaces,
      } as Frame);
      resolve({ socket, closed });
    });
  });
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached");
}

describe("runner-initiated connect enrollment", () => {
  let pool: Pool;
  let api: http.Server;
  const services: RemoteRunnerService[] = [];
  const runners: FakeRunner[] = [];

  const makeService = () => {
    const service = new RemoteRunnerService(
      undefined,
      { registry: new RunnerRegistry(pool), host: HOST, endpointHost: HOST },
      {
        host: HOST,
        port: (api.address() as AddressInfo).port,
        tls: false,
      }
    );
    services.push(service);
    return service;
  };

  beforeAll(async () => {
    pool = await setupTestDb();
    await runTestMigrations();
    api = http.createServer((_request, response) => response.end("api"));
    await new Promise<void>((resolve) => api.listen(0, HOST, resolve));
  }, 60_000);

  afterEach(async () => {
    for (const runner of runners.splice(0)) runner.socket.destroy();
    for (const service of services.splice(0)) service.close();
    await pool.query("DELETE FROM runner_connect_requests");
    await pool.query("DELETE FROM runner_registrations");
    await pool.query("DELETE FROM runner_authority");
  });

  afterAll(async () => {
    api?.close();
    await teardownTestDb();
  });

  it("creates a pending request the runner can poll before approval", async () => {
    const service = makeService();
    const { publicKey } = generateRunnerKey();
    const created = await service.createConnectRequest(
      publicKey,
      `${HOST}:9999`
    );
    expect(created.id).toMatch(/^conn_/);
    expect(created.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(created.approveUrl).toBe(
      `https://${HOST}:9999/settings/connections`
    );
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now());

    expect(await service.pollConnectRequest(created.id)).toEqual({
      status: "pending",
    });
    const pending = await service.listConnectRequests();
    expect(pending).toEqual([
      {
        id: created.id,
        createdAt: expect.any(String),
        expiresAt: created.expiresAt,
      },
    ]);
  });

  it("rejects a malformed public key", async () => {
    const service = makeService();
    await expect(
      service.createConnectRequest("not a key", undefined)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("approves with the correct code, binds the key, and lets the runner connect", async () => {
    const service = makeService();
    const { key, publicKey } = generateRunnerKey();
    const created = await service.createConnectRequest(publicKey);

    const approved = await service.approveConnectRequest(
      created.id,
      created.code,
      "alpha",
      HOST
    );
    expect(approved.name).toBe("alpha");
    expect(approved.id).toMatch(/^rnr_[a-f0-9]+$/);

    const polled = await service.pollConnectRequest(created.id);
    expect(polled).toMatchObject({
      status: "approved",
      id: approved.id,
      name: "alpha",
    });
    const { cert, ca, endpoint } = polled as Extract<
      typeof polled,
      { status: "approved" }
    >;
    // Key-bound: the issued leaf is for the key submitted at request time.
    const leaf = new X509Certificate(cert);
    expect(
      leaf.publicKey.export({ type: "spki", format: "pem" }).toString()
    ).toBe(publicKey);
    expect(leaf.subject).toBe(`CN=${approved.id}`);

    // Repeated polls after approval are idempotent.
    expect(await service.pollConnectRequest(created.id)).toEqual(polled);

    runners.push(
      await dialRunner({ endpoint, ca, cert, key, workspaces: ["proof"] })
    );
    await waitFor(() =>
      service.available({ runner: approved.id, workspace: "proof" })
    );
  });

  it("rejects an unsupported key before any code exists", () => {
    expect(() => runnerPublicKey("not a key")).toThrow();
  });

  it("bounds wrong-code attempts and then voids the request", async () => {
    const service = makeService();
    const { publicKey } = generateRunnerKey();
    const created = await service.createConnectRequest(publicKey);

    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(
        service.approveConnectRequest(created.id, "0000-0000", "alpha", HOST)
      ).rejects.toMatchObject({ status: 400 });
    }
    // The 5th wrong attempt voids the request outright.
    await expect(
      service.approveConnectRequest(created.id, "0000-0000", "alpha", HOST)
    ).rejects.toMatchObject({ status: 404 });
    // Even the correct code no longer works.
    await expect(
      service.approveConnectRequest(created.id, created.code, "alpha", HOST)
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.pollConnectRequest(created.id)).toEqual({
      status: "denied",
    });
  });

  it("rejects duplicate names the same way ordinary registration does", async () => {
    const service = makeService();
    await service.createRegistration("dup");
    const { publicKey } = generateRunnerKey();
    const created = await service.createConnectRequest(publicKey);
    await expect(
      service.approveConnectRequest(created.id, created.code, "dup", HOST)
    ).rejects.toMatchObject({ status: 409 });
  });

  it("denies a pending request and stops the runner's poll from ever approving", async () => {
    const service = makeService();
    const { publicKey } = generateRunnerKey();
    const created = await service.createConnectRequest(publicKey);
    await service.denyConnectRequest(created.id);
    expect(await service.pollConnectRequest(created.id)).toEqual({
      status: "denied",
    });
    await expect(
      service.approveConnectRequest(created.id, created.code, "alpha", HOST)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reports an expired request once its code has timed out", async () => {
    const service = makeService();
    const { publicKey } = generateRunnerKey();
    const created = await service.createConnectRequest(publicKey);
    await pool.query(
      `UPDATE runner_connect_requests SET code_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [created.id]
    );
    expect(await service.pollConnectRequest(created.id)).toEqual({
      status: "expired",
    });
    await expect(
      service.approveConnectRequest(created.id, created.code, "alpha", HOST)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("404s approving or denying an unknown request id", async () => {
    const service = makeService();
    await expect(
      service.approveConnectRequest("conn_missing", "x", "alpha", HOST)
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.denyConnectRequest("conn_missing")
    ).rejects.toMatchObject({ status: 404 });
  });
});
