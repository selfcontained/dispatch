/*
 * The local socket transport on real Unix sockets in temp directories: the
 * runner's socket server in this process, the app's connection and session
 * from runner-client.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  pathFromWire,
  runnerIdFromWire,
  sessionFromWire,
  RunnerCallError,
  type RunnerDescription,
} from "@dispatch/runner-protocol/contract";
import {
  LocalSocketConnection,
  channelStreams,
} from "@dispatch/runner-client/transport/local-socket";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import { serveSocket, type Handlers } from "../src/local/socket-server.js";

const description: RunnerDescription = {
  runnerId: runnerIdFromWire("local"),
  displayName: "Local",
  build: { version: "0.0.0-test" },
  protocol: 1,
  engines: [],
  capabilities: {},
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanups.splice(0).reverse()) run();
});

async function serve(handlers: Handlers) {
  const dir = mkdtempSync(join(tmpdir(), "local-transport-"));
  const socket = join(dir, "r.sock");
  const nonce = "nonce-" + randomBytes(8).toString("hex");
  const server = await serveSocket(socket, nonce, handlers);
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, endpoint: { socket, nonce }, server };
}

async function connect(endpoint: { socket: string; nonce: string }) {
  const connection = await LocalSocketConnection.connect(endpoint);
  cleanups.push(() => connection.close());
  return connection;
}

/** A sink that hashes what it is given, slowly when asked. */
function hashingSink(delayMs = 0) {
  const hash = createHash("sha256");
  let bytes = 0;
  let digest: string | undefined;
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      if (delayMs) setTimeout(callback, delayMs);
      else callback();
    },
  });
  return {
    sink,
    digest: () => (digest ??= hash.digest("hex")),
    bytes: () => bytes,
  };
}

const blobHandlers = (sinks: Map<string, ReturnType<typeof hashingSink>>) =>
  ({
    calls: {
      "runner.describe": () => description,
      "files.put": async (input, context) => {
        const target = hashingSink(input.size > 1 << 20 ? 1 : 0);
        sinks.set(input.name, target);
        await context.receiveBlob(input.blob, target.sink);
        if (target.digest() !== input.digest)
          throw new RunnerCallError({ code: "failed", message: "digest" });
        return { path: pathFromWire(`/files/${input.name}`) };
      },
    },
  }) satisfies Handlers;

describe("local socket transport", () => {
  it("refuses a connection that presents the wrong nonce, accepts the spawn's", async () => {
    const { endpoint } = await serve({
      calls: { "runner.describe": () => description },
    });
    const wrong = await LocalSocketConnection.connect({
      ...endpoint,
      nonce: "not-the-nonce",
    }).catch((error: unknown) => error);
    expect(wrong).toBeInstanceOf(RunnerCallError);
    expect((wrong as RunnerCallError).code).toBe("unavailable");

    const connection = await connect(endpoint);
    await expect(connection.call("runner.describe", {})).resolves.toMatchObject(
      { displayName: "Local" }
    );
    await expect(connection.call("runner.health", {})).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("carries two concurrent channels on one connection, each closing alone", async () => {
    // The runner's end of an attach: answers each hello with a welcome
    // naming the session, then streams events until the caller leaves.
    const opened: string[] = [];
    const { endpoint } = await serve({
      calls: {},
      opens: {
        "session.attach": async (input) => {
          const session = String(input.session);
          opened.push(session);
          const fromRunner = new PassThrough();
          const toRunner = new Writable({
            write(chunk: Buffer, _encoding, callback) {
              for (const line of chunk.toString().split("\n").filter(Boolean)) {
                const message = JSON.parse(line) as {
                  type: string;
                  fromSeq?: number;
                };
                if (message.type === "hello")
                  fromRunner.write(
                    JSON.stringify({
                      type: "welcome",
                      engine: session,
                      sessionId: session,
                      resumed: false,
                      running: true,
                      journalSeq: 3,
                    }) +
                      "\n" +
                      [1, 2, 3]
                        .map(
                          (seq) =>
                            JSON.stringify({
                              type: "event",
                              seq,
                              at: "t",
                              event: { type: "update", update: { session } },
                            }) + "\n"
                        )
                        .join("")
                  );
              }
              callback();
            },
          });
          const channel = Duplex.from({
            readable: fromRunner,
            writable: toRunner,
          });
          return { info: {}, channel };
        },
      },
    });
    const session = new LocalRunnerSession({ description });
    cleanups.push(() => session.close());
    session.setEndpoint(endpoint);

    const attach = async (name: string) => {
      const { channel } = await session.open(
        "session.attach",
        { session: sessionFromWire(name) },
        { wait: true }
      );
      const messages: unknown[] = [];
      channel.onData((message) => messages.push(message));
      return { channel, messages };
    };
    const [a, b] = await Promise.all([attach("a"), attach("b")]);
    a.channel.write({ type: "hello", fromSeq: 0 });
    b.channel.write({ type: "hello", fromSeq: 0 });
    await until(() => a.messages.length === 4 && b.messages.length === 4).catch(
      (e) => {
        console.log(JSON.stringify({ a: a.messages, b: b.messages }));
        throw e;
      }
    );
    expect(a.messages[0]).toMatchObject({ type: "welcome", sessionId: "a" });
    expect(b.messages[0]).toMatchObject({ type: "welcome", sessionId: "b" });
    expect(
      a.messages
        .slice(1)
        .every(
          (m) =>
            (m as { event: { update: { session: string } } }).event.update
              .session === "a"
        )
    ).toBe(true);
    expect(session.connection.epoch).toBe(1); // One connection for both.

    const closed = new Promise<void>((resolve) =>
      a.channel.onClose(() => resolve())
    );
    a.channel.close();
    await closed;
    b.channel.write({ type: "hello", fromSeq: 3 });
    await until(() => b.messages.length === 8);
    expect(opened.sort()).toEqual(["a", "b"]);
  });

  it("refuses a channel message that does not match the operation's schema", async () => {
    const { endpoint } = await serve({
      calls: {},
      opens: {
        "session.attach": async () => {
          const fromRunner = new PassThrough();
          fromRunner.write('{"type":"not-a-host-message"}\n');
          return {
            info: {},
            channel: Duplex.from({
              readable: fromRunner,
              writable: new PassThrough(),
            }),
          };
        },
      },
    });
    const session = new LocalRunnerSession({ description });
    cleanups.push(() => session.close());
    session.setEndpoint(endpoint);
    const { channel } = await session.open(
      "session.attach",
      { session: sessionFromWire("x") },
      { wait: true }
    );
    const error = await new Promise((resolve) => channel.onClose(resolve));
    expect(error).toMatchObject({ code: "invalid" });
  });

  it("streams a blob with credit flow control into a slow reader", async () => {
    const sinks = new Map<string, ReturnType<typeof hashingSink>>();
    const { endpoint } = await serve(blobHandlers(sinks));
    const connection = await connect(endpoint);
    const data = randomBytes(3 * 1024 * 1024 + 17);
    const digest = createHash("sha256").update(data).digest("hex");
    const began = Date.now();
    const put = connection.call("files.put", {
      session: sessionFromWire("s"),
      name: "big.bin",
      size: data.length,
      digest,
      blob: "blob-1",
    });
    const sent = connection.sendBlob("blob-1", Readable.from([data]));
    // Meanwhile the same connection keeps answering calls.
    await expect(connection.call("runner.describe", {})).resolves.toMatchObject(
      {
        displayName: "Local",
      }
    );
    await sent;
    await expect(put).resolves.toEqual({ path: "/files/big.bin" });
    expect(sinks.get("big.bin")!.bytes()).toBe(data.length);
    console.info(`3 MiB flow-controlled blob: ${Date.now() - began} ms`);
  });

  it("accepts a blob as the path of an existing file and reports missing or invalid paths", async () => {
    const sinks = new Map<string, ReturnType<typeof hashingSink>>();
    const { dir, endpoint } = await serve(blobHandlers(sinks));
    const file = join(dir, "attachment.png");
    const data = randomBytes(200_000);
    writeFileSync(file, data);
    const digest = createHash("sha256").update(data).digest("hex");
    const connection = await connect(endpoint);
    const put = (name: string, blob: string) =>
      connection.call("files.put", {
        session: sessionFromWire("s"),
        name,
        size: data.length,
        digest,
        blob,
      });

    const ok = put("a.png", "blob-a");
    await connection.sendBlob("blob-a", { path: file });
    await expect(ok).resolves.toEqual({ path: "/files/a.png" });
    expect(sinks.get("a.png")!.digest()).toBe(digest);

    const missing = put("b.png", "blob-b");
    await expect(
      connection.sendBlob("blob-b", { path: join(dir, "nope.png") })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(missing).rejects.toMatchObject({ code: "not_found" });

    const relative = put("c.png", "blob-c");
    await expect(
      connection.sendBlob("blob-c", { path: "attachment.png" })
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(relative).rejects.toMatchObject({ code: "invalid" });

    const directory = put("d.png", "blob-d");
    await expect(
      connection.sendBlob("blob-d", { path: dir })
    ).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(directory).rejects.toMatchObject({ code: "invalid" });

    // A path for a blob nobody expects is refused, and nothing is read.
    await expect(
      connection.sendBlob("unexpected", { path: file })
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("keeps channel stream IDs apart from caller blob IDs", () => {
    expect(channelStreams(7)).toEqual({
      in: "channel:7:in",
      out: "channel:7:out",
    });
  });
});

async function until(condition: () => boolean, ms = 3_000) {
  const began = Date.now();
  while (!condition()) {
    if (Date.now() - began > ms) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
