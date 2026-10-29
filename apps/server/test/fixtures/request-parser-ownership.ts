import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { PassThrough } from "node:stream";
import Fastify, {
  type FastifyRequest,
  type FastifyReply,
  type preParsingHookHandler,
  type preParsingAsyncHookHandler,
} from "fastify";
import { installRequestLifecycle } from "../../src/server/request-lifecycle.js";
import { RecoveryMaintenance } from "../../src/update-recovery/maintenance.js";

export const parserOwnershipCases = [
  "async-global",
  "callback-global",
  "async-route",
  "callback-route",
  "async-parser",
  "callback-parser",
] as const;
type Case = (typeof parserOwnershipCases)[number];
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Parser ownership fixture did not reach expected state");
}

/** Real raw-body abort with an independently live payload/parser owner. */
export async function runParserOwnershipScenario(kind: Case) {
  const events: string[] = [];
  const replacement = new PassThrough();
  const parsed = deferred(),
    mutation = deferred();
  let stops = 0,
    finishes = 0,
    handlerEntered = false,
    ownerEntered = false,
    aborted = false,
    mutations = 0;
  let request: FastifyRequest | undefined;
  let replySnapshot: FastifyReply | undefined;
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
  const app = Fastify();
  installRequestLifecycle(app, {
    started: () => events.push("started"),
    finished: (req) => {
      finishes++;
      events.push("finished");
      maintenance.requestFinished(req);
    },
  });
  app.addHook("onRequest", async (req, reply) => {
    const refused = maintenance.admit(req);
    if (refused) return reply.code(503).send(refused);
    maintenance.requestStarted(req, req.method);
    request = req;
    replySnapshot = reply;
    req.raw.on("aborted", () => {
      aborted = true;
      events.push("raw-aborted");
    });
  });
  const asyncReplacement: preParsingAsyncHookHandler = async () => {
    ownerEntered = true;
    return replacement;
  };
  const callbackReplacement: preParsingHookHandler = (
    _req,
    _reply,
    _payload,
    done
  ) => {
    ownerEntered = true;
    done(null, replacement);
  };
  const isParser = kind.endsWith("parser");
  const hook = kind.startsWith("async")
    ? asyncReplacement
    : callbackReplacement;
  if (isParser) {
    if (kind === "async-parser")
      app.addContentTypeParser("application/x-owner", async () => {
        ownerEntered = true;
        await parsed.promise;
        return {};
      });
    else
      app.addContentTypeParser("application/x-owner", (_req, _stream, done) => {
        ownerEntered = true;
        parsed.promise.then(() => done(null, {}));
      });
  } else if (kind.endsWith("global")) app.addHook("preParsing", hook);
  app.post(
    "/api/work",
    kind.endsWith("route") ? { preParsing: [hook] } : {},
    async (req) => {
      assert.deepEqual(req.body, {});
      handlerEntered = true;
      events.push("handler-entered");
      await mutation.promise;
      mutations++;
      events.push("mutation");
      return { ok: true };
    }
  );
  let socket: net.Socket | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    socket = net.createConnection({
      host: "127.0.0.1",
      port: (app.server.address() as { port: number }).port,
    });
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(
      `POST /api/work HTTP/1.1\r\nHost: localhost\r\nContent-Type: ${isParser ? "application/x-owner" : "application/json"}\r\nContent-Length: 2\r\n\r\n{`
    );
    await until(() => ownerEntered);
    socket.destroy();
    if (process.versions.bun) {
      // Bun may not publish a raw abort when preParsing no longer consumes the
      // original body. Keep the actual disconnected transport; do not inject
      // an abort signal. Node asserts its native raw abort below.
      await new Promise((resolve) => setTimeout(resolve, 40));
    } else await until(() => aborted);
    // Give any erroneous aborted-body retirement its normal event-loop turn.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handlerEntered, false);
    assert.equal(
      (await maintenance.activity()).busy,
      true,
      "replacement/parser still owns future mutation after raw abort"
    );
    const beforePayload = await maintenance.fence({
      transactionId: "raw-abort",
    });
    assert.deepEqual(beforePayload, {
      ok: false,
      status: 409,
      code: "DRAIN_TIMEOUT",
    });
    assert.equal(stops, 0);
    assert.equal(finishes, 0);
    events.push("fence-blocked-before-payload");
    replacement.end("{}");
    parsed.resolve();
    await until(() => handlerEntered);
    assert.equal((await maintenance.activity()).busy, true);
    assert.deepEqual(await maintenance.fence({ transactionId: "handler" }), {
      ok: false,
      status: 409,
      code: "DRAIN_TIMEOUT",
    });
    assert.equal(stops, 0);
    mutation.resolve();
    await until(async () => !(await maintenance.activity()).busy);
    assert.equal(mutations, 1);
    assert.equal(finishes, 1);
    assert.deepEqual(await maintenance.fence({ transactionId: "settled" }), {
      ok: true,
    });
    assert.equal(stops, 1);
    return {
      scenario: `parser-ownership:${kind}`,
      events,
      beforePayload,
      rawAbortObserved: aborted,
      mutations,
      finishes,
      stops,
    };
  } catch (error) {
    console.error({
      kind,
      events,
      aborted: request?.raw.aborted,
      replySent: replySnapshot?.sent,
      rawEnded: replySnapshot?.raw.writableEnded,
      rawFinished: replySnapshot?.raw.finished,
      socketDestroyed: request?.raw.socket?.destroyed,
    });
    throw error;
  } finally {
    if (!replacement.writableEnded) replacement.end("{}");
    parsed.resolve();
    mutation.resolve();
    socket?.destroy();
    await app.close();
    replacement.destroy();
  }
}
