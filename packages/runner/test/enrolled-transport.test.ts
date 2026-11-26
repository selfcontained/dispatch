import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { CONNECTION_WINDOW } from "@dispatch/runner-client/v1/node";
import type { UpdateStatusFrame } from "@dispatch/runner-protocol";
import { connect, createServer, type Socket } from "node:net";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { LocalSocketConnection } from "@dispatch/runner-client/transport/local-socket";
import {
  RunnerCallError,
  pathFromWire,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import {
  serveOperationSocket,
  type Handlers,
} from "../src/local/socket-server.js";
import { WriteFence } from "../src/local/fence.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

// The transport seam starts after TLS authentication. Each pair has its own
// connection-scoped IDs, exactly as after a runner reconnects.
async function pair(
  handlers: Handlers,
  fence?: WriteFence,
  status?: (frame: UpdateStatusFrame) => void
) {
  const server = createServer();
  cleanup.push(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP port");
  const accepted = once(server, "connection");
  const socket = connect(address.port, "127.0.0.1");
  const [peer] = (await accepted) as [Socket];
  cleanup.push(() => {
    socket.destroy();
    peer.destroy();
  });
  serveOperationSocket(peer, { kind: "enrolled" }, handlers, fence);
  return {
    client: LocalSocketConnection.fromAuthenticatedSocket(socket, status),
    peer,
    socket,
  };
}

const session = sessionFromWire("agt_fixture");

it("carries calls, terminal bytes in both directions and credited blob bytes", async () => {
  const bytes: Buffer[] = [];
  const { client } = await pair({
    calls: {
      "session.alive": () => ({ state: "live" }),
      "files.put": async (input, context) => {
        expect(context.receiveBlobPath).toBeUndefined();
        await context.receiveBlob(
          input.blob,
          new Writable({
            write(chunk: Buffer, _, callback) {
              bytes.push(chunk);
              callback();
            },
          })
        );
        return { path: pathFromWire("/fixture/file") };
      },
    },
    opens: {
      "terminal.open": async () => ({
        info: { cwd: "/fixture", host: "fixture", user: "fixture" },
        channel: new PassThrough(),
      }),
    },
  });
  await expect(client.call("session.alive", { session })).resolves.toEqual({
    state: "live",
  });
  const { channel } = await client.openChannel("terminal.open", {
    target: { session },
    cols: 80,
    rows: 24,
  });
  const received = once(channel, "data");
  channel.write("terminal fixture\n");
  expect(String((await received)[0])).toBe("terminal fixture\n");
  channel.destroy();
  const content = Buffer.alloc(800_000, 97);
  const reply = client.call("files.put", {
    session,
    blob: "b",
    size: content.length,
    name: "fixture",
    digest: "fixture",
  });
  await client.sendBlob("b", Readable.from([content]));
  await expect(reply).resolves.toEqual({ path: "/fixture/file" });
  expect(Buffer.concat(bytes).equals(content)).toBe(true);
});

it("transfers an fs.ReadStream as bytes and closes the sink on a rejected download", async () => {
  const fixture = fileURLToPath(import.meta.url);
  const expected = await readFile(fixture);
  const received: Buffer[] = [];
  const sink = () =>
    new Writable({
      write(chunk, _, done) {
        received.push(Buffer.from(chunk));
        done();
      },
    });
  const { client } = await pair({
    calls: {
      "files.get": async ({ path }, context) => {
        if (path === "missing")
          throw new RunnerCallError({
            code: "not_found",
            message: "Missing file",
          });
        const blob = await context.sendFile!(createReadStream(fixture));
        return {
          name: "fixture",
          blob,
          size: expected.length,
          digest: "fixture",
        };
      },
      "files.put": async ({ blob }, context) => {
        await context.receiveBlob(blob, sink());
        return { path: pathFromWire("/fixture") };
      },
    },
  });
  const metadata = await client.getFile({ session, path: "fixture" }, sink());
  expect(metadata.size).toBe(expected.length);
  expect(Buffer.concat(received)).toEqual(expected);
  received.length = 0;
  const rejectedSink = sink();
  await expect(
    client.getFile({ session, path: "missing" }, rejectedSink)
  ).rejects.toMatchObject({ code: "not_found" });
  expect(rejectedSink.destroyed).toBe(true);
  await Promise.all([
    client.call("files.put", {
      session,
      blob: "upload",
      name: "fixture",
      size: expected.length,
      digest: "fixture",
    }),
    client.sendBlob("upload", createReadStream(fixture)),
  ]);
  expect(Buffer.concat(received)).toEqual(expected);
});

it("closes on a local-only path frame", async () => {
  const { socket } = await pair({ calls: {} });
  const closed = once(socket, "close");
  socket.write(
    JSON.stringify({ type: "blob", id: "b", path: "/fixture" }) + "\n"
  );
  await closed;
});

it("refuses a fenced mutation before the handler", async () => {
  const stop = vi.fn(() => ({}));
  const fence = new WriteFence(true);
  cleanup.push(() => fence.thaw());
  const { client } = await pair({ calls: { "session.stop": stop } }, fence);
  await expect(
    client.call("session.stop", { session, force: false })
  ).rejects.toMatchObject({ code: "fenced" });
  expect(stop).not.toHaveBeenCalled();
});

it.each(["flush", "disconnect"] as const)(
  "holds an admitted write through its reply or %s",
  async (finish) => {
    let flush!: () => void;
    const socket = new Duplex({
      read() {},
      write(_data, _encoding, done) {
        flush = done;
        this.emit("replyPending");
      },
    });
    cleanup.push(() => socket.destroy());
    const fence = new WriteFence();
    cleanup.push(() => fence.thaw());
    let settle!: () => void;
    const pending = new Promise<void>((done) => {
      settle = done;
    });
    const started = vi.fn(async () => {
      await pending;
      return {};
    });
    serveOperationSocket(
      socket,
      { kind: "enrolled" },
      { "session.stop": started },
      fence
    );
    socket.push(
      JSON.stringify({
        id: 1,
        op: "session.stop",
        input: { session, force: true },
      }) + "\n"
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const drained = vi.fn();
    const draining = fence.freeze().then(drained);
    const replyPending = once(socket, "replyPending");
    settle();
    await replyPending;
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    if (finish === "flush") flush();
    else socket.destroy();
    await draining;
    expect(drained).toHaveBeenCalledOnce();
  }
);

it("cancels only the caller's outstanding checkout command", async () => {
  const started = vi.fn();
  const aborted = vi.fn();
  const { client } = await pair({
    calls: {
      "checkout.exec": async ({ argv }, { signal }) => {
        if (!signal)
          throw new Error("Expected an enrolled cancellation signal");
        started(argv);
        await new Promise<void>((done) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted(argv);
              done();
            },
            { once: true }
          )
        );
        return { exitCode: 1, stdout: "", stderr: "" };
      },
      "session.alive": () => ({ state: "live" }),
    },
  });
  const command = (name: string, signal: AbortSignal) =>
    client.call(
      "checkout.exec",
      {
        target: { session },
        guard: { path: "dispatch.json", digest: "fixture" },
        argv: [name],
        env: {},
        timeoutMs: null,
        maxOutput: null,
        shell: "direct",
      },
      { signal }
    );
  const a = new AbortController(),
    b = new AbortController();
  const first = expect(command("first", a.signal)).rejects.toMatchObject({
    code: "cancelled",
  });
  const second = expect(command("second", b.signal)).rejects.toMatchObject({
    code: "unknown_outcome",
  });
  await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2));
  a.abort();
  await first;
  await vi.waitFor(() => expect(aborted.mock.calls).toEqual([[["first"]]]));
  await expect(client.call("session.alive", { session })).resolves.toEqual({
    state: "live",
  });
  client.close();
  await second;
  await vi.waitFor(() =>
    expect(aborted.mock.calls).toEqual([[["first"]], [["second"]]])
  );
});

it("never replays an admitted mutation or an interrupted read on the next connection", async () => {
  let drop!: () => void;
  const stop = vi.fn(() => {
    drop();
    return {};
  });
  const handlers = {
    calls: {
      "session.stop": stop,
      "session.alive": () => new Promise<never>(() => {}),
    },
  };
  const first = await pair(handlers);
  drop = () => first.peer.destroy();
  const read = expect(
    first.client.call("session.alive", { session })
  ).rejects.toMatchObject({ code: "unavailable" });
  const mutation = expect(
    first.client.call("session.stop", { session, force: false })
  ).rejects.toMatchObject({ code: "unknown_outcome" });
  const next = await pair({
    calls: { "session.stop": stop, "session.alive": () => ({ state: "gone" }) },
  });
  await Promise.all([read, mutation]);
  await expect(next.client.call("session.alive", { session })).resolves.toEqual(
    { state: "gone" }
  );
  expect(stop).toHaveBeenCalledTimes(1);
});

it("bounds unacknowledged payload across stalled blobs and resumes every transfer", async () => {
  const sinks: Writable[] = [];
  const release: Array<() => void> = [];
  let stalled = true;
  const { client } = await pair({
    calls: {
      "files.put": async (input, context) => {
        const sink = new Writable({
          write(_chunk, _enc, cb) {
            if (stalled) release.push(cb);
            else cb();
          },
        });
        sinks.push(sink);
        await context.receiveBlob(input.blob, sink);
        return { path: pathFromWire("/fixture") };
      },
    },
  });
  const content = Buffer.alloc(CONNECTION_WINDOW);
  const transfers = Array.from({ length: 8 }, (_, i) => {
    const blob = "blob-" + i;
    const answer = client.call("files.put", {
      session,
      blob,
      size: content.length,
      name: blob,
      digest: "fixture",
    });
    return Promise.all([
      answer,
      client.sendBlob(blob, Readable.from([content])),
    ]);
  });
  const all = Promise.all(transfers);
  await vi.waitFor(() =>
    expect(sinks.reduce((sum, sink) => sum + sink.writableLength, 0)).toBe(
      CONNECTION_WINDOW
    )
  );
  stalled = false;
  for (const proceed of release) proceed();
  await all;
});

it.each([
  { phase: "confirmed" },
  { phase: "rolled_back", reason: "trial_interrupted" },
  { phase: "deferred", reason: "cancelled" },
])("carries $phase on reconnect without issuing a request", async (fields) => {
  const observer = vi.fn();
  const frame = {
    type: "update_status",
    attemptId: "00000000-0000-4000-8000-000000000001",
    ...fields,
    installed: {
      version: "1.0.0",
      revision: "a".repeat(40),
      sha256: "b".repeat(64),
    },
  };
  for (let epoch = 1; epoch <= 2; epoch++) {
    const { peer, client } = await pair({ calls: {} }, undefined, observer);
    const writes = vi.fn();
    peer.on("data", writes);
    peer.write(JSON.stringify(frame) + "\n");
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(epoch));
    expect(observer).toHaveBeenLastCalledWith(frame);
    expect(writes).not.toHaveBeenCalled();
    client.close();
  }
});
