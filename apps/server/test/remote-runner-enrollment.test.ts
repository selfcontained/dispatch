import { X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { connect, type TLSSocket } from "node:tls";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { exchangeCode } from "../src/agents/remote/enrollment.js";
import { wireFrames, type Frame } from "../src/agents/remote/protocol.js";
import { RunnerRegistry } from "../src/agents/remote/registry.js";
import {
  RemoteRunnerService,
  RunnerRequestError,
  RunnerUnavailable,
} from "../src/agents/remote/service.js";
import {
  generateRunnerKey,
  issueAuthority,
  issueClient,
  issueServer,
  runnerPublicKey,
} from "../src/agents/remote/x509.js";
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

type FakeRunner = {
  socket: TLSSocket;
  closed: Promise<void>;
  requests: Frame[];
};

/** A minimal runner peer: mTLS, `ready`, and replies naming itself. */
function dialRunner(input: {
  endpoint: string;
  ca: string;
  cert: string;
  key: string;
  label: string;
  workspaces: string[];
  answer?: boolean;
}): Promise<FakeRunner> {
  const url = new URL(input.endpoint);
  return new Promise((resolve, reject) => {
    const requests: Frame[] = [];
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
    const send = wireFrames(socket, (frame) => {
      requests.push(frame);
      if (frame.type === "request" && input.answer !== false)
        send({ type: "result", id: frame.id, value: input.label });
    });
    socket.once("secureConnect", () => {
      send({ type: "ready", version: 1, workspaces: input.workspaces });
      resolve({ socket, closed, requests });
    });
  });
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached");
}

describe("certificate issuance", () => {
  it("issues a CA, a server leaf with SANs and a client leaf", () => {
    const ca = issueAuthority("test CA");
    const caCert = new X509Certificate(ca.cert);
    const server = new X509Certificate(
      issueServer(ca, ["runner.example", "10.1.2.3", "::1"]).cert
    );
    const runner = generateRunnerKey();
    const client = new X509Certificate(
      issueClient(ca, "rnr_1", runnerPublicKey(runner.publicKey))
    );
    expect(caCert.ca).toBe(true);
    expect(server.ca).toBe(false);
    expect(server.verify(caCert.publicKey)).toBe(true);
    expect(server.checkHost("runner.example")).toBe("runner.example");
    expect(server.checkIP("10.1.2.3")).toBe("10.1.2.3");
    expect(server.checkIP("::1")).toBe("::1");
    expect(client.verify(caCert.publicKey)).toBe(true);
    expect(client.subject).toBe("CN=rnr_1");
    expect(client.keyUsage).toEqual(["1.3.6.1.5.5.7.3.2"]);
  });

  it("rejects weak runner keys", () => {
    expect(() =>
      runnerPublicKey(
        "-----BEGIN PUBLIC KEY-----\nMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAL\n-----END PUBLIC KEY-----"
      )
    ).toThrow();
  });
});

describe("runner enrollment service", () => {
  let pool: Pool;
  let api: http.Server;
  let apiRequests: http.IncomingMessage[];
  const services: RemoteRunnerService[] = [];
  const runners: FakeRunner[] = [];

  const makeService = (port?: number) => {
    const service = new RemoteRunnerService(
      undefined,
      {
        registry: new RunnerRegistry(pool),
        host: HOST,
        port,
        endpointHost: HOST,
      },
      { host: HOST, port: (api.address() as AddressInfo).port, tls: false }
    );
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
    return { created, endpoint, pin, code, key: runnerKey.key, ...enrolled };
  }

  beforeAll(async () => {
    pool = await setupTestDb();
    await runTestMigrations();
    apiRequests = [];
    api = http.createServer((request, response) => {
      apiRequests.push(request);
      response.end(`api:${request.url}`);
    });
    await new Promise<void>((resolve) => api.listen(0, HOST, resolve));
  }, 60_000);

  afterEach(async () => {
    for (const runner of runners.splice(0)) runner.socket.destroy();
    for (const service of services.splice(0)) service.close();
    await pool.query("DELETE FROM runner_registrations");
    await pool.query("DELETE FROM runner_authority");
  });

  afterAll(async () => {
    api?.close();
    await teardownTestDb();
  });

  it("pairs with a one-time code over a pinned CA and lists the runner", async () => {
    const service = makeService();
    const created = await service.createRegistration("alpha");
    expect(created.id).toMatch(/^rnr_[a-f0-9]+$/);
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(created.command).toMatch(
      /^dispatch-runner remote-runner-pair --endpoint https:\/\/127\.0\.0\.1:\d+ --ca-sha256 [a-f0-9]{64} --code \S+$/
    );
    expect(await service.list()).toEqual([
      { id: created.id, name: "alpha", status: "pending", workspaces: [] },
    ]);

    const { endpoint, pin, code } = parseCommand(created.command);
    const wrongPin = "0".repeat(64);
    const runnerKey = generateRunnerKey();
    await expect(
      exchangeCode({
        endpoint,
        pin: wrongPin,
        code,
        publicKey: runnerKey.publicKey,
      })
    ).rejects.toThrow(/pinned/);
    // The wrong pin aborted before the code was sent, so it still works.
    const enrolled = await exchangeCode({
      endpoint,
      pin,
      code,
      publicKey: runnerKey.publicKey,
    });
    expect(enrolled).toMatchObject({ id: created.id, name: "alpha" });
    await expect(
      exchangeCode({
        endpoint,
        pin,
        code,
        publicKey: generateRunnerKey().publicKey,
      })
    ).rejects.toThrow(/invalid, expired or already used/);

    expect((await service.list())[0]?.status).toBe("offline");
    runners.push(
      await dialRunner({
        endpoint,
        ca: enrolled.ca,
        cert: enrolled.cert,
        key: runnerKey.key,
        label: "alpha",
        workspaces: ["proof"],
      })
    );
    await waitFor(() =>
      service.available({ runner: "alpha", workspace: "proof" })
    );
    expect(await service.list()).toEqual([
      {
        id: created.id,
        name: "alpha",
        status: "online",
        workspaces: ["proof"],
      },
    ]);
  });

  it("validates names and rejects duplicates", async () => {
    const service = makeService();
    await expect(service.createRegistration("Bad Name")).rejects.toMatchObject({
      status: 400,
    });
    await service.createRegistration("dup");
    await expect(service.createRegistration("dup")).rejects.toBeInstanceOf(
      RunnerRequestError
    );
  });

  it("routes identically named workspaces to independent peers and revokes one", async () => {
    const service = makeService();
    const a = await enroll(service, "alpha");
    const b = await enroll(service, "beta");
    const alpha = await dialRunner({
      endpoint: a.endpoint,
      ca: a.ca,
      cert: a.cert,
      key: a.key,
      label: "alpha",
      workspaces: ["proof"],
      answer: false,
    });
    const beta = await dialRunner({
      endpoint: b.endpoint,
      ca: b.ca,
      cert: b.cert,
      key: b.key,
      label: "beta",
      workspaces: ["proof"],
    });
    runners.push(alpha, beta);
    const alphaPlace = { runner: "alpha", workspace: "proof" };
    const betaPlace = { runner: "beta", workspace: "proof" };
    await waitFor(
      () => service.available(alphaPlace) && service.available(betaPlace)
    );
    const command = {
      kind: "alive",
      agentId: "agt_x",
      workspace: "proof",
    } as const;
    expect((await service.request(betaPlace, command)).value).toBe("beta");
    expect(alpha.requests.filter((f) => f.type === "request")).toHaveLength(0);

    // Alpha holds a request open; revoking it fails only alpha's request.
    const inFlight = service.request(alphaPlace, command);
    await waitFor(() => alpha.requests.some((f) => f.type === "request"));
    await service.revoke(a.id);
    await expect(inFlight).rejects.toBeInstanceOf(RunnerUnavailable);
    await alpha.closed;
    expect(service.available(alphaPlace)).toBe(false);
    expect((await service.request(betaPlace, command)).value).toBe("beta");

    // The revoked certificate cannot attach again.
    const again = await dialRunner({
      endpoint: a.endpoint,
      ca: a.ca,
      cert: a.cert,
      key: a.key,
      label: "alpha",
      workspaces: ["proof"],
    }).catch(() => undefined);
    if (again) {
      runners.push(again);
      await again.closed;
    }
    expect(service.available(alphaPlace)).toBe(false);
    const listed = await service.list();
    expect(listed.find((r) => r.id === a.id)?.status).toBe("revoked");
    expect(listed.find((r) => r.id === b.id)?.status).toBe("online");
    await expect(service.revoke("rnr_missing")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rejects a client certificate from another CA", async () => {
    const service = makeService();
    const a = await enroll(service, "alpha");
    const rogueCa = issueAuthority("rogue");
    const key = generateRunnerKey();
    const cert = issueClient(rogueCa, a.id, runnerPublicKey(key.publicKey));
    const rogue = await dialRunner({
      endpoint: a.endpoint,
      ca: a.ca,
      cert,
      key: key.key,
      label: "rogue",
      workspaces: ["proof"],
    });
    runners.push(rogue);
    await rogue.closed;
    expect(service.available({ runner: "alpha", workspace: "proof" })).toBe(
      false
    );
  });

  it("persists the CA, port and registrations across a service restart", async () => {
    const first = makeService();
    const a = await enroll(first, "alpha");
    const port = Number(new URL(a.endpoint).port);
    first.close();
    services.splice(services.indexOf(first), 1);

    const second = makeService();
    await second.startEnrolled();
    expect(second.originFor({ runner: "alpha", workspace: "proof" })).toBe(
      `https://127.0.0.1:${port}`
    );
    runners.push(
      await dialRunner({
        endpoint: a.endpoint,
        ca: a.ca,
        cert: a.cert,
        key: a.key,
        label: "alpha",
        workspaces: ["proof", "other"],
      })
    );
    await waitFor(() =>
      second.available({ runner: "alpha", workspace: "other" })
    );
    second.close();
    services.splice(services.indexOf(second), 1);
    // Last reported workspaces survive while offline.
    const third = makeService();
    await third.startEnrolled();
    await waitFor(
      async () => (await third.list())[0]?.workspaces.includes("other") ?? false
    );
    expect((await third.list())[0]).toMatchObject({
      status: "offline",
      workspaces: ["proof", "other"],
    });
  });

  it("proxies only bearer-authenticated agent MCP routes to the API", async () => {
    const service = makeService();
    const a = await enroll(service, "alpha");
    const origin = new URL(a.endpoint);
    const get = (
      path: string,
      headers: Record<string, string> = {},
      method = "GET"
    ) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = https.request(
          {
            host: origin.hostname,
            port: origin.port,
            path,
            method,
            headers,
            ca: a.ca,
          },
          (response) => {
            let body = "";
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, body })
            );
          }
        );
        request.on("error", reject);
        request.end();
      });
    expect(await get("/ping")).toEqual({ status: 200, body: "api:/ping" });
    expect(
      (await get("/api/v1/agents", { authorization: "Bearer x" })).status
    ).toBe(404);
    expect((await get("/api/mcp/agt_abc")).status).toBe(404);
    apiRequests.length = 0;
    expect(
      await get(
        "/api/mcp/agt_abc",
        { authorization: "Bearer token", cookie: "dispatch_session=secret" },
        "POST"
      )
    ).toEqual({ status: 200, body: "api:/api/mcp/agt_abc" });
    expect(apiRequests[0]?.headers.authorization).toBe("Bearer token");
    expect(apiRequests[0]?.headers.cookie).toBeUndefined();
  });
});
