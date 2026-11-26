import type { AddressInfo } from "node:net";
import { connect, type TLSSocket } from "node:tls";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { exchangeCode } from "../../../packages/runner/src/workload/agents/remote/enrollment.js";
import type { SocketRequest } from "@dispatch/runner-client/transport/local-socket";
import { wireFrames } from "@dispatch/runner-client/v1/node";
import { RunnerRegistry } from "../src/agents/remote/registry.js";
import { RemoteRunnerService } from "../src/agents/remote/service.js";
import { generateRunnerKey } from "../../../packages/runner/src/workload/agents/remote/x509.js";
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

function dialEngineRunner(input: {
  endpoint: string;
  ca: string;
  cert: string;
  key: string;
  onGitHub?: (op: string, input: unknown) => unknown;
  inventoryEntries?: unknown[];
}) {
  const endpoint = new URL(input.endpoint);
  return new Promise<TLSSocket>((resolve, reject) => {
    const socket = connect({
      host: endpoint.hostname,
      port: Number(endpoint.port),
      ca: input.ca,
      cert: input.cert,
      key: input.key,
      rejectUnauthorized: true,
    });
    socket.on("error", reject);
    const send = wireFrames<SocketRequest, unknown>(
      socket,
      ({ id, op, input: request }) => {
        let value: unknown;
        if (op === "runner.describe")
          value = {
            runnerId: "fixture",
            displayName: "fixture",
            build: { version: "1" },
            protocol: 1,
            engines: [],
            capabilities: {},
          };
        else if (op === "engine.list")
          value = { entries: input.inventoryEntries ?? [] };
        else if (op.startsWith("github."))
          value = input.onGitHub?.(op, request);
        if (value === undefined)
          send({
            id,
            ok: false,
            error: { code: "unavailable", message: "fixture unavailable" },
          });
        else send({ id, ok: true, value });
      }
    );
    socket.once("secureConnect", () => resolve(socket));
  });
}

describe("engine wire integration", () => {
  let pool: Pool;
  const services: RemoteRunnerService[] = [];
  const sockets: TLSSocket[] = [];

  const makeService = () => {
    const service = new RemoteRunnerService({
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

  it("routes GitHub operations to the chosen capable runner and drops access on revoke", async () => {
    const service = makeService();
    const alpha = await enroll(service, "alpha");
    const beta = await enroll(service, "beta");
    const operations: string[] = [];
    const other: string[] = [];
    sockets.push(
      await dialEngineRunner({
        ...alpha,
        onGitHub(op) {
          operations.push(op);
          if (op === "github.repositories")
            return {
              repositories: [
                { name: "org/project", url: "https://github.com/org/project" },
                {
                  name: "org/reject",
                  url: "https://secret@github.com/org/reject",
                },
              ],
            };
          return {
            status: "pending",
            code: "ABCD-1234",
            verificationUrl: "https://github.com/login/device",
            token: "synthetic-token",
          };
        },
      })
    );
    sockets.push(
      await dialEngineRunner({
        ...beta,
        onGitHub(op) {
          other.push(op);
          return { status: "signed-out" };
        },
      })
    );
    await waitFor(() =>
      [alpha, beta].every((peer) => service.available(peer.created.id))
    );
    const list = await service.list();
    expect(JSON.stringify(list)).not.toContain("ABCD-1234");
    expect(await service.githubAccount(alpha.created.id, "login")).toEqual({
      status: "pending",
      code: "ABCD-1234",
      verificationUrl: "https://github.com/login/device",
    });
    expect(
      await service.searchGitHubRepositories(alpha.created.id, "org/project")
    ).toEqual({
      repositories: [
        { name: "org/project", url: "https://github.com/org/project" },
      ],
    });
    expect(await service.githubAccount(beta.created.id, "status")).toEqual({
      status: "signed-out",
    });
    expect(other).toEqual(["github.account"]);
    await service.revoke(alpha.created.id);
    expect(
      await service.githubAccount(alpha.created.id, "status")
    ).toMatchObject({ status: "unavailable" });
    expect(operations).toEqual(["github.login.start", "github.repositories"]);
  });

  it("stores the authenticated runner's engine.list sample and exposes it via list()", async () => {
    const service = makeService();
    const alpha = await enroll(service, "alpha");
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
    sockets.push(
      await dialEngineRunner({ ...alpha, inventoryEntries: entries })
    );
    await waitFor(
      () => service.engineInventorySnapshot(alpha.created.id) !== undefined
    );
    expect(service.engineInventorySnapshot(alpha.created.id)).toEqual(entries);
    const summary = (await service.list())[0];
    expect(summary?.engines).toEqual(entries);
    expect(summary?.engineManagement).toBe(true);
  });

  it("drops a runner that answers engine.list with a malformed inventory", async () => {
    const service = makeService();
    const alpha = await enroll(service, "alpha");
    const socket = await dialEngineRunner({
      ...alpha,
      inventoryEntries: [
        {
          id: "not-a-real-engine",
          label: "x",
          installed: true,
          signedIn: null,
          version: null,
          actions: [],
        },
      ],
    });
    sockets.push(socket);
    await waitFor(() => socket.destroyed);
    expect(service.engineInventorySnapshot(alpha.created.id)).toBeUndefined();
  });
});
