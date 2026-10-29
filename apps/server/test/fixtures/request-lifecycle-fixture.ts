import {
  parserOwnershipCases,
  runParserOwnershipScenario,
} from "./request-parser-ownership.js";
import websocket from "@fastify/websocket";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { installRequestLifecycle } from "../../src/server/request-lifecycle.js";
import { RecoveryMaintenance } from "../../src/update-recovery/maintenance.js";
import { listenAdditionalHosts } from "../../src/multi-listener.js";

const delay = (ms = 10) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay();
  }
  assert.fail("Lifecycle did not reach expected state");
}
export const scenarios = [
  "lost-success",
  "lost-error",
  "lost-undefined",
  "early-on-request",
  "throw-response-hook",
  "callback-response-error",
  "unmatched",
  "custom-notfound",
  "async-parser",
  "lost-transformed-stream",
  "normal",
  "early-handler",
  "early-global-hook",
  "early-route-hook",
  "global-error-handler",
  "route-error-handler",
  "on-error",
  "throw-on-send",
  "callback-hook",
  "response-hooks",
  "socket-timeout",
  "body-abort",
  "stream-drain",
  "lost-stream",
  "hijack-drain",
  "lost-hijack",

  "backpressure",
] as const;
const expectedMutations: Record<(typeof scenarios)[number], number> = {
  "lost-success": 1,
  "lost-error": 1,
  "lost-undefined": 1,
  "early-on-request": 1,
  "throw-response-hook": 1,
  "callback-response-error": 1,
  unmatched: 0,
  "custom-notfound": 1,
  "async-parser": 1,
  "lost-transformed-stream": 0,
  normal: 1,
  "early-handler": 1,
  "early-global-hook": 1,
  "early-route-hook": 1,
  "global-error-handler": 1,
  "route-error-handler": 1,
  "on-error": 1,
  "throw-on-send": 1,
  "callback-hook": 1,
  "response-hooks": 2,
  "socket-timeout": 1,
  "body-abort": 0,
  "stream-drain": 0,
  "lost-stream": 0,
  "hijack-drain": 1,
  "lost-hijack": 1,
  backpressure: 0,
};
export type Scenario = (typeof scenarios)[number];
export type Transport = "http" | "tls-additional";

export async function runScenario(
  scenario: Scenario,
  transport: Transport = "http"
) {
  const events: string[] = [];
  let stops = 0,
    starts = 0,
    finishes = 0,
    mutations = 0;
  const entered = deferred(),
    held = deferred(),
    sent = deferred();
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
      throw Error("Unexpected exit");
    },
    log: { info() {}, warn() {} },
    drainTimeoutMs: 25,
  });
  let tls: { cert: string; key: string } | undefined;
  let certDir: string | undefined;
  if (transport === "tls-additional") {
    certDir = mkdtempSync(join(tmpdir(), "dispatch-lifecycle-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(certDir, "key.pem"),
        "-out",
        join(certDir, "cert.pem"),
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
      ],
      { stdio: "ignore" }
    );
    tls = {
      cert: readFileSync(join(certDir, "cert.pem"), "utf8"),
      key: readFileSync(join(certDir, "key.pem"), "utf8"),
    };
  }
  const app = Fastify({
    ...(tls ? { https: tls } : {}),
    ...(scenario === "socket-timeout" ? { connectionTimeout: 35 } : {}),
  }) as unknown as FastifyInstance;
  installRequestLifecycle(app, {
    started: () => {
      starts++;
    },
    finished: (request, status) => {
      finishes++;
      events.push(`finished:${status}`);
      maintenance.requestFinished(request);
    },
  });
  app.addHook("onRequest", (request, reply, done) => {
    const refused = maintenance.admit(request);
    if (refused) return void reply.code(503).send(refused);
    maintenance.requestStarted(request, request.method);
    done();
  });
  app.addHook("onSend", async (_request, _reply, payload) => {
    events.push("onSend");
    sent.resolve();
    return payload;
  });
  app.addHook("onTimeout", async () => {
    events.push("onTimeout");
    sent.resolve();
  });
  app.addHook("onResponse", async () => {
    events.push("onResponse");
  });
  let request: FastifyRequest | undefined;
  let response: http.ServerResponse | undefined;
  app.addHook("onRequest", async (req, reply) => {
    request = req;
    response = reply.raw;
  });
  if (["early-global-hook", "early-on-request"].includes(scenario))
    app.addHook(
      scenario === "early-on-request" ? "onRequest" : "preValidation",
      async (_request, reply) => {
        reply.send({ early: true });
        entered.resolve();
        await held.promise;
        mutations++;
      }
    );
  if (scenario === "on-error")
    app.addHook("onError", async () => {
      entered.resolve();
      await held.promise;
      mutations++;
      throw Error("error hook failed");
    });
  if (scenario === "throw-on-send")
    app.addHook("onSend", async (_request, reply, payload) => {
      if (reply.statusCode === 200) {
        entered.resolve();
        await held.promise;
        mutations++;
        throw Error("send hook failed");
      }
      return payload;
    });
  if (scenario === "global-error-handler")
    app.setErrorHandler(async (_error, _request, reply) => {
      reply.code(500).send({ error: true });
      entered.resolve();
      await held.promise;
      mutations++;
    });
  if (scenario === "throw-response-hook")
    app.addHook("onResponse", async () => {
      entered.resolve();
      await held.promise;
      mutations++;
      throw Error("response hook failed");
    });
  if (scenario === "callback-response-error")
    app.addHook("onResponse", (_req, _reply, done) => {
      entered.resolve();
      held.promise.then(() => {
        mutations++;
        done(Error("response callback failed"));
      });
    });
  if (scenario === "response-hooks") {
    app.addHook("onResponse", async () => {
      // Fence at the exact promise-runner transition before the next hook.
      queueMicrotask(() => {
        void maintenance.fence({ transactionId: "held" });
      });
    });
    app.addHook("onResponse", async () => {
      entered.resolve();
      await held.promise;
      mutations++;
    });
    app.addHook("onResponse", (_req, _reply, done) => {
      queueMicrotask(() => {
        mutations++;
        done();
      });
    });
  }
  if (scenario === "async-parser")
    app.addContentTypeParser(
      "application/x-fixture",
      { parseAs: "string" },
      async (_req, body) => {
        entered.resolve();
        await held.promise;
        mutations++;
        return JSON.parse(body as string);
      }
    );
  if (scenario === "custom-notfound")
    app.setNotFoundHandler(async (_req, reply) => {
      reply.code(404).send({ missing: true });
      entered.resolve();
      await held.promise;
      mutations++;
    });
  const stream = new PassThrough();
  let closeAdditional: (() => Promise<void>) | undefined;
  let client: http.ClientRequest | undefined;
  let socket: net.Socket | undefined;
  let port = 0;
  try {
    await app.register(async (outer) => {
      await outer.register(async (inner) => {
        if (scenario === "callback-hook")
          inner.addHook("preHandler", function (_request, reply, done) {
            assert.equal(this, inner);
            entered.resolve();
            held.promise.then(() => {
              mutations++;
              done();
            });
          });
        // A plugin's later onRoute replacement must not escape instrumentation.
        inner.addHook("onRoute", (options) => {
          const original = options.handler;
          options.handler = function (req, reply) {
            return original.call(this, req, reply);
          };
        });
        inner.post(
          "/api/work",
          {
            ...(scenario === "lost-transformed-stream"
              ? { onSend: async () => stream }
              : {}),
            ...(scenario === "early-route-hook"
              ? {
                  preHandler: [
                    async (_request: unknown, reply: any) => {
                      reply.send({ early: true });
                      entered.resolve();
                      await held.promise;
                      mutations++;
                    },
                  ],
                }
              : {}),
            ...(scenario === "route-error-handler"
              ? {
                  errorHandler: async (
                    _error: unknown,
                    _request: unknown,
                    reply: any
                  ) => {
                    reply.code(500).send({ error: true });
                    entered.resolve();
                    await held.promise;
                    mutations++;
                  },
                }
              : {}),
          },
          async (req, reply) => {
            assert.deepEqual(req.body, { complete: true });
            if (scenario === "async-parser") return { ok: true };
            if (scenario === "lost-transformed-stream") {
              entered.resolve();
              return "transform";
            }
            if (
              [
                "global-error-handler",
                "route-error-handler",
                "on-error",
              ].includes(scenario)
            )
              throw Error("handler failed");
            if (
              scenario === "throw-on-send" ||
              [
                "response-hooks",
                "throw-response-hook",
                "callback-response-error",
              ].includes(scenario)
            )
              return { ok: true };
            if (
              scenario === "early-global-hook" ||
              scenario === "early-route-hook"
            )
              assert.fail("early hook must stop handler");
            if (scenario === "callback-hook") return { ok: true };
            if (["stream-drain", "lost-stream"].includes(scenario)) {
              entered.resolve();
              return reply.send(stream);
            }
            if (["hijack-drain", "lost-hijack"].includes(scenario)) {
              reply.hijack();
              entered.resolve();
              await held.promise;
              mutations++;
              reply.raw.end("owned");
              return;
            }
            if (scenario === "backpressure") {
              entered.resolve();
              return "x".repeat(64 * 1024 * 1024);
            }
            if (scenario === "early-handler") reply.send({ early: true });
            entered.resolve();
            await held.promise;
            mutations++;
            if (scenario === "lost-error") throw Error("handler failed");
            return scenario === "lost-undefined" ? undefined : { ok: true };
          }
        );
      });
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as { port: number }).port;
    if (tls)
      closeAdditional = await listenAdditionalHosts(app, ["::1"], port, tls);
    const hostname = tls ? "::1" : "127.0.0.1";
    const body = JSON.stringify({ complete: true });
    if (scenario === "backpressure" || scenario === "body-abort") {
      // Raw TCP client pauses reads; Bun's fetch-backed HTTP client eagerly
      // consumes the response and would hide transport backpressure here.
      if (tls) throw Error("backpressure fixture uses primary HTTP");
      socket = net.createConnection({ host: hostname, port });
      socket.on("error", () => {});
      await once(socket, "connect");
      socket.pause();
      socket.write(
        `POST /api/work HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${scenario === "body-abort" ? 1000 : body.length}\r\n\r\n${scenario === "body-abort" ? '{"incomplete":' : body}`
      );
    } else {
      client = (tls ? https : http).request({
        hostname,
        port,
        method: "POST",
        path: ["unmatched", "custom-notfound"].includes(scenario)
          ? "/api/missing"
          : "/api/work?secret=never-log",
        rejectUnauthorized: false,
        headers: {
          "content-type":
            scenario === "async-parser"
              ? "application/x-fixture"
              : "application/json",
          "content-length":
            scenario === "body-abort" ? 1000 : Buffer.byteLength(body),
        },
      });
      client.on("error", () => {});
      client.on("response", (response) => response.resume());
      if (scenario === "body-abort") {
        client.write('{"incomplete":');
        await until(() => starts === 1);
      } else client.end(body);
    }
    if (scenario === "unmatched") {
      await until(() => finishes === 1);
    } else if (scenario === "body-abort") {
      await until(() => starts === 1);
      (client ?? socket)!.destroy();
      await until(async () => !(await maintenance.activity()).busy);
      assert.equal(mutations, 0);
    } else {
      await entered.promise;
      const lost = [
        "lost-success",
        "lost-error",
        "lost-undefined",
        "lost-stream",
        "lost-transformed-stream",
        "lost-hijack",
      ].includes(scenario);
      if (lost) {
        client!.destroy();
        await delay(40);
      }
      if (scenario === "socket-timeout") {
        if (process.versions.bun) {
          // Bun 1.3.13's request socket setTimeout is a no-op. Exercise the
          // actual Fastify timeout runner via its socket event; Node uses a
          // real configured connection timeout below.
          events.push("timeout:injected-socket-event-on-bun");
          request!.raw.socket.emit("timeout");
        }
        await sent.promise;
      }
      if (scenario === "backpressure") {
        await delay(30);
        events.push(
          `backpressure:${JSON.stringify({ finished: response!.finished, writableFinished: response!.writableFinished, length: response!.writableLength, needDrain: response!.writableNeedDrain })}`
        );
        // Node keeps the response draining. Bun 1.3.13 reports finish after
        // accepting output into its native transport (the pre-existing contract).
        if (process.versions.bun === "1.3.13")
          assert.equal(
            response!.finished,
            true,
            "healthy buffered Bun end must not match lost-response fallback"
          );
        if (!process.versions.bun) {
          assert.equal((await maintenance.activity()).busy, true);
          assert.deepEqual(await maintenance.fence({ transactionId: "held" }), {
            ok: false,
            status: 409,
            code: "DRAIN_TIMEOUT",
          });
          assert.equal(stops, 0);
        }
        socket!.on("data", () => {});
        socket!.resume();
      } else {
        assert.equal(
          (await maintenance.activity()).busy,
          true,
          "work must remain owned"
        );
        assert.deepEqual(await maintenance.fence({ transactionId: "held" }), {
          ok: false,
          status: 409,
          code: "DRAIN_TIMEOUT",
        });
        assert.equal(
          stops,
          0,
          "must not stop writers while application/stream is active"
        );
      }
      held.resolve();
      if (
        ["stream-drain", "lost-stream", "lost-transformed-stream"].includes(
          scenario
        )
      )
        stream.end("done");
      if (
        ["lost-stream", "lost-transformed-stream", "lost-hijack"].includes(
          scenario
        )
      ) {
        await delay(50);
        assert.equal(
          (await maintenance.activity()).busy,
          true,
          "lost external ownership must fail closed"
        );
        assert.equal(finishes, 0);
        assert.equal(
          mutations,
          expectedMutations[scenario],
          "owned work actually executed"
        );
        return {
          scenario,
          transport,
          events,
          starts,
          finishes,
          mutations,
          stops,
          conservative: true,
        };
      }
      await until(async () => !(await maintenance.activity()).busy);
    }
    assert.equal(
      mutations,
      expectedMutations[scenario],
      "owned work actually executed"
    );
    assert.equal(finishes, 1, "resource cleanup runs exactly once");
    assert.equal(starts, 1);
    assert.deepEqual(await maintenance.fence({ transactionId: "finished" }), {
      ok: true,
    });
    assert.equal(stops, 1);
    // Duplicate transport callbacks cannot release resources again.
    request?.raw.emit("aborted");
    request?.raw.socket?.emit("timeout");
    await delay();
    assert.equal(finishes, 1);
    return { scenario, transport, events, starts, finishes, mutations, stops };
  } catch (error) {
    console.error({
      scenario,
      starts,
      finishes,
      events,
      aborted: request?.raw.aborted,
      complete: request?.raw.complete,
      routeUrl: request?.routeOptions.url,
    });
    throw error;
  } finally {
    held.resolve();
    stream.destroy();
    client?.destroy();
    socket?.destroy();
    await closeAdditional?.();
    await app.close();
    if (certDir) rmSync(certDir, { recursive: true, force: true });
  }
}

export async function runUpgradeScenario() {
  let hostOwnsWork = false,
    starts = 0,
    finishes = 0,
    stops = 0;
  const refusals: number[] = [];
  const maintenance = new RecoveryMaintenance({
    version: "fixture",
    instance: {
      instanceId: "fixture",
      stateDir: "/unused",
      port: 0,
      macInstanceId: null,
    },
    busyReasons: async () => (hostOwnsWork ? [{ kind: "host-busy" }] : []),
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
  const sockets = new Set<net.Socket>();
  app.server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  installRequestLifecycle(app, {
    started: () => {
      starts++;
    },
    finished: (req) => {
      finishes++;
      maintenance.requestFinished(req);
    },
  });
  app.addHook("onRequest", async (req, reply) => {
    const refused = maintenance.admit(req);
    if (refused) {
      refusals.push(refused.status);
      return reply.code(503).send(refused);
    }
    maintenance.requestStarted(req, req.method);
  });
  await app.register(websocket);
  app.get("/api/socket", { websocket: true }, (socket) => {
    hostOwnsWork = true;
    socket.on("message", () => socket.send("ack"));
  });
  let client: WebSocket | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    client = new WebSocket(`ws://127.0.0.1:${port}/api/socket`);
    await new Promise<void>((resolve, reject) => {
      client!.addEventListener("open", () => client!.send("test"));
      client!.addEventListener("message", () => resolve(), { once: true });
      client!.addEventListener("error", () => reject(Error("upgrade failed")), {
        once: true,
      });
    });
    assert.equal(starts, 1);
    assert.equal(
      finishes,
      0,
      "upgrade does not pretend to be a finite response"
    );
    assert.equal((await maintenance.activity()).busy, true);
    assert.equal(
      (
        (await maintenance.fence({ transactionId: "busy" })) as {
          code?: string;
        }
      ).code,
      "BUSY"
    );
    assert.equal(stops, 0);
    const closed = new Promise<void>((resolve) =>
      client!.addEventListener("close", () => resolve(), { once: true })
    );
    client.close();
    await closed;
    hostOwnsWork = false;
    assert.deepEqual(await maintenance.fence({ transactionId: "idle" }), {
      ok: true,
    });
    assert.equal(stops, 1);
    // The existing gate still owns admission of upgrades even with safe GET.
    const refused = new WebSocket(`ws://127.0.0.1:${port}/api/socket`);
    await new Promise<void>((resolve, reject) => {
      refused.addEventListener("error", () => resolve(), { once: true });
      refused.addEventListener(
        "open",
        () => {
          refused.close();
          reject(Error("fenced upgrade admitted"));
        },
        { once: true }
      );
    });
    assert.deepEqual(refusals, [503]);
    return {
      scenario: "websocket-upgrade",
      starts,
      finishes,
      stops,
      authority: "host-busy",
    };
  } finally {
    client?.close();
    for (const socket of sockets) socket.destroy();
    await app.close();
  }
}

if (process.env.DISPATCH_LIFECYCLE_FIXTURE === "1") {
  const results = [];
  for (const scenario of scenarios) {
    console.error(`scenario:${scenario}`);
    results.push(await runScenario(scenario));
  }
  for (const scenario of [
    "lost-success",
    "lost-error",
    "lost-undefined",
    "early-on-request",
    "throw-response-hook",
    "callback-response-error",
    "unmatched",
    "normal",
    "early-handler",
    "hijack-drain",
  ] as const)
    results.push(await runScenario(scenario, "tls-additional"));
  results.push((await runUpgradeScenario()) as any);
  for (const kind of parserOwnershipCases)
    results.push((await runParserOwnershipScenario(kind)) as any);
  console.log(JSON.stringify({ runtime: process.versions, results }, null, 2));
}
