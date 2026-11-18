import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, createServer, type TLSSocket } from "node:tls";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectCliCommand,
  runRunnerConnect,
} from "../src/agents/remote/enrollment.js";
import { RunnerRegistry } from "../src/agents/remote/registry.js";
import { RemoteRunnerService } from "../src/agents/remote/service.js";
import {
  generateRunnerKey,
  issueAuthority,
  issueServer,
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
  let activeService: RemoteRunnerService | undefined;
  const services: RemoteRunnerService[] = [];
  const runners: FakeRunner[] = [];

  const makeService = (approvalOrigin?: string) => {
    const service = new RemoteRunnerService(
      undefined,
      {
        registry: new RunnerRegistry(pool),
        host: HOST,
        endpointHost: HOST,
        approvalOrigin,
      },
      {
        host: HOST,
        port: (api.address() as AddressInfo).port,
        tls: false,
      }
    );
    services.push(service);
    activeService = service;
    return service;
  };

  beforeAll(async () => {
    pool = await setupTestDb();
    await runTestMigrations();
    // Stands in for the real Fastify app the listener proxies to: just
    // enough of /api/runners/connect(...) to prove the proxy path works,
    // delegating to whichever service this test created.
    api = http.createServer((request, response) => {
      const url = request.url ?? "";
      const send = (status: number, body: unknown) => {
        const text = JSON.stringify(body);
        response.writeHead(status, { "content-type": "application/json" });
        response.end(text);
      };
      if (url === "/api/runners/connect" && request.method === "POST") {
        let raw = "";
        request.on("data", (chunk) => (raw += chunk));
        request.on("end", async () => {
          try {
            const body = JSON.parse(raw || "{}") as { publicKey?: unknown };
            send(
              201,
              await activeService!.createConnectRequest(body.publicKey)
            );
          } catch (error) {
            send((error as { status?: number }).status ?? 500, {
              error: (error as Error).message,
            });
          }
        });
        return;
      }
      const pollId = /^\/api\/runners\/connect\/([^/]+)$/.exec(url)?.[1];
      if (pollId && request.method === "GET") {
        activeService!
          .pollConnectRequest(pollId)
          .then((result) => send(200, result))
          .catch((error) =>
            send((error as { status?: number }).status ?? 500, {
              error: (error as Error).message,
            })
          );
        return;
      }
      response.end("api");
    });
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
    const created = await service.createConnectRequest(publicKey);
    expect(created.id).toMatch(/^conn_/);
    expect(created.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(created.approveUrl).toBe(
      `http://${HOST}:${(api.address() as AddressInfo).port}/settings/connections`
    );

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

  it("offers an approval link, including over plain HTTP for a dev frontend, when the web UI uses a separate origin", async () => {
    const service = makeService("http://localhost:5173");
    const { publicKey } = generateRunnerKey();
    const created = await service.createConnectRequest(publicKey);
    expect(created.approveUrl).toBe(
      "http://localhost:5173/settings/connections"
    );
    const built = await service.connectCommand(HOST);
    expect(built.approveUrl).toBe(created.approveUrl);
    expect(built.command).not.toContain("localhost:5173");
  });

  it("rejects a malformed DISPATCH_RUNNER_APPROVAL_ORIGIN", () => {
    expect(
      () =>
        new RemoteRunnerService(undefined, {
          registry: new RunnerRegistry(pool),
          host: HOST,
          approvalOrigin: "https://example.com/settings",
        })
    ).toThrow(/bare origin/);
    expect(
      () =>
        new RemoteRunnerService(undefined, {
          registry: new RunnerRegistry(pool),
          host: HOST,
          approvalOrigin: "ftp://example.com",
        })
    ).toThrow(/http\(s\)/);
  });

  it("rejects a malformed public key", async () => {
    const service = makeService();
    await expect(
      service.createConnectRequest("not a key")
    ).rejects.toMatchObject({ status: 400 });
  });

  it("keeps the copied service address reusable across runner registrations", async () => {
    const service = makeService();
    const first = await service.connectCommand(HOST);
    expect((await service.connectCommand(HOST)).command).toBe(first.command);
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

  it("runs the real CLI end-to-end over the runner listener's own pinned HTTPS (no main API HTTPS needed)", async () => {
    const service = makeService();
    const { command } = await service.connectCommand(HOST);
    const [, endpoint] =
      /^sudo dispatch-runner connect '(https:\/\/[^']+)'$/.exec(command) ?? [];
    const dir = await mkdtemp(path.join(tmpdir(), "connect-cli-"));

    const printed: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    };

    const connectPromise = runRunnerConnect([endpoint!, "--dir", dir]).finally(
      () => {
        process.stdout.write = originalWrite;
      }
    );

    let id: string | undefined;
    let code: string | undefined;
    await waitFor(async () => {
      const pending = await service.listConnectRequests();
      id = pending[0]?.id;
      code = /Code: (\S+)/.exec(printed.join(""))?.[1];
      return Boolean(id && code);
    });
    // The UI's own last-8-characters reference matches what the CLI prints.
    expect(printed.join("")).toContain(`Request: ${id!.slice(-8)}`);

    expect(printed.join("")).toContain(
      `Approve at: http://${HOST}:${(api.address() as AddressInfo).port}/settings/connections`
    );
    await service.approveConnectRequest(id!, code!, "zeta", HOST);
    await connectPromise;

    const cert = await readFile(path.join(dir, "cert.pem"), "utf8");
    const key = await readFile(path.join(dir, "key.pem"), "utf8");
    const ca = await readFile(path.join(dir, "ca.pem"), "utf8");
    const leaf = new X509Certificate(cert);
    expect(leaf.subject).toMatch(/^CN=rnr_[a-f0-9]+$/);
    const registrationId = leaf.subject.replace("CN=", "");

    runners.push(
      await dialRunner({
        endpoint: new URL(endpoint!).origin,
        ca,
        cert,
        key,
        workspaces: ["proof"],
      })
    );
    await waitFor(() =>
      service.available({ runner: registrationId, workspace: "proof" })
    );
  }, 20_000);
});

describe("pinned connect bootstrap", () => {
  it("rejects a leaf from another CA even though the peer echoes the real pinned CA", async () => {
    const real = issueAuthority("real");
    const rogue = issueAuthority("rogue");
    const leaf = issueServer(rogue, [HOST]);
    const received: unknown[] = [];
    const server = connectServer(leaf, rogue, (frame, send, socket) => {
      received.push(frame);
      if ((frame as { type?: string }).type === "ca_request") {
        send({ type: "ca", ca: real.cert } as never);
        socket.end();
      } else socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
    const port = (server.address() as AddressInfo).port;
    const pin = new X509Certificate(real.cert).fingerprint256
      .replace(/:/g, "")
      .toLowerCase();
    try {
      const dir = await mkdtemp(path.join(tmpdir(), "connect-rogue-"));
      // The bootstrap step alone succeeds — the real CA is exactly what was
      // pinned — so a failure here must come from the second, real request
      // refusing the rogue leaf, not from the CA check itself.
      await expect(
        runRunnerConnect([
          "--service",
          `https://${HOST}:${port}`,
          "--ca-sha256",
          pin,
          "--dir",
          dir,
        ])
      ).rejects.toThrow();
      expect(received).toEqual([{ type: "ca_request", version: 1 }]);
    } finally {
      server.close();
    }
  });
});

function connectServer(
  leaf: { cert: string; key: string },
  ca: { cert: string },
  onFrame: (
    frame: unknown,
    send: (frame: unknown) => void,
    socket: TLSSocket
  ) => void
) {
  return createServer(
    { cert: leaf.cert + ca.cert, key: leaf.key },
    (socket: TLSSocket) => {
      socket.on("error", () => {});
      const send = wireFrames(socket, (frame) =>
        onFrame(frame, send as never, socket)
      );
    }
  );
}

describe("connect command shell safety", () => {
  it("copies a single service URL with the private CA fingerprint", () => {
    const command = connectCliCommand({
      host: "runner.example",
      port: 12345,
      caFingerprint: "AB".repeat(32),
    });
    expect(command).toBe(
      `sudo dispatch-runner connect 'https://runner.example:12345/#sha256=${Buffer.alloc(32, 0xab).toString("base64url")}'`
    );
  });

  it("rejects malformed or conflicting URL fingerprints before enrollment", async () => {
    await expect(
      runRunnerConnect(["https://example.org/#sha256=oops"])
    ).rejects.toThrow(/Invalid service URL fingerprint/);
    const encoded = Buffer.alloc(32, 1).toString("base64url");
    await expect(
      runRunnerConnect([
        `https://example.org/#sha256=${encoded}`,
        "--ca-sha256",
        "00".repeat(32),
      ])
    ).rejects.toThrow(/Conflicting service fingerprints/);
  });

  it("CLI rejects a non-http(s) --approval-url before contacting the service", async () => {
    await expect(
      runRunnerConnect([
        "--service",
        "https://127.0.0.1:1",
        "--ca-sha256",
        "ab".repeat(32),
        "--approval-url",
        "javascript:alert(1)",
      ])
    ).rejects.toThrow(/--approval-url must be an http\(s\) URL/);
  });
});
