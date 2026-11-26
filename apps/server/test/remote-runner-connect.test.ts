import { connectCliCommand } from "../src/agents/remote/enrollment-commands.js";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, createServer, type TLSSocket } from "node:tls";
import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runRunnerConnect } from "../../../packages/runner/src/workload/agents/remote/enrollment.js";
import { RunnerRegistry } from "../src/agents/remote/registry.js";
import { RemoteRunnerService } from "../src/agents/remote/service.js";
import { generateRunnerKey } from "../../../packages/runner/src/workload/agents/remote/x509.js";
import {
  issueAuthority,
  issueServer,
  runnerPublicKey,
} from "../src/agents/remote/certificate-authority.js";
import {
  type EnrollmentRequest,
  type EnrollmentReply,
} from "../../../packages/runner/src/workload/agents/remote/protocol.js";
import { wireFrames } from "@dispatch/runner-client/v1/node";
import type { StreamFrame } from "@dispatch/runner-client/v1/node";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

const HOST = "127.0.0.1";

type FakeRunner = {
  socket: TLSSocket;
  closed: Promise<void>;
  send: (frame: StreamFrame) => void;
};

function dialRunner(input: {
  endpoint: string;
  ca: string;
  cert: string;
  key: string;
  onFrame?: (frame: StreamFrame) => void;
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
    const send = wireFrames<{ id: number; op?: string } | StreamFrame, unknown>(
      socket,
      (frame) => {
        if ("op" in frame && frame.op) {
          if (frame.op === "runner.describe")
            send({
              id: frame.id,
              ok: true,
              value: {
                runnerId: "fixture",
                displayName: "fixture",
                build: { version: "" },
                protocol: 1,
                engines: [],
                capabilities: {},
              },
            });
          else
            send({
              id: frame.id,
              ok: false,
              error: { code: "unavailable", message: "No sample" },
            });
        } else input.onFrame?.(frame as StreamFrame);
      }
    );
    socket.once("secureConnect", () => resolve({ socket, closed, send }));
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
  const stalled = new Set<http.ServerResponse>();
  const services: RemoteRunnerService[] = [];
  const runners: FakeRunner[] = [];

  const makeService = (approvalOrigin?: string) => {
    const service = new RemoteRunnerService(
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
      if (url === "/api/v1/runner-artifacts/install") {
        response.end(
          `script for ${request.headers["x-dispatch-runner-listener"] ?? "web"}`
        );
        return;
      }
      if (url.startsWith("/api/v1/runner-artifacts/")) {
        const status = url.includes("/deadbeef/") ? 404 : 200;
        response.writeHead(status, {
          "content-type": "application/gzip",
          "content-disposition":
            'attachment; filename="dispatch-runner-linux-x64.tar.gz"',
        });
        response.flushHeaders();
        if (url.includes("/feed123/")) {
          const timer = setInterval(() => response.write("chunk"), 20);
          response.once("close", () => clearInterval(timer));
          return;
        }
        if (url.includes("/abc4321/") || status === 404) {
          stalled.add(response);
          response.on("close", () => stalled.delete(response));
          if (status === 200) {
            // Overfill the client receive buffer without buffering in the test.
            const chunk = Buffer.alloc(256 * 1024);
            const flood = () => {
              while (!response.destroyed && response.write(chunk)) {}
              if (!response.destroyed) response.once("drain", flood);
            };
            flood();
          } else {
            response.write("missing revision");
          }
          return;
        }
        // Slower than the shortened handshake bound used below, after
        // upstream has confirmed which file it is serving.
        if (request.method === "HEAD") response.end();
        else setTimeout(() => response.end("archive"), 600);
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
      `http://${HOST}:${(api.address() as AddressInfo).port}/settings/runners`
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
    expect(created.approveUrl).toBe("http://localhost:5173/settings/runners");
    const built = await service.connectCommand(HOST);
    expect(built.approveUrl).toBe(created.approveUrl);
    expect(built.command).not.toContain("localhost:5173");
  });

  it("rejects a malformed DISPATCH_RUNNER_APPROVAL_ORIGIN", () => {
    expect(
      () =>
        new RemoteRunnerService({
          registry: new RunnerRegistry(pool),
          host: HOST,
          approvalOrigin: "https://example.com/settings",
        })
    ).toThrow(/bare origin/);
    expect(
      () =>
        new RemoteRunnerService({
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

    runners.push(await dialRunner({ endpoint, ca, cert, key }));
    await waitFor(() => service.available(approved.id));
  });

  it("acknowledges stream credit on the enrolled TLS connection", async () => {
    const service = makeService();
    const { key, publicKey } = generateRunnerKey();
    const { id, code } = await service.createConnectRequest(publicKey);
    await service.approveConnectRequest(id, code, "stream-capable", HOST);
    const polled = await service.pollConnectRequest(id);
    if (polled.status !== "approved")
      throw new Error("Runner approval missing");
    const { ca, cert, endpoint } = polled;
    const frames: StreamFrame[] = [];
    const runner = await dialRunner({
      endpoint,
      ca,
      cert,
      key,

      onFrame: (frame) => frames.push(frame),
    });
    runners.push(runner);
    await waitFor(() => service.connectedRunnerIds().length === 1);
    runner.send({ type: "stream", action: "open", id: "unregistered" });
    await waitFor(() => frames.length > 0);
    expect(frames[0]).toEqual({
      type: "stream",
      action: "cancel",
      id: "unregistered",
      code: "invalid",
    });
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

  it("rejects malformed creation and unknown polling replies before writing credentials", async () => {
    const service = makeService();
    const { command } = await service.connectCommand(HOST);
    const [, endpoint] =
      /^sudo dispatch-runner connect '(https:\/\/[^']+)'$/.exec(command) ?? [];
    const dir = await mkdtemp(path.join(tmpdir(), "malformed-connect-cli-"));
    const create = service.createConnectRequest.bind(service);
    const createReply = vi.spyOn(service, "createConnectRequest");
    const pollReply = vi.spyOn(service, "pollConnectRequest");
    try {
      createReply.mockImplementationOnce(async (key) => {
        const reply = await create(key);
        return { ...reply, expiresAt: "invalid" };
      });
      await expect(runRunnerConnect([endpoint!, "--dir", dir])).rejects.toThrow(
        "Invalid connect creation response"
      );
      expect(pollReply).not.toHaveBeenCalled();
      pollReply.mockResolvedValueOnce(JSON.parse('{"status":"future-status"}'));
      await expect(runRunnerConnect([endpoint!, "--dir", dir])).rejects.toThrow(
        "Invalid connect polling response"
      );
      expect(pollReply).toHaveBeenCalledTimes(1);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      createReply.mockRestore();
      pollReply.mockRestore();
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("relays the install script under its pinned key and release downloads past the handshake bound", async () => {
    const service = makeService();
    Object.defineProperty(service, "handshakeTimeout", { value: 200 });
    const { origin, pin } = await service.artifactEndpoint(HOST);
    const get = (
      url: string,
      options: https.RequestOptions
    ): Promise<{ status: number; body: string; pin?: string }> =>
      new Promise((resolve, reject) => {
        https
          .request(url, { agent: false, ...options }, (response) => {
            const peer = (response.socket as TLSSocket).getPeerCertificate();
            let body = "";
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body,
                pin: peer.raw
                  ? createHash("sha256")
                      .update(
                        new X509Certificate(peer.raw).publicKey.export({
                          type: "spki",
                          format: "der",
                        })
                      )
                      .digest("base64")
                  : undefined,
              })
            );
          })
          .on("error", reject)
          .end();
      });
    // What curl --pinnedpubkey checks: the leaf's SubjectPublicKeyInfo.
    const script = await get(`${origin}/install`, {
      rejectUnauthorized: false,
      headers: { "x-dispatch-runner-listener": "https://attacker.test:1" },
    });
    expect(script).toEqual({
      status: 200,
      body: `script for ${origin}`,
      pin,
    });
    const via = await get(`${origin}/install`, {
      rejectUnauthorized: false,
      headers: { host: `other.test:${new URL(origin).port}` },
    });
    expect(via.body).toBe(
      `script for https://other.test:${new URL(origin).port}`
    );
    const listener = service.listenerInstall()!;
    expect(listener.pin).toBe(pin);
    // The CA no longer has a route of its own; the pinned script carries it.
    expect(
      (
        await get(`${origin}/api/v1/runner-artifacts/ca.pem`, {
          rejectUnauthorized: false,
        })
      ).status
    ).toBe(404);
    expect(
      (
        await get(`${origin}/install`, {
          rejectUnauthorized: false,
          method: "POST",
        })
      ).status
    ).toBe(404);

    const pinned = { ca: listener.caPem, rejectUnauthorized: true };
    const archive = `${origin}/api/v1/runner-artifacts/abc1234/dispatch-runner-linux-x64.tar.gz`;
    for (const file of [
      "install-dispatch-runner-linux-arm64.sh",
      "install-dispatch-runner-linux-arm64.sh.sigstore.json",
    ]) {
      const bootstrap = `${origin}/api/v1/runner-artifacts/abc1234/${file}`;
      expect((await get(bootstrap, pinned)).status).toBe(200);
    }
    expect(await get(archive, pinned)).toMatchObject({
      status: 200,
      body: "archive",
    });
    expect((await get(archive, { ...pinned, method: "HEAD" })).status).toBe(
      200
    );
    const update = `/api/v1/runner-artifacts/abc1234/update/1.2.3/linux/arm64/${"a".repeat(64)}`;
    for (const resource of [
      ...["manifest.json", "dispatch-runner", "dispatch-runner.gz"].map(
        (file) => `${origin}${update}/${file}`
      ),
      `${origin}${update.replace("/abc1234/", "/")}/dispatch-runner.gz`,
    ]) {
      expect((await get(resource, pinned)).status).toBe(200);
      expect((await get(resource, { ...pinned, method: "HEAD" })).status).toBe(
        200
      );
      expect(
        (await get(resource, { ...pinned, method: "DELETE" })).status
      ).toBe(404);
    }
    for (const path of [
      "/api/v1/runner-artifacts/abc1234/package.json",
      "/api/v1/runner-artifacts/abc1234/../../runners",
      `${update}/package.json`,
      `${update}/manifest%2ejson`,
      `${update}/manifest.json?alias`,
      `${update}/dispatch-runner.tgz`,
      `${update.replace("/abc1234/", "//")}/dispatch-runner.gz`,
      `${update.replace("/arm64/", "/amd64/")}/dispatch-runner`,
      `${update.slice(0, -1)}/dispatch-runner`,
    ])
      expect((await get(`${origin}${path}`, pinned)).status).toBe(404);
    expect((await get(archive, { ...pinned, method: "DELETE" })).status).toBe(
      404
    );
  });

  function artifactRequest(origin: string, revision: string) {
    const options = { agent: false as const, rejectUnauthorized: false };
    const request = https.get(
      `${origin}/api/v1/runner-artifacts/${revision}/dispatch-runner-linux-x64.tar.gz`,
      options
    );
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
    });
    return { request, response };
  }

  it("limits stalled artifact downloads without using up runner enrollment slots", async () => {
    const service = makeService();
    // Long enough to hold the admitted readers while more than 64 try.
    const { origin } = await service.artifactEndpoint(HOST);
    const admitted = Array.from({ length: 8 }, () =>
      artifactRequest(origin, "abc4321")
    );
    try {
      for (const response of await Promise.all(
        admitted.map(({ response }) => response)
      )) {
        expect(response.statusCode).toBe(200);
        response.pause();
      }
      for (let attempt = 0; attempt < 65; attempt++) {
        const { request, response } = artifactRequest(origin, "abc4321");
        try {
          const reply = await response;
          expect(reply.statusCode).toBe(503);
          expect(reply.headers["retry-after"]).toBeTruthy();
          reply.resume();
        } finally {
          request.destroy();
        }
      }
      expect(stalled.size).toBe(8);
      // Check the shared budget directly as well: keeping eight slots for
      // downloads would still let a single enrollment through.
      expect(Reflect.get(service, "unauthenticated")).toBe(0);
      const body = JSON.stringify({ publicKey: generateRunnerKey().publicKey });
      const response = await new Promise<http.IncomingMessage>(
        (resolve, reject) => {
          https
            .request(
              `${origin}/api/runners/connect`,
              {
                method: "POST",
                rejectUnauthorized: false,
                agent: false,
                headers: {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(body),
                },
              },
              resolve
            )
            .once("error", reject)
            .end(body);
        }
      );
      expect(response.statusCode).toBe(201);
      response.resume();
    } finally {
      for (const { request } of admitted) request.destroy();
      await waitFor(() => stalled.size === 0);
    }
  });

  it("drops an artifact reader when writes stop making progress", async () => {
    const service = makeService();
    Object.defineProperty(service, "artifactIdleTimeout", { value: 100 });
    const { origin } = await service.artifactEndpoint(HOST);
    const { request, response } = artifactRequest(origin, "abc4321");
    try {
      const reply = await response;
      expect(reply.statusCode).toBe(200);
      reply.socket.pause();
      expect(stalled.size).toBe(1);
      await waitFor(() => stalled.size === 0);
    } finally {
      request.destroy();
      await waitFor(() => stalled.size === 0);
    }
  });

  it("refreshes the idle bound on writes but still caps a progressing download", async () => {
    const service = makeService();
    Object.defineProperty(service, "artifactIdleTimeout", { value: 100 });
    Object.defineProperty(service, "artifactDownloadTimeout", { value: 500 });
    const { origin } = await service.artifactEndpoint(HOST);
    const { request, response } = artifactRequest(origin, "feed123");
    try {
      const reply = await response;
      let received = 0;
      reply.on("data", (chunk: Buffer) => (received += chunk.length));
      await waitFor(() => reply.destroyed);
      expect(received).toBeGreaterThanOrEqual(50);
    } finally {
      request.destroy();
    }
  });

  it("keeps a nonexistent revision on the short timeout even after upstream headers", async () => {
    const service = makeService();
    Object.defineProperty(service, "handshakeTimeout", { value: 100 });
    const { origin } = await service.artifactEndpoint(HOST);
    const { request, response } = artifactRequest(origin, "deadbeef");
    try {
      const reply = await response;
      expect(reply.statusCode).toBe(404);
      expect(stalled.size).toBe(1);
      await waitFor(() => stalled.size === 0);
    } finally {
      request.destroy();
      await waitFor(() => stalled.size === 0);
    }
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
      `Approve at: http://${HOST}:${(api.address() as AddressInfo).port}/settings/runners`
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
      })
    );
    await waitFor(() => service.available(registrationId));
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
      if (frame.type === "ca_request") {
        send({ type: "ca", ca: real.cert });
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
    frame: EnrollmentRequest,
    send: (frame: EnrollmentReply) => void,
    socket: TLSSocket
  ) => void
) {
  return createServer(
    { cert: leaf.cert + ca.cert, key: leaf.key },
    (socket: TLSSocket) => {
      socket.on("error", () => {});
      const send = wireFrames<EnrollmentRequest, EnrollmentReply>(
        socket,
        (frame) => onFrame(frame, send, socket)
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

describe("connect HTTP response body", () => {
  async function expectFailure(
    respond: (socket: TLSSocket) => void,
    message: string
  ) {
    const authority = issueAuthority("response fixture");
    const leaf = issueServer(authority, [HOST]);
    const sockets = new Set<TLSSocket>();
    const server = createServer(
      { cert: leaf.cert + authority.cert, key: leaf.key },
      (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        let request = "";
        const receive = (chunk: Buffer) => {
          request += chunk.toString("utf8");
          if (request.startsWith("{")) {
            if (!request.includes("\n")) return;
            socket.off("data", receive);
            socket.end(
              JSON.stringify({ type: "ca", ca: authority.cert }) + "\n"
            );
          } else if (request.includes("\r\n\r\n")) {
            socket.off("data", receive);
            respond(socket);
          }
        };
        socket.on("data", receive);
      }
    );
    const dir = await mkdtemp(path.join(tmpdir(), "connect-response-"));
    try {
      await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
      const { port } = server.address() as AddressInfo;
      const pin = new X509Certificate(authority.cert).fingerprint256.replaceAll(
        ":",
        ""
      );
      await expect(
        runRunnerConnect([
          `https://${HOST}:${port}`,
          "--ca-sha256",
          pin,
          "--dir",
          dir,
        ])
      ).rejects.toThrow(message);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { force: true, recursive: true });
    }
  }

  const chunked = (status: string) =>
    `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`;

  function writeChunk(socket: TLSSocket, chunk: Buffer) {
    socket.write(chunk.length.toString(16) + "\r\n");
    socket.write(chunk);
    socket.write("\r\n");
  }

  it("rejects a response interrupted before the declared body is complete", async () => {
    await expectFailure((socket) => {
      const partial = JSON.stringify({
        id: "fixture-id",
        code: "TEST-CODE",
        expiresAt: "2099-01-01T00:00:00Z",
      });
      socket.end(
        `HTTP/1.1 201 Created\r\nContent-Length: ${Buffer.byteLength(partial) + 1}\r\nConnection: close\r\n\r\n${partial}`
      );
    }, "The service interrupted its response.");
  }, 5_000);

  it("rejects a chunked response once its total byte count exceeds 64 KiB", async () => {
    await expectFailure((socket) => {
      socket.write(chunked("201 Created"));
      const chunk = Buffer.from("é".repeat(20 * 1024));
      writeChunk(socket, chunk);
      writeChunk(socket, chunk);
      // Leave the response open so waiting for end would hang.
    }, "The service response is too large.");
  }, 5_000);

  it("preserves a multibyte character split across response chunks", async () => {
    await expectFailure((socket) => {
      const body = Buffer.from(JSON.stringify({ error: "Service says 🧪" }));
      const split = body.indexOf(Buffer.from("🧪")) + 2;
      socket.write(chunked("400 Bad Request"));
      writeChunk(socket, body.subarray(0, split));
      writeChunk(socket, body.subarray(split));
      socket.end("0\r\n\r\n");
    }, "Service says 🧪");
  });
});
