import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import { MacAppUpdateBridge } from "../../src/mac-app-update-bridge.js";
import { registerMacAppRoutes } from "../../src/routes/mac-app.js";
import { installRequestLifecycle } from "../../src/server/request-lifecycle.js";
import { RecoveryMaintenance } from "../../src/update-recovery/maintenance.js";

export const macAuthCases = [
  "missing",
  "wrong-token",
  "wrong-scheme",
  "authorized",
  "authorized-loss",
  "delayed-state",
  "delayed-control",
  "delayed-state-loss",
  "delayed-control-loss",
  "delayed-pre-serialization-state-loss",
  "delayed-pre-serialization-control-loss",
] as const;
type Case = (typeof macAuthCases)[number];
const TOKEN = "a".repeat(64);
const STATE = {
  version: "1.0.1",
  phase: "idle" as const,
  availableVersion: "1.0.2",
  checkedAt: "2026-10-01T12:00:00.000Z",
  error: null,
  automatic: false,
};
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Mac app lifecycle fixture did not reach expected state");
}

/** Actual Mac routes and bridge; in-memory control stream supplies state prerequisite. */
export async function runMacAuthScenario(kind: Case) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let admitted = false,
    reports = 0,
    attaches = 0,
    delayEntered = false,
    serializationReturned = false,
    published = 0,
    stops = 0,
    finishes = 0;
  let fenceDuringDelay: unknown;
  const bridge = new MacAppUpdateBridge(() => {
    published++;
  });
  const attach = bridge.attach.bind(bridge);
  bridge.attach = (stream) => {
    attaches++;
    return attach(stream);
  };
  const report = bridge.report.bind(bridge);
  bridge.report = (state) => {
    reports++;
    return report(state);
  };
  const maintenance = new RecoveryMaintenance({
    version: "fixture",
    instance: {
      instanceId: "fixture",
      stateDir: "/unused",
      port: 0,
      macInstanceId: null,
    },
    busyReasons: async () => [],
    stopWriters: async () => {
      stops++;
    },
    quiesceHosts: async () => [],
    probeDatabase: async () => {
      throw Error("unused");
    },
    boundary: async () => ({
      hostsStopped: true,
      liveHosts: [],
      statePaths: [],
      macBuild: null,
    }),
    exit: () => {
      throw Error("unexpected exit");
    },
    log: { info() {}, warn() {} },
    drainTimeoutMs: 25,
  });
  const app = Fastify();
  installRequestLifecycle(app, {
    started: () => {},
    finished: (req) => {
      finishes++;
      maintenance.requestFinished(req);
    },
  });
  app.addHook("onRequest", async (req, reply) => {
    const refused = maintenance.admit(req);
    if (refused) return reply.code(503).send(refused);
    maintenance.requestStarted(req, req.method);
  });
  app.addHook(
    kind.includes("pre-serialization") ? "preSerialization" : "onSend",
    async (_request, reply, payload) => {
      if (kind.startsWith("delayed-") && reply.statusCode === 401) {
        delayEntered = true;
        await held;
        serializationReturned = true;
      }
      return payload;
    }
  );
  app.addHook("onRoute", (options) => {
    if (kind.startsWith("delayed-")) return;
    if (options.url !== "/api/v1/mac-app/state") return;
    const auth = options.preHandler ? [options.preHandler].flat() : [];
    // The actual app-only auth must pass before this held application stage.
    options.preHandler = [
      ...auth,
      async () => {
        admitted = true;
        await held;
      },
    ];
  });
  await registerMacAppRoutes(app, { bridge, controlToken: TOKEN });
  let control: PassThrough | undefined;
  let detach: (() => void) | undefined;
  const clients = new Set<http.ClientRequest>();
  async function request(method: "GET" | "POST", path: string) {
    const body = method === "POST" ? JSON.stringify(STATE) : undefined;
    const authorization =
      kind === "missing"
        ? undefined
        : kind === "wrong-token" || kind.startsWith("delayed-")
          ? `Bearer ${"b".repeat(64)}`
          : kind === "wrong-scheme"
            ? `bearer ${TOKEN}`
            : `Bearer ${TOKEN}`;
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const client = http.request(
        {
          host: "127.0.0.1",
          port: (app.server.address() as { port: number }).port,
          method,
          path,
          headers: {
            ...(authorization ? { authorization } : {}),
            ...(body
              ? {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(body),
                }
              : {}),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () => {
            try {
              resolve({ status: response.statusCode!, body: JSON.parse(text) });
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      clients.add(client);
      client.on("error", reject);
      client.end(body);
    });
  }
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    if (kind.startsWith("delayed-")) {
      const method = kind.includes("state") ? "POST" : "GET";
      const path = kind.includes("state")
        ? "/api/v1/mac-app/state"
        : "/api/v1/mac-app/control";
      // Observe rejection immediately so failed baseline cleanup cannot create
      // an unhandled client error when the forbidden SSE route was entered.
      const pending = request(method, path).catch((error) => ({ error }));
      await until(() => delayEntered);
      if (kind.endsWith("-loss")) {
        for (const client of clients) client.destroy();
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        reports,
        0,
        "delayed unauthorized state response must never report"
      );
      assert.equal(
        attaches,
        0,
        "delayed unauthorized control response must never attach"
      );
      assert.equal(published, 0);
      assert.deepEqual(bridge.snapshot(), { connected: false, state: null });
      if (method === "POST") {
        fenceDuringDelay = await maintenance.fence({
          transactionId: "delayed",
        });
        assert.deepEqual(fenceDuringDelay, {
          ok: false,
          status: 409,
          code: "DRAIN_TIMEOUT",
        });
        assert.equal(stops, 0);
      } else {
        // Preserve existing safe-GET admission semantics. Even if this fence
        // succeeds during the delayed401, auth must never reach bridge.attach.
        fenceDuringDelay = await maintenance.fence({
          transactionId: "finished",
        });
        assert.deepEqual(fenceDuringDelay, { ok: true });
        assert.equal(stops, 1);
      }
      assert.equal(
        finishes,
        0,
        "resource work stays owned while onSend is held"
      );
      release();
      if (kind.endsWith("-loss")) {
        // Bun may omit ClientRequest's error callback after destroy; the real
        // disconnected request is not a promise-completion signal for the app.
        for (const client of clients) assert.equal(client.destroyed, true);
      } else
        assert.deepEqual(await pending, {
          status: 401,
          body: { error: "Authentication required." },
        });
      if (kind.includes("pre-serialization") && !process.versions.bun) {
        await until(() => serializationReturned);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(reports, 0);
        assert.equal(attaches, 0);
        assert.equal(published, 0);
        assert.equal(
          finishes,
          0,
          "unknown lost response ownership stays conservative"
        );
        if (method === "POST") {
          assert.deepEqual(
            await maintenance.fence({ transactionId: "unknown" }),
            { ok: false, status: 409, code: "DRAIN_TIMEOUT" }
          );
          assert.equal(stops, 0);
        }
        return {
          scenario: `mac-auth:${kind}`,
          reports,
          attaches,
          published,
          finishes,
          stops,
          conservative: true,
        };
      }
      await until(() => finishes === 1);
      assert.equal(reports, 0);
      assert.equal(attaches, 0);
      assert.equal(published, 0);
    } else if (kind.startsWith("authorized")) {
      control = new PassThrough();
      detach = bridge.attach(control);
      const baselinePublished = published;
      const pending = request("POST", "/api/v1/mac-app/state").catch(
        (error) => ({ error })
      );
      await until(() => admitted);
      if (kind === "authorized-loss") {
        for (const client of clients) client.destroy();
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.equal(reports, 0);
      assert.equal(bridge.snapshot().state, null);
      assert.deepEqual(await maintenance.fence({ transactionId: "held" }), {
        ok: false,
        status: 409,
        code: "DRAIN_TIMEOUT",
      });
      assert.equal(stops, 0);
      release();
      if (kind === "authorized-loss") {
        for (const client of clients) assert.equal(client.destroyed, true);
      } else
        assert.deepEqual(await pending, { status: 200, body: { ok: true } });
      await until(() => finishes === 1);
      assert.equal(reports, 1);
      assert.equal(published, baselinePublished + 1);
      assert.deepEqual(bridge.snapshot(), { connected: true, state: STATE });
    } else {
      assert.deepEqual(await request("GET", "/api/v1/mac-app/control"), {
        status: 401,
        body: { error: "Authentication required." },
      });
      assert.deepEqual(await request("POST", "/api/v1/mac-app/state"), {
        status: 401,
        body: { error: "Authentication required." },
      });
      assert.equal(admitted, false);
      assert.equal(reports, 0);
      assert.equal(published, 0);
      assert.deepEqual(bridge.snapshot(), { connected: false, state: null });
    }
    assert.deepEqual(
      await maintenance.fence({ transactionId: "finished" }),
      { ok: true },
      "completed auth response must not leak request ownership"
    );
    await until(
      () =>
        finishes ===
        (kind.startsWith("authorized") || kind.startsWith("delayed-") ? 1 : 2)
    );
    assert.equal((await maintenance.activity()).busy, false);
    assert.equal(stops, 1);
    return {
      scenario: `mac-auth:${kind}`,
      reports,
      attaches,
      published,
      finishes,
      stops,
      authorizedHeld: kind.startsWith("authorized"),
      fenceDuringDelay,
    };
  } finally {
    release();
    for (const client of clients) client.destroy();
    detach?.();
    control?.destroy();
    await app.close();
  }
}
