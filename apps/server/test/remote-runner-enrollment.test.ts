import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
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
import { exchangeCode } from "../src/agents/remote/enrollment.js";
import {
  wireFrames,
  type Frame,
  type EnrollmentRequest,
  type EnrollmentReply,
} from "../src/agents/remote/protocol.js";
import { remoteEngineTransport } from "../src/agents/remote/engine-transport.js";
import { RunnerRegistry } from "../src/agents/remote/registry.js";
import {
  advertisedHost,
  RemoteRunnerService,
  RunnerRequestError,
  RunnerUnavailable,
  RunnerRevoked,
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
  health?: Extract<Frame, { type: "health" }>["sample"];
  managedWorkspace?: true;
  sharedWorktree?: true;
  checkoutInspection?: true;
  defaultBranchFiles?: true;
  githubManagement?: true;
  engineManagement?: true;
  engineCapabilities?: true;
  pullRequestStatus?: true;
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
      if (frame.type === "accept_health" && input.health)
        send({ type: "health", sample: input.health });
      if (frame.type === "request" && input.answer !== false)
        send({ type: "result", id: frame.id, value: input.label });
    });
    socket.once("secureConnect", () => {
      send({
        type: "ready",
        version: 1,
        workspaces: input.workspaces,
        ...(input.health ? { health: true as const } : {}),
        managedWorkspace: input.managedWorkspace,
        sharedWorktree: input.sharedWorktree,
        checkoutInspection: input.checkoutInspection,
        defaultBranchFiles: input.defaultBranchFiles,
        githubManagement: input.githubManagement,
        engineManagement: input.engineManagement,
        engineCapabilities: input.engineCapabilities,
        pullRequestStatus: input.pullRequestStatus,
      });
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

  const makeService = (repoTool?: boolean | string[]) => {
    const service = new RemoteRunnerService(
      undefined,
      {
        registry: new RunnerRegistry(pool),
        host: HOST,
        endpointHost: HOST,
        repoTool,
      },
      {
        host: HOST,
        port: (api.address() as AddressInfo).port,
        tls: false,
        validAgentToken: (token, agentId) => token === `agent-token:${agentId}`,
        validJobToken: (token, runId, agentId) =>
          token === `job-token:${runId}:${agentId}`,
      }
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

  it("keeps PR status enabled on a peer without the evidence capability", async () => {
    const service = makeService();
    const enrolled = await enroll(service, "legacy-github");
    const peer = await dialRunner({
      ...enrolled,
      workspaces: ["work"],
      githubManagement: true,
      pullRequestStatus: true,
      label: JSON.stringify({
        state: "OPEN",
        draft: false,
        title: "PR",
        head: null,
        rollup: null,
      }),
    });
    runners.push(peer);
    const runnerId = enrolled.created.id;
    await waitFor(() =>
      service.available({ runner: runnerId, workspace: "work" })
    );
    const url = "https://github.com/example/repo/pull/1";
    expect(
      await service.readPullRequest(runnerId, url, "fallback")
    ).toMatchObject({ status: "Open" });
    await expect(service.readPullRequestDetails(runnerId, url)).rejects.toThrow(
      /update.*evidence/i
    );
    await expect(
      service.readPullRequestDiff(
        runnerId,
        url,
        "a".repeat(40),
        "b".repeat(40),
        "a".repeat(64)
      )
    ).rejects.toThrow(/update.*evidence/i);
    expect(
      peer.requests.filter((frame) => frame.type === "request")
    ).toHaveLength(1);
  });

  it("negotiates workload capabilities per enrolled peer and fails closed offline", async () => {
    const service = makeService();
    const current = await enroll(service, "current-engine");
    const older = await enroll(service, "older-engine");
    const currentPeer = await dialRunner({
      ...current,
      workspaces: ["work"],
      engineManagement: true,
      engineCapabilities: true,
      label: JSON.stringify({
        ok: true,
        capability: {
          type: "model_catalog",
          catalog: {
            defaultModel: "runner/model",
            models: [
              {
                id: "runner/model",
                label: "Runner model",
                hostPath: "/private/home",
              },
            ],
          },
        },
      }),
    });
    const olderPeer = await dialRunner({
      ...older,
      workspaces: ["work"],
      engineManagement: true,
      label: JSON.stringify({ ok: true }),
    });
    runners.push(currentPeer, olderPeer);
    const currentId = current.created.id;
    const olderId = older.created.id;
    await waitFor(() =>
      [currentId, olderId].every((runner) =>
        service.available({ runner, workspace: "work" })
      )
    );
    const transport = remoteEngineTransport(service);
    const operation = { type: "model_catalog", engine: "codex" } as const;
    await expect(transport.send(currentId, operation)).resolves.toEqual({
      ok: true,
      capability: {
        type: "model_catalog",
        catalog: {
          defaultModel: "runner/model",
          models: [{ id: "runner/model", label: "Runner model" }],
        },
      },
    });
    await expect(transport.send(olderId, operation)).resolves.toMatchObject({
      ok: false,
      unsupported: true,
    });
    expect(
      olderPeer.requests.filter((frame) => frame.type === "request")
    ).toHaveLength(0);
    await expect(transport.send(olderId, { type: "status" })).resolves.toEqual({
      ok: true,
    });

    currentPeer.socket.destroy();
    await waitFor(
      () => !service.available({ runner: currentId, workspace: "work" })
    );
    await expect(transport.send(currentId, operation)).resolves.toMatchObject({
      ok: false,
    });
  });

  it("rejects checkout commands on an older peer while preserving the workspace operation", async () => {
    const service = makeService(true);
    const enrolled = await enroll(service, "legacy-checkout");
    const placement = { runner: enrolled.created.id, workspace: "work" };
    const peer = await dialRunner({
      ...enrolled,
      workspaces: ["work"],
      label: "approved",
    });
    runners.push(peer);
    await waitFor(() => service.available(placement));

    await expect(
      service.requestSession(placement, {
        kind: "checkoutCommand",
        agentId: "session",
        operation: { kind: "read", checkout: "effective", path: "tools.json" },
      })
    ).rejects.toThrow(/update.*checkout commands/i);
    expect(service.repoToolFor(placement)).toBe(true);
    await expect(
      service.requestSession(placement, {
        kind: "repo",
        agentId: "session",
      })
    ).resolves.toMatchObject({ value: "approved" });
    expect(
      peer.requests.filter((frame) => frame.type === "request")
    ).toHaveLength(1);
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
      {
        id: created.id,
        name: "alpha",
        status: "pending",
        engineManagement: false,
        githubManagement: false,
        workspaces: [],
      },
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
      service.available({ runner: created.id, workspace: "proof" })
    );
    // Placements address the opaque registration id, never the name.
    expect(service.available({ runner: "alpha", workspace: "proof" })).toBe(
      false
    );
    expect(await service.list()).toEqual([
      {
        id: created.id,
        name: "alpha",
        status: "online",
        engineManagement: false,
        githubManagement: false,
        workspaces: ["proof"],
      },
    ]);
  });

  it("stores a negotiated runner-pushed sample under the peer identity and retains it offline", async () => {
    const service = makeService();
    const alpha = await enroll(service, "alpha");
    const beta = await enroll(service, "beta");
    const health = {
      version: "1.2.3",
      sessions: 3,
      working: 1,
      cpuPercent: 12,
      memoryUsed: 64,
      memoryTotal: 512,
    };
    const runner = await dialRunner({
      ...alpha,
      label: "alpha",
      workspaces: ["proof"],
      health,
    });
    runners.push(runner);
    await waitFor(
      async () =>
        (await service.list()).find((r) => r.id === alpha.id)?.health
          ?.sessions === 3
    );
    runner.socket.destroy();
    await waitFor(
      async () =>
        (await service.list()).find((r) => r.id === alpha.id)?.status ===
        "offline"
    );
    await waitFor(async () =>
      Boolean((await service.list()).find((r) => r.id === alpha.id)?.health)
    );
    const rows = await service.list();
    expect(rows.find((r) => r.id === alpha.id)).toMatchObject({
      health,
      healthReceivedAt: expect.any(String),
    });
    expect(rows.find((r) => r.id === beta.id)?.health).toBeUndefined();
  });

  it("validates names and rejects duplicates", async () => {
    const service = makeService();
    for (const bad of [" padded", "", "x".repeat(65), "tab\tname", 7])
      await expect(service.createRegistration(bad)).rejects.toMatchObject({
        status: 400,
      });
    // Display names are free-form; only the id addresses placements.
    await service.createRegistration("Lima VM (arm64)");
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
    const alphaPlace = { runner: a.id, workspace: "proof" };
    const betaPlace = { runner: b.id, workspace: "proof" };
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
    expect(service.available({ runner: a.id, workspace: "proof" })).toBe(false);
  });

  it("never routes an old placement to a re-paired runner with the same name", async () => {
    const service = makeService(true);
    const old = await enroll(service, "lima");
    const oldPlace = { runner: old.id, workspace: "proof" };
    expect(service.permitsAgentMcp(oldPlace)).toBe(true);
    await service.revoke(old.id);
    expect(service.permitsAgentMcp(oldPlace)).toBe(false);
    expect(service.repoToolFor(oldPlace)).toBe(false);

    const fresh = await enroll(service, "lima");
    expect(fresh.id).not.toBe(old.id);
    const freshPlace = { runner: fresh.id, workspace: "proof" };
    // Offline but active: the agent's MCP credential stays valid.
    expect(service.permitsAgentMcp(freshPlace)).toBe(true);
    const runner = await dialRunner({
      endpoint: fresh.endpoint,
      ca: fresh.ca,
      cert: fresh.cert,
      key: fresh.key,
      label: "fresh",
      workspaces: ["proof"],
    });
    runners.push(runner);
    await waitFor(() => service.available(freshPlace));
    expect(service.available(oldPlace)).toBe(false);
    await expect(
      service.request(oldPlace, {
        kind: "alive",
        agentId: "agt_old",
        workspace: "proof",
      })
    ).rejects.toBeInstanceOf(RunnerRevoked);
    expect(runner.requests.some((f) => f.type === "request")).toBe(false);
    expect(
      service.permitsAgentMcp({ runner: "rnr_unknown", workspace: "proof" })
    ).toBe(false);
    const listed = await service.list();
    expect(listed.map((r) => [r.name, r.status])).toEqual([
      ["lima", "revoked"],
      ["lima", "online"],
    ]);
  });

  it("renews a certificate under the same id and retires the old one", async () => {
    const service = makeService();
    const a = await enroll(service, "alpha");
    const place = { runner: a.id, workspace: "proof" };
    const before = await dialRunner({
      endpoint: a.endpoint,
      ca: a.ca,
      cert: a.cert,
      key: a.key,
      label: "old",
      workspaces: ["proof"],
    });
    runners.push(before);
    await waitFor(() => service.available(place));

    const renewal = await service.reissueRegistration(a.id);
    expect(renewal.id).toBe(a.id);
    const { endpoint, pin, code } = parseCommand(renewal.command);
    const key = generateRunnerKey();
    const renewed = await exchangeCode({
      endpoint,
      pin,
      code,
      publicKey: key.publicKey,
    });
    expect(renewed.id).toBe(a.id);
    await before.closed;

    const stale = await dialRunner({
      endpoint: a.endpoint,
      ca: a.ca,
      cert: a.cert,
      key: a.key,
      label: "old",
      workspaces: ["proof"],
    });
    runners.push(stale);
    await stale.closed;
    const after = await dialRunner({
      endpoint,
      ca: renewed.ca,
      cert: renewed.cert,
      key: key.key,
      label: "new",
      workspaces: ["proof"],
    });
    runners.push(after);
    await waitFor(() => service.available(place));
    expect(
      (
        await service.request(place, {
          kind: "alive",
          agentId: "agt_x",
          workspace: "proof",
        })
      ).value
    ).toBe("new");
    await service.revoke(a.id);
    await expect(service.reissueRegistration(a.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("scopes the repo operation to approved placements", async () => {
    const service = makeService();
    const a = await enroll(service, "alpha");
    const b = await enroll(service, "beta");
    const scoped = makeService([`${a.id}/proof`, b.id]);
    await scoped.startEnrolled();
    expect(service.repoToolFor({ runner: a.id, workspace: "proof" })).toBe(
      false
    );
    expect(scoped.repoToolFor({ runner: a.id, workspace: "proof" })).toBe(true);
    expect(scoped.repoToolFor({ runner: a.id, workspace: "other" })).toBe(
      false
    );
    expect(scoped.repoToolFor({ runner: b.id, workspace: "anything" })).toBe(
      true
    );
    await scoped.revoke(b.id);
    expect(scoped.repoToolFor({ runner: b.id, workspace: "anything" })).toBe(
      false
    );
  });

  it("gates worktree reuse, inspection and terminals before sending requests to older peers", async () => {
    const service = makeService();
    const a = await enroll(service, "alpha");
    const placement = { runner: a.id, workspace: "@session" };
    const legacy = await dialRunner({
      ...a,
      label: "old",
      workspaces: ["@session"],
    });
    await waitFor(() => service.available(placement));
    const query = {
      kind: "inspectCheckout",
      agentId: "author",
      query: { kind: "changes", baseBranch: null },
    } as const;
    const defaultFiles = {
      ...query,
      query: {
        kind: "defaultBranchFiles" as const,
        directories: [".config"],
        waitForRefresh: false,
      },
    };
    const launch = {
      kind: "launch",
      agentId: "reviewer",
      launch: {
        agentId: "reviewer",
        engine: "codex",
        model: null,
        systemPrompt: null,
        resumeSessionId: null,
        useWorktreeOf: "author",
      },
    } as const;
    try {
      await expect(service.requestSession(placement, query)).rejects.toThrow(
        "Update the runner"
      );
      await expect(service.requestSession(placement, launch)).rejects.toThrow(
        "Update the runner"
      );
      await expect(
        service.requestSession(placement, {
          kind: "openTerminal",
          agentId: "author",
        })
      ).rejects.toThrow("Update this runner to open a terminal.");
      expect(legacy.requests.filter((f) => f.type === "request")).toEqual([]);
    } finally {
      legacy.socket.destroy();
    }
    await waitFor(() => !service.available(placement));
    const current = await dialRunner({
      ...a,
      label: "current",
      workspaces: ["@session"],
      checkoutInspection: true,
      sharedWorktree: true,
    });
    try {
      await waitFor(() => service.supportsSharedWorktree(placement));
      await expect(
        service.requestSession(placement, defaultFiles)
      ).rejects.toThrow("Update the runner to read default-branch files");
      expect(
        current.requests.filter((frame) => frame.type === "request")
      ).toEqual([]);
      expect((await service.requestSession(placement, query)).value).toBe(
        "current"
      );
      expect((await service.requestSession(placement, launch)).value).toBe(
        "current"
      );
    } finally {
      current.socket.destroy();
    }
    await waitFor(() => !service.available(placement));
    const extended = await dialRunner({
      ...a,
      label: "with default files",
      workspaces: ["@session"],
      checkoutInspection: true,
      defaultBranchFiles: true,
    });
    try {
      await waitFor(() => service.available(placement));
      expect(
        (await service.requestSession(placement, defaultFiles)).value
      ).toBe("with default files");
      expect(extended.requests).toContainEqual(
        expect.objectContaining({
          type: "request",
          command: { ...defaultFiles, workspace: "@session" },
        })
      );
    } finally {
      extended.socket.destroy();
    }
  });

  it("distinguishes a configured @session handle from managed mode and retains the mode offline", async () => {
    const service = makeService();
    const a = await enroll(service, "alpha");
    const placement = { runner: a.id, workspace: "@session" };
    const connectSession = async (managedWorkspace?: true) => {
      const session = await dialRunner({
        endpoint: a.endpoint,
        ca: a.ca,
        cert: a.cert,
        key: a.key,
        label: "alpha",
        workspaces: ["@session"],
        managedWorkspace,
      });
      runners.push(session);
      return session;
    };
    await connectSession();
    await waitFor(() => service.available(placement));
    expect(service.isManagedWorkspace(placement)).toBe(false);
    expect((await service.list())[0]).not.toHaveProperty("managedWorkspace");

    const managed = await connectSession(true);
    await waitFor(() => service.isManagedWorkspace(placement));
    expect((await service.list())[0]).toMatchObject({
      workspaces: ["@session"],
      managedWorkspace: true,
    });
    await waitFor(
      async () =>
        (
          await pool.query(
            "SELECT managed_workspace FROM runner_registrations WHERE id = $1",
            [a.id]
          )
        ).rows[0]?.managed_workspace === true
    );
    managed.socket.destroy();
    await waitFor(() => !service.available(placement));
    expect((await service.list())[0]).toMatchObject({
      status: "offline",
      workspaces: ["@session"],
      managedWorkspace: true,
    });
  });

  it("persists the CA, port and registrations across a service restart", async () => {
    const first = makeService();
    const a = await enroll(first, "alpha");
    const place = (workspace: string) => ({ runner: a.id, workspace });
    const port = Number(new URL(a.endpoint).port);
    first.close();
    services.splice(services.indexOf(first), 1);

    const second = makeService();
    await second.startEnrolled();
    expect(second.originFor(place("proof"))).toBe(`https://127.0.0.1:${port}`);
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
    await waitFor(() => second.available(place("other")));
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

  it("proxies only session-scoped MCP routes with allow-listed headers", async () => {
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
    // Non-agent credentials (e.g. the admin API token) never pass.
    expect(
      (await get("/api/mcp/agt_abc", { authorization: "Bearer admin" }, "POST"))
        .status
    ).toBe(404);
    expect(
      (
        await get(
          "/api/mcp/agt_abc",
          { authorization: "Bearer agent-token:agt_other" },
          "POST"
        )
      ).status
    ).toBe(404);
    apiRequests.length = 0;
    expect(
      await get(
        "/api/mcp/agt_abc",
        {
          authorization: "Bearer agent-token:agt_abc",
          cookie: "dispatch_session=secret",
          "x-forwarded-for": "10.0.0.1",
          "x-dispatch-admin": "1",
          origin: "https://evil.example",
          "mcp-session-id": "s1",
        },
        "POST"
      )
    ).toEqual({ status: 200, body: "api:/api/mcp/agt_abc" });
    const forwarded = apiRequests[0]!.headers;
    expect(forwarded.authorization).toBe("Bearer agent-token:agt_abc");
    expect(forwarded["mcp-session-id"]).toBe("s1");
    for (const name of [
      "cookie",
      "x-forwarded-for",
      "x-dispatch-admin",
      "origin",
    ])
      expect(forwarded[name], name).toBeUndefined();
    apiRequests.length = 0;
    for (const [method, path] of [
      ["GET", `/api/v1/runners/${a.created.id}/github`],
      ["POST", `/api/v1/runners/${a.created.id}/github/login`],
      ["GET", `/api/v1/runners/${a.created.id}/repository-search?q=org/repo`],
      ["GET", `/api/v1/runners/${a.created.id}/pull-request-head`],
    ]) {
      expect(
        (
          await get(
            path,
            { authorization: "Bearer agent-token:agt_abc" },
            method
          )
        ).status
      ).toBe(404);
    }
    expect(apiRequests).toHaveLength(0);
    const runId = "50a552a3-9629-4bc5-8b16-d52351d6c9ab";
    const jobRoute = `/api/mcp/jobs/${runId}/agt_abc`;
    for (const token of ["agent-token:agt_abc", `job-token:${runId}:agt_other`])
      expect(
        (await get(jobRoute, { authorization: `Bearer ${token}` }, "POST"))
          .status
      ).toBe(404);
    expect(
      await get(
        jobRoute,
        { authorization: `Bearer job-token:${runId}:agt_abc` },
        "POST"
      )
    ).toEqual({ status: 200, body: `api:${jobRoute}` });
    // /ping carries no credentials upstream.
    apiRequests.length = 0;
    await get("/ping", { authorization: "Bearer agent-token:agt_abc" });
    expect(apiRequests[0]?.headers.authorization).toBeUndefined();
  });
});

it("closes each relayed HTTP connection after its entire response", async () => {
  const authority = issueAuthority("relay-test");
  const leaf = issueServer(authority, [HOST]);
  let requests = 0;
  const api = http.createServer((_request, response) => {
    if (requests++ === 0) {
      response.setHeader("Connection", "keep-alive");
      response.end("ok");
      return;
    }
    // Simulate both a silent tool call and a streamed response that stays open.
    setTimeout(() => {
      response.write("first ");
      setTimeout(() => response.end("last"), 100);
    }, 2_500);
  });
  api.listen(0, HOST);
  await once(api, "listening");
  const debug = vi.fn();
  const service = new RemoteRunnerService(
    undefined,
    undefined,
    { host: HOST, port: (api.address() as AddressInfo).port, tls: false },
    { debug }
  );
  const listener = createServer(
    {
      cert: leaf.cert,
      key: leaf.key,
      requestCert: true,
      rejectUnauthorized: false,
    },
    (socket) => service["accept"](socket, "legacy")
  );
  listener.listen(0, HOST);
  await once(listener, "listening");
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 1,
    ca: authority.cert,
  });
  try {
    function ping() {
      return new Promise<{
        socket: TLSSocket;
        closed: Promise<boolean>;
        status?: number;
        connection?: string;
        body: string;
      }>((resolve, reject) => {
        const request = https.get(
          {
            host: HOST,
            port: (listener.address() as AddressInfo).port,
            path: "/ping",
            agent,
          },
          (response) => {
            const socket = response.socket as TLSSocket;
            const closed = new Promise<boolean>((done) =>
              socket.once("close", done)
            );
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => (body += chunk));
            response.once("end", () =>
              resolve({
                socket,
                closed,
                status: response.statusCode,
                connection: response.headers.connection,
                body,
              })
            );
            response.once("error", reject);
          }
        );
        request.on("error", reject);
      });
    }
    const first = await ping();
    expect(first).toMatchObject({
      status: 200,
      connection: "close",
      body: "ok",
    });
    expect(service["unauthenticated"]).toBe(0);
    const second = await ping();
    expect(second.socket).not.toBe(first.socket);
    expect(second).toMatchObject({
      status: 200,
      connection: "close",
      body: "first last",
    });
    expect(await first.closed).toBe(false);
    expect(await second.closed).toBe(false);
    expect(requests).toBe(2);
    await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(2));
    for (const call of debug.mock.calls) {
      expect(call).toEqual([
        expect.objectContaining({
          ageMs: expect.any(Number),
          requestsServed: 1,
          closedBy: "proxy",
        }),
        "Runner HTTP relay closed",
      ]);
    }
  } finally {
    agent.destroy();
    service.close();
    listener.close();
    api.close();
  }
}, 10_000);

describe("legacy runner config", () => {
  it("keeps its locator and gates MCP on the live approval file", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "legacy-runner-"));
    const approval = path.join(dir, "approval");
    await writeFile(approval, "AA:BB\n");
    const service = new RemoteRunnerService({
      id: "lima",
      host: HOST,
      port: 0,
      cert: "",
      key: "",
      ca: "",
      approval,
      workspaces: ["proof"],
      endpointHost: "host.lima.internal",
      repoTool: true,
    });
    const place = { runner: "lima", workspace: "proof" };
    expect(service.permitsAgentMcp(place)).toBe(true);
    expect(service.repoToolFor(place)).toBe(true);
    expect(service.permitsAgentMcp({ runner: "lima", workspace: "x" })).toBe(
      false
    );
    expect(service.originFor(place)).toBe("https://host.lima.internal:0");
    expect((await service.list())[0]).toMatchObject({
      id: "lima",
      name: "lima",
    });
    await expect(service.revoke("lima")).rejects.toMatchObject({ status: 409 });
    await writeFile(approval, "");
    expect(service.permitsAgentMcp(place)).toBe(false);
    expect(service.repoToolFor(place)).toBe(false);
  });
});

describe("advertised pairing host", () => {
  const nic = (address: string, internal = false) => ({
    address,
    internal,
    family: "IPv4" as const,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: null,
  });
  const interfaces = {
    lo0: [nic("127.0.0.1", true)],
    utun0: [nic("100.64.1.2")],
    en0: [nic("192.168.1.246")],
  };

  it("keeps a reachable request host", () => {
    expect(advertisedHost("studio.local", interfaces, "studio")).toBe(
      "studio.local"
    );
    expect(advertisedHost("10.0.0.5", interfaces, "studio")).toBe("10.0.0.5");
  });

  it("replaces loopback with a private LAN address", () => {
    for (const hint of ["localhost", "127.0.0.1", "::1", "[::1]", undefined])
      expect(advertisedHost(hint, interfaces, "studio")).toBe("192.168.1.246");
  });

  it("falls back to the hostname without a LAN address", () => {
    expect(
      advertisedHost("localhost", { lo0: [nic("127.0.0.1", true)] }, "studio")
    ).toBe("studio");
  });
});

describe("pinned pairing bootstrap", () => {
  it("never sends the code to a peer that echoes the pinned CA but serves another chain", async () => {
    const { createServer } = await import("node:tls");
    const real = issueAuthority("real");
    const rogue = issueAuthority("rogue");
    const leaf = issueServer(rogue, [HOST]);
    const received: unknown[] = [];
    const server = createServer(
      { cert: leaf.cert + rogue.cert, key: leaf.key },
      (socket) => {
        socket.on("error", () => {});
        const send = wireFrames<EnrollmentRequest, EnrollmentReply>(
          socket,
          (frame) => {
            received.push(frame);
            send({ type: "ca", ca: real.cert });
            socket.end();
          }
        );
      }
    );
    await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
    const port = (server.address() as AddressInfo).port;
    const pin = new X509Certificate(real.cert).fingerprint256;
    try {
      await expect(
        exchangeCode({
          endpoint: `https://${HOST}:${port}`,
          pin,
          code: "secret-code",
          publicKey: generateRunnerKey().publicKey,
        })
      ).rejects.toThrow();
      expect(received).toEqual([{ type: "ca_request", version: 1 }]);
    } finally {
      server.close();
    }
  });
});
