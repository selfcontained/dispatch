import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadProbationConfig,
  readRecoveryKey,
  resolveStatePaths,
} from "../src/update-recovery/control.js";
import { probeDatabase } from "../src/update-recovery/database-probe.js";
import {
  recoveryProof,
  RECOVERY_EXIT_CODE,
  RECOVERY_ROUTE_PREFIX,
  type ProbationConfig,
} from "../src/update-recovery/protocol.js";
import {
  RecoveryMaintenance,
  type BusyReason,
  type MaintenanceDeps,
} from "../src/update-recovery/maintenance.js";
import {
  takeResumeReceipt,
  writeResumeReceipt,
  type ResumeReceipt,
} from "../src/update-recovery/resume-receipt.js";
import { registerUpdateRecoveryRoutes } from "../src/routes/update-recovery.js";

const KEY = "ab".repeat(32);
const TX = "3f0e1c52-4d4b-4b7e-9b61-5a7f8a2f0c11";
const OTHER_TX = "9b0e1c52-4d4b-4b7e-9b61-5a7f8a2f0c11";
const NONCE = "cd".repeat(20);
const CHALLENGE = "ef".repeat(16);
const VERSION = "2.0.0";
const PROBATION: ProbationConfig = {
  transactionId: TX,
  nonce: NONCE,
  instanceId: "instance-a",
  expectedVersion: VERSION,
};

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-maintenance-"));
  dirs.push(dir);
  return dir;
}

async function privateFile(dir: string, name: string, body: string) {
  const file = path.join(dir, name);
  await writeFile(file, body, { mode: 0o600 });
  return file;
}

function makeDeps(overrides: Partial<MaintenanceDeps> = {}) {
  const busy: BusyReason[][] = [];
  const deps = {
    version: VERSION,
    instance: {
      instanceId: "instance-a",
      stateDir: "/state",
      port: 6767,
      macInstanceId: null,
    },
    busyReasons: vi.fn(async () => busy.shift() ?? []),
    stopWriters: vi.fn(async () => {}),
    quiesceHosts: vi.fn(async (): Promise<BusyReason[]> => []),
    probeDatabase: vi.fn(async () => ({
      name: "dispatch",
      oid: "16384",
      systemIdentifier: "7000",
      migrations: { count: 90, latest: "090_x" },
    })),
    boundary: vi.fn(async () => ({
      hostsStopped: true,
      liveHosts: [] as string[],
      statePaths: ["/state"],
      macBuild: null as string | null,
    })),
    exit: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
    drainTimeoutMs: 500,
    ...overrides,
  } satisfies MaintenanceDeps;
  return { deps, busy };
}

/** Mirrors the server.ts gate and drain hooks around a mutating route. */
async function harness(
  maintenance: RecoveryMaintenance,
  keyFile: string,
  slowRoute?: Promise<void>
) {
  const app = Fastify();
  apps.push(app);
  app.addHook("onRequest", async (request, reply) => {
    const refused = maintenance.admit(request);
    if (refused) return reply.code(refused.status).send({ code: refused.code });
    if (
      request.url.startsWith("/api/") &&
      !request.routeOptions.config.updateRecovery
    )
      maintenance.requestStarted(request, request.method);
  });
  app.addHook("onResponse", async (request) =>
    maintenance.requestFinished(request)
  );
  app.get("/api/v1/health", async () => ({ status: "ok" }));
  app.get("/api/v1/agents", async () => ({ agents: [] }));
  app.post("/api/v1/agents", async () => {
    await slowRoute;
    return { created: true };
  });
  await registerUpdateRecoveryRoutes(app, { maintenance, keyFile });
  await app.ready();
  return app;
}

const auth = { authorization: `Dispatch-Recovery ${KEY}` };
const route = (name: string) => `${RECOVERY_ROUTE_PREFIX}${name}`;

function verify(
  name: string,
  body: Record<string, unknown>,
  secret?: Record<string, string>
): boolean {
  const { proof, ...rest } = body;
  return (
    proof ===
    recoveryProof(Buffer.from(KEY), route(name), CHALLENGE, rest, secret)
  );
}

describe("loadProbationConfig", () => {
  const env = {
    DISPATCH_RECOVERY_PROBATION: "1",
    DISPATCH_RECOVERY_TRANSACTION_ID: TX,
    DISPATCH_RECOVERY_NONCE: NONCE,
    DISPATCH_RECOVERY_INSTANCE_ID: "instance-a",
    DISPATCH_RECOVERY_EXPECTED_VERSION: VERSION,
  };

  it("is null without env or control file", async () => {
    const dir = await tempDir();
    await expect(
      loadProbationConfig({
        env: {},
        controlFile: path.join(dir, "probation.json"),
        version: VERSION,
      })
    ).resolves.toBeNull();
  });

  it("reads complete env", async () => {
    const dir = await tempDir();
    await expect(
      loadProbationConfig({
        env,
        controlFile: path.join(dir, "missing.json"),
        version: VERSION,
      })
    ).resolves.toEqual(PROBATION);
  });

  it("accepts the Linux helper's names, a UUID nonce and no version pin", async () => {
    const dir = await tempDir();
    const nonce = "0d9c2a1e-5b7f-4e3a-9c1d-2f8e7a6b5c4d";
    await expect(
      loadProbationConfig({
        env: {
          DISPATCH_RECOVERY_PROBATION: "1",
          DISPATCH_RECOVERY_TRANSACTION: TX,
          DISPATCH_RECOVERY_NONCE: nonce,
          DISPATCH_INSTANCE_ID: "instance-a",
        },
        controlFile: path.join(dir, "missing.json"),
        version: VERSION,
      })
    ).resolves.toEqual({
      transactionId: TX,
      nonce,
      instanceId: "instance-a",
    });
  });

  it("treats blanked recovery variables as a normal start", async () => {
    const dir = await tempDir();
    await expect(
      loadProbationConfig({
        env: {
          DISPATCH_INSTANCE_ID: "instance-a",
          DISPATCH_RECOVERY_PROBATION: "",
          DISPATCH_RECOVERY_TRANSACTION: "",
          DISPATCH_RECOVERY_NONCE: "",
        },
        controlFile: path.join(dir, "missing.json"),
        version: VERSION,
      })
    ).resolves.toBeNull();
  });

  it("reads a private control file", async () => {
    const dir = await tempDir();
    const controlFile = await privateFile(
      dir,
      "probation.json",
      JSON.stringify({ formatVersion: 1, ...PROBATION })
    );
    await expect(
      loadProbationConfig({ env: {}, controlFile, version: VERSION })
    ).resolves.toEqual(PROBATION);
  });

  it("fails closed on partial env, unsafe file, conflicts and mismatches", async () => {
    const dir = await tempDir();
    const missing = path.join(dir, "missing.json");
    const load = (
      e: NodeJS.ProcessEnv,
      controlFile = missing,
      version = VERSION
    ) => loadProbationConfig({ env: e, controlFile, version });

    await expect(load({ DISPATCH_RECOVERY_NONCE: NONCE })).rejects.toThrow(
      /incomplete/
    );
    await expect(
      load({ ...env, DISPATCH_RECOVERY_NONCE: "short" })
    ).rejects.toThrow(/invalid/);
    await expect(load(env, missing, "1.0.0")).rejects.toThrow(/version/);
    await expect(
      load({ ...env, DISPATCH_MAC_INSTANCE_ID: "other" })
    ).rejects.toThrow(/instance/);

    const shared = await privateFile(
      dir,
      "shared.json",
      JSON.stringify({ formatVersion: 1, ...PROBATION })
    );
    await chmod(shared, 0o644);
    await expect(load({}, shared)).rejects.toThrow(/unsafe/);

    const malformed = await privateFile(dir, "bad.json", "{");
    await expect(load({}, malformed)).rejects.toThrow(/invalid/);

    const differing = await privateFile(
      dir,
      "differ.json",
      JSON.stringify({ formatVersion: 1, ...PROBATION, nonce: "aa".repeat(20) })
    );
    await expect(load(env, differing)).rejects.toThrow(/differ/);
  });
});

describe("readRecoveryKey", () => {
  it("accepts only a private hex key", async () => {
    const dir = await tempDir();
    const file = await privateFile(dir, "control.key", `${KEY}\n`);
    expect((await readRecoveryKey(file))?.toString()).toBe(KEY);
    await chmod(file, 0o640);
    expect(await readRecoveryKey(file)).toBeNull();
    const short = await privateFile(dir, "short.key", "abcd");
    expect(await readRecoveryKey(short)).toBeNull();
    expect(await readRecoveryKey(path.join(dir, "none"))).toBeNull();
  });
});

describe("recovery route auth", () => {
  it("requires enrollment, the key and a loopback socket", async () => {
    const dir = await tempDir();
    const keyFile = path.join(dir, "control.key");
    const app = await harness(
      new RecoveryMaintenance(makeDeps().deps),
      keyFile
    );
    const status = `${route("status")}?challenge=${CHALLENGE}`;

    let res = await app.inject({ url: status, headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("RECOVERY_NOT_ENROLLED");

    await privateFile(dir, "control.key", KEY);
    res = await app.inject({
      url: status,
      headers: { authorization: `Dispatch-Recovery ${"00".repeat(32)}` },
    });
    expect(res.statusCode).toBe(401);
    res = await app.inject({
      url: status,
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(401);

    res = await app.inject({
      url: status,
      headers: auth,
      remoteAddress: "10.0.0.5",
    });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ url: status, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("normal");
    expect(verify("status", res.json())).toBe(true);
  });
});

describe("alternate supervisor credential", () => {
  it("accepts the Mac control token and signs with it", async () => {
    const dir = await tempDir();
    const token = "t".repeat(40);
    const app = Fastify();
    apps.push(app);
    await registerUpdateRecoveryRoutes(app, {
      maintenance: new RecoveryMaintenance(makeDeps().deps),
      keyFile: path.join(dir, "absent.key"),
      alternateKey: () => token,
    });
    const url = `${route("status")}?challenge=${CHALLENGE}`;
    const res = await app.inject({
      url,
      headers: { authorization: `Dispatch-Recovery ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { proof, ...rest } = res.json();
    expect(proof).toBe(
      recoveryProof(Buffer.from(token), route("status"), CHALLENGE, rest)
    );
    const wrong = await app.inject({ url, headers: auth });
    expect(wrong.statusCode).toBe(401);
  });
});

describe("pre-update fence", () => {
  async function setup(overrides: Partial<MaintenanceDeps> = {}) {
    const dir = await tempDir();
    const keyFile = await privateFile(dir, "control.key", KEY);
    const { deps, busy } = makeDeps(overrides);
    const maintenance = new RecoveryMaintenance(deps);
    return { deps, busy, maintenance, keyFile };
  }
  const fence = (app: FastifyInstance, transactionId = TX) =>
    app.inject({
      method: "POST",
      url: route("fence"),
      headers: auth,
      payload: { transactionId, challenge: CHALLENGE },
    });

  it("defers when busy, reopens the gate and stops nothing", async () => {
    const { deps, busy, maintenance, keyFile } = await setup();
    busy.push([{ kind: "agent-turn", agentId: "agt_1" }]);
    const app = await harness(maintenance, keyFile);

    const res = await fence(app);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: "BUSY",
      reasons: [{ kind: "agent-turn", agentId: "agt_1" }],
    });
    expect(verify("fence", res.json())).toBe(true);
    expect(deps.stopWriters).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
    expect(maintenance.mode).toBe("normal");

    const write = await app.inject({ method: "POST", url: "/api/v1/agents" });
    expect(write.statusCode).toBe(200);
  });

  it("fences when idle: stops writers and rejects new mutations", async () => {
    const { deps, maintenance, keyFile } = await setup();
    const app = await harness(maintenance, keyFile);

    const res = await fence(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      hostsStopped: true,
      statePaths: ["/state"],
      macBuild: null,
      mode: "fenced",
      transactionId: TX,
      version: VERSION,
      instance: { stateDir: "/state", port: 6767 },
    });
    expect(verify("fence", body)).toBe(true);
    expect(deps.stopWriters).toHaveBeenCalledOnce();
    expect(deps.quiesceHosts).toHaveBeenCalledExactlyOnceWith(TX);
    expect(deps.busyReasons).toHaveBeenCalledTimes(2);

    const write = await app.inject({ method: "POST", url: "/api/v1/agents" });
    expect(write.statusCode).toBe(503);
    expect(write.json().code).toBe("MAINTENANCE");
    const upgrade = await app.inject({
      url: "/api/v1/agents",
      headers: { upgrade: "websocket" },
    });
    expect(upgrade.statusCode).toBe(503);
    const read = await app.inject({ url: "/api/v1/agents" });
    expect(read.statusCode).toBe(200);

    // Idempotent for the holder; another transaction cannot take it.
    expect((await fence(app)).statusCode).toBe(200);
    expect(deps.stopWriters).toHaveBeenCalledOnce();
    const other = await fence(app, OTHER_TX);
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe("FENCED_BY_OTHER");
  });

  it("drains in-flight mutating requests before checking activity", async () => {
    const { deps, maintenance, keyFile } = await setup();
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => (finish = resolve));
    const app = await harness(maintenance, keyFile, slow);

    const write = app.inject({ method: "POST", url: "/api/v1/agents" });
    await vi.waitFor(() => expect(maintenance["inFlight"].size).toBe(1));
    const fenced = fence(app);
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.busyReasons).not.toHaveBeenCalled();
    // A request arriving mid-fence is already refused.
    const late = await app.inject({ method: "POST", url: "/api/v1/agents" });
    expect(late.statusCode).toBe(503);
    finish();
    expect((await write).statusCode).toBe(200);
    expect((await fenced).statusCode).toBe(200);
  });

  it("gives up and reopens when draining times out", async () => {
    const { deps, maintenance, keyFile } = await setup();
    const app = await harness(maintenance, keyFile, new Promise(() => {}));
    void app.inject({ method: "POST", url: "/api/v1/agents" });
    await vi.waitFor(() => expect(maintenance["inFlight"].size).toBe(1));
    const res = await fence(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("DRAIN_TIMEOUT");
    expect(deps.stopWriters).not.toHaveBeenCalled();
    expect(maintenance.mode).toBe("normal");
  });

  it("restarts when work appears after writers stop", async () => {
    const { deps, busy, maintenance, keyFile } = await setup();
    busy.push([], [{ kind: "job-run" }]);
    const app = await harness(maintenance, keyFile);
    const res = await fence(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("BUSY_AFTER_FENCE");
    expect(deps.exit).toHaveBeenCalledWith(RECOVERY_EXIT_CODE);
  });

  it("fails closed and restarts when hosts survive quiescing", async () => {
    const { deps, maintenance, keyFile } = await setup({
      quiesceHosts: vi.fn(
        async (): Promise<BusyReason[]> => [
          { kind: "host-still-running", agentId: "agt_2" },
        ]
      ),
    });
    const app = await harness(maintenance, keyFile);
    const res = await fence(app);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: "HOSTS_NOT_QUIESCED",
      reasons: [{ kind: "host-still-running", agentId: "agt_2" }],
    });
    expect(maintenance.mode).toBe("normal");
    expect(deps.exit).toHaveBeenCalledWith(RECOVERY_EXIT_CODE);
  });

  it("does not stop hosts when busy", async () => {
    const { deps, busy, maintenance, keyFile } = await setup();
    busy.push([{ kind: "host-unattached", agentId: "agt_3" }]);
    const app = await harness(maintenance, keyFile);
    expect((await fence(app)).statusCode).toBe(409);
    expect(deps.quiesceHosts).not.toHaveBeenCalled();
  });

  it("restarts if stopping writers fails partway", async () => {
    const { deps, maintenance, keyFile } = await setup({
      stopWriters: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const app = await harness(maintenance, keyFile);
    const res = await fence(app);
    expect(res.statusCode).toBe(500);
    expect(deps.exit).toHaveBeenCalledWith(RECOVERY_EXIT_CODE);
  });

  it("restarts on lease expiry and on helper abort", async () => {
    vi.useFakeTimers();
    const first = await setup();
    await first.maintenance.fence({ transactionId: TX, leaseMs: 20_000 });
    expect(first.maintenance.mode).toBe("fenced");
    vi.advanceTimersByTime(19_999);
    expect(first.deps.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first.deps.exit).toHaveBeenCalledWith(RECOVERY_EXIT_CODE);
    vi.useRealTimers();

    const second = await setup();
    const app = await harness(second.maintenance, second.keyFile);
    const notFenced = await app.inject({
      method: "DELETE",
      url: route("fence"),
      headers: auth,
      payload: { transactionId: TX, challenge: CHALLENGE },
    });
    expect(notFenced.statusCode).toBe(409);
    await fence(app);
    const aborted = await app.inject({
      method: "DELETE",
      url: route("fence"),
      headers: auth,
      payload: { transactionId: TX, challenge: CHALLENGE },
    });
    expect(aborted.statusCode).toBe(202);
    expect(verify("fence-abort", aborted.json())).toBe(true);
    expect(second.deps.exit).toHaveBeenCalledWith(RECOVERY_EXIT_CODE);
  });
});

describe("probation", () => {
  async function setup(overrides: Partial<MaintenanceDeps> = {}) {
    const dir = await tempDir();
    const keyFile = await privateFile(dir, "control.key", KEY);
    const { deps } = makeDeps(overrides);
    const maintenance = new RecoveryMaintenance(deps, PROBATION);
    const app = await harness(maintenance, keyFile);
    return { deps, maintenance, app };
  }
  const ready = (
    app: FastifyInstance,
    overrides: Record<string, string> = {}
  ) =>
    app.inject({
      method: "POST",
      url: route("readiness"),
      headers: auth,
      payload: {
        transactionId: TX,
        nonce: NONCE,
        instanceId: "instance-a",
        expectedVersion: VERSION,
        challenge: CHALLENGE,
        ...overrides,
      },
    });

  it("admits only health and recovery routes, and never fences", async () => {
    const { app, maintenance } = await setup();
    expect((await app.inject({ url: "/api/v1/health" })).statusCode).toBe(200);
    const read = await app.inject({ url: "/api/v1/agents" });
    expect(read.statusCode).toBe(503);
    expect(read.json().code).toBe("PROBATION");
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/agents" })).statusCode
    ).toBe(503);
    const fence = await maintenance.fence({ transactionId: TX });
    expect(fence).toMatchObject({ ok: false, code: "IN_PROBATION" });
    expect(maintenance.mode).toBe("probation");
  });

  it("reports STARTING until initialization completes", async () => {
    const { app, deps } = await setup();
    const res = await ready(app);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("STARTING");
    expect(deps.probeDatabase).not.toHaveBeenCalled();
  });

  it("rejects mismatched transaction, nonce, instance and version", async () => {
    const { app, maintenance } = await setup();
    maintenance.markProbationReady();
    const cases: Array<[Record<string, string>, string]> = [
      [{ transactionId: OTHER_TX }, "TRANSACTION_MISMATCH"],
      [{ nonce: "aa".repeat(20) }, "TRANSACTION_MISMATCH"],
      [{ instanceId: "instance-b" }, "INSTANCE_MISMATCH"],
      [{ expectedVersion: "2.0.1" }, "VERSION_MISMATCH"],
    ];
    expect(
      (await ready(app, { expectedVersion: `v${VERSION}` })).statusCode
    ).toBe(200);
    for (const [override, code] of cases) {
      const res = await ready(app, override);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ready: false, code });
    }
  });

  it("proves readiness with a nonce-bound proof after a DB probe", async () => {
    const { app, maintenance, deps } = await setup();
    maintenance.markProbationReady();
    const res = await ready(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      hostsStopped: true,
      statePaths: ["/state"],
      ready: true,
      transactionId: TX,
      instanceId: "instance-a",
      version: VERSION,
      database: { name: "dispatch", systemIdentifier: "7000" },
    });
    expect(JSON.stringify(body)).not.toContain(NONCE);
    expect(verify("readiness", body, { nonce: NONCE })).toBe(true);
    expect(verify("readiness", body)).toBe(false);
    expect(deps.probeDatabase).toHaveBeenCalledOnce();
    // Readiness never opens the gate.
    expect(maintenance.mode).toBe("probation");
    expect((await app.inject({ url: "/api/v1/agents" })).statusCode).toBe(503);
  });

  it("is not ready while any agent host is alive", async () => {
    const { app, maintenance } = await setup({
      boundary: vi.fn(async () => ({
        hostsStopped: false,
        liveHosts: ["agt_9"],
        statePaths: ["/state"],
        macBuild: "42",
      })),
    });
    maintenance.markProbationReady();
    const res = await ready(app);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      ready: false,
      code: "HOSTS_RUNNING",
      liveHosts: ["agt_9"],
    });
    expect(verify("readiness", res.json())).toBe(true);
  });

  it("is not ready when the database probe fails", async () => {
    const { app, maintenance } = await setup({
      probeDatabase: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    maintenance.markProbationReady();
    const res = await ready(app);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("DATABASE_PROBE_FAILED");
  });
});

describe("resolveStatePaths", () => {
  it("resolves real paths, dedupes and drops nested entries", async () => {
    const dir = await tempDir();
    const real = await realpath(dir);
    await mkdir(path.join(dir, "files"));
    expect(
      await resolveStatePaths([
        path.join(dir, "files"),
        dir,
        `${dir}/`,
        path.join(dir, "missing", "release.json"),
        "/elsewhere/agent-state",
      ])
    ).toEqual(["/elsewhere/agent-state", real].sort());
    await expect(resolveStatePaths(["relative"])).rejects.toThrow();
  });
});

describe("resume receipt", () => {
  const receipt = (createdAt = new Date().toISOString()): ResumeReceipt => ({
    formatVersion: 1,
    transactionId: TX,
    createdAt,
    agents: [{ id: "agt_abc", updatedAt: "2026-10-01 20:00:00.123456-06" }],
  });

  it("writes privately and is taken at most once", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "update-recovery", "resume-hosts.json");
    const written = receipt();
    await writeResumeReceipt(file, written);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(file))).toEqual(["resume-hosts.json"]);

    expect(await takeResumeReceipt(file)).toEqual({
      status: "ok",
      receipt: written,
    });
    expect(await takeResumeReceipt(file)).toEqual({ status: "none" });
  });

  it("sets aside expired, malformed and unsafe receipts without resuming", async () => {
    const dir = await tempDir();
    const now = Date.parse("2026-10-02T00:00:00Z");
    const json = (createdAt: string, extra: object = {}) =>
      JSON.stringify({ ...receipt(createdAt), ...extra });
    const cases: Array<[string, string, string, number?]> = [
      ["expired.json", json("2026-09-30T00:00:00Z"), "expired"],
      ["future.json", json("2026-10-03T00:00:00Z"), "expired"],
      ["malformed.json", "{", "invalid"],
      [
        "extra.json",
        json("2026-10-01T23:00:00Z", { replay: ["prompt"] }),
        "invalid",
      ],
      ["shared.json", json("2026-10-01T23:00:00Z"), "unsafe", 0o644],
    ];
    for (const [name, body, reason, mode] of cases) {
      const file = await privateFile(dir, name, body);
      if (mode) await chmod(file, mode);
      expect(await takeResumeReceipt(file, { now })).toEqual({
        status: "rejected",
        reason,
      });
      // Kept for inspection, and never offered again.
      expect(await takeResumeReceipt(file, { now })).toEqual({
        status: "none",
      });
    }
    const left = await readdir(dir);
    expect(left.filter((f) => f.includes(".rejected-"))).toHaveLength(
      cases.length
    );
  });
});

describe("probeDatabase", () => {
  function fakePool(readOnly = "off", controlDenied = false) {
    const statements: string[] = [];
    const release = vi.fn();
    const client = {
      release,
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (text.startsWith("SHOW"))
          return { rows: [{ transaction_read_only: readOnly }] };
        if (text.includes("current_database"))
          return { rows: [{ name: "dispatch", database_oid: "16384" }] };
        if (text.includes("pg_control_system")) {
          if (controlDenied) throw new Error("permission denied");
          return { rows: [{ id: "7000" }] };
        }
        if (text.includes("pgmigrations"))
          return { rows: [{ count: 3, latest: "003_x" }] };
        if (text.includes("auth_token")) return { rows: [{ "?column?": 1 }] };
        if (text.startsWith("SELECT v")) return { rows: [{ v: "probe" }] };
        return { rows: [] };
      }),
    };
    return { pool: { connect: async () => client }, statements, release };
  }

  it("runs inside a transaction that is always rolled back", async () => {
    const { pool, statements, release } = fakePool();
    await expect(probeDatabase(pool)).resolves.toEqual({
      name: "dispatch",
      oid: "16384",
      systemIdentifier: "7000",
      migrations: { count: 3, latest: "003_x" },
    });
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("falls back to the database oid without control privileges", async () => {
    const { pool, statements } = fakePool("off", true);
    const probe = await probeDatabase(pool);
    expect(probe).toMatchObject({ oid: "16384", systemIdentifier: null });
    expect(statements).toContain(
      "ROLLBACK TO SAVEPOINT dispatch_recovery_identity"
    );
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it("rejects a read-only database and still rolls back", async () => {
    const { pool, statements, release } = fakePool("on");
    await expect(probeDatabase(pool)).rejects.toThrow(/read-only/);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});

it("restarts probation after a bounded lifetime even when its helper disappears", async () => {
  vi.useFakeTimers();
  const { deps } = makeDeps();
  const maintenance = new RecoveryMaintenance(deps, PROBATION);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(deps.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(deps.exit).toHaveBeenCalledWith(RECOVERY_EXIT_CODE);
  expect(maintenance.mode).toBe("probation");
});

it("accepts transaction-scoped abort while fencing is still in flight", async () => {
  let release!: () => void;
  const { deps } = makeDeps({
    stopWriters: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  const maintenance = new RecoveryMaintenance(deps);
  const pending = maintenance.fence({ transactionId: TX });
  while (!release) await Promise.resolve();
  expect(maintenance.abort(OTHER_TX).ok).toBe(false);
  expect(maintenance.abort(TX).ok).toBe(true);
  expect(deps.exit).toHaveBeenCalledWith(RECOVERY_EXIT_CODE);
  release();
  await pending;
});
