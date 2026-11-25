import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseReadyFrame,
  parseServiceFrame,
  RUNNER_WIRE_VERSION,
  type RunnerFrame,
  type ServiceFrame,
} from "@dispatch/runner-protocol";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import { describe, expect, it } from "vitest";
import {
  receiveCheckoutRead,
  receiveFile,
  sendFile,
  RunnerConnection,
} from "../src/v1/connection.js";
import { wireFrames, FlowStreams, acceptsStreams } from "../src/v1/node.js";
import {
  STREAM_CHUNK,
  STREAM_WINDOW,
  type StreamFrame,
} from "../src/v1/streams.js";

async function loopback(advertise = true, stallMs?: number, file?: Buffer) {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP address");
  const incoming = once(server, "connection");
  const clientSocket = connect(address.port, "127.0.0.1");
  const [runnerSocket] = (await incoming) as [Socket];
  clientSocket.setNoDelay(true);
  runnerSocket.setNoDelay(true);
  const received: unknown[] = [];
  const attach = {
    kind: "attach",
    agentId: "other-session",
    workspace: "test",
  } as const;
  let ready!: () => void;
  const handshake = new Promise<void>((resolve) => {
    ready = resolve;
  });

  const send = wireFrames<
    RunnerFrame | StreamFrame,
    ServiceFrame | StreamFrame
  >(clientSocket, (frame) => {
    if (client.handle(frame)) return;
    if (frame.type === "ready") {
      if (parseReadyFrame(frame)?.streamCredit) {
        send({ type: "stream", action: "accept" });
        client.enable();
      } else ready();
    } else if (
      frame.type === "result" ||
      frame.type === "data" ||
      frame.type === "close"
    ) {
      connection.receive(frame);
    }
  });
  const client = new FlowStreams(clientSocket, send, stallMs);
  const connection = new RunnerConnection(send);
  clientSocket.once("close", () => connection.close());
  const reply = wireFrames<unknown, RunnerFrame | StreamFrame>(
    runnerSocket,
    (value) => {
      if (acceptsStreams(value)) {
        runner.enable();
        ready();
        return;
      }
      if (runner.handle(value)) return;
      received.push(value);
      const frame = parseServiceFrame(value);
      if (
        frame?.type === "request" &&
        frame.command.kind === "checkoutRead" &&
        file
      ) {
        void runner
          .send(frame.command.operation.streamId, Readable.from([file]))
          .then(
            () => reply({ type: "result", id: frame.id, value: true }),
            () =>
              reply({
                type: "result",
                id: frame.id,
                error: "Checkout stream ended.",
              })
          );
      }
      if (frame?.type === "request" && frame.command.kind === "attach")
        reply({ type: "result", id: frame.id, value: true });
      if (
        frame?.type === "request" &&
        frame.command.kind === "sessionFile" &&
        frame.command.operation.kind === "collect" &&
        file
      ) {
        const { streamId } = frame.command.operation;
        if (streamId) {
          const chunks = function* () {
            for (let offset = 0; offset < file.length; offset += STREAM_CHUNK)
              yield file.subarray(offset, offset + STREAM_CHUNK);
          };
          void runner.send(streamId, Readable.from(chunks())).then(
            () => reply({ type: "result", id: frame.id, value: true }),
            () =>
              reply({
                type: "result",
                id: frame.id,
                error: "File transfer failed.",
              })
          );
        } else {
          reply({
            type: "result",
            id: frame.id,
            value: file.toString("base64"),
          });
        }
      }
      if (
        frame?.type === "request" &&
        frame.command.kind === "sessionFile" &&
        frame.command.operation.kind === "deliver"
      ) {
        const { operation } = frame.command;
        const done = (bytes: Buffer) => {
          delivered.push(bytes);
          reply({
            type: "result",
            id: frame.id,
            value: `/files/${operation.name}`,
          });
        };
        if (operation.streamId === undefined)
          done(Buffer.from(operation.data, "base64"));
        else {
          // Registered on the request frame, before the stream opens.
          const chunks: Buffer[] = [];
          void runner
            .receive(
              operation.streamId,
              new Writable({
                write(chunk: Buffer, _encoding, callback) {
                  chunks.push(chunk);
                  callback();
                },
              })
            )
            .then(() => done(Buffer.concat(chunks)));
        }
      }
      if (frame?.type === "data") reply(frame);
    }
  );
  const delivered: Buffer[] = [];
  const runner = new FlowStreams(runnerSocket, reply, stallMs);
  reply({
    type: "ready",
    version: RUNNER_WIRE_VERSION,
    workspaces: [],
    ...(advertise && { streamCredit: true }),
  });
  await handshake;
  return {
    client,
    runner,
    connection,
    received,
    delivered,
    attach,
    clientSocket,
    runnerSocket,
    reply,
    async close() {
      clientSocket.destroy();
      runnerSocket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("v1 credit streams", () => {
  it("receives a checkout reply above the legacy frame limit alongside another session", async () => {
    const data = "¥".repeat(9 * 1024 * 1024);
    const link = await loopback(
      true,
      undefined,
      Buffer.from(JSON.stringify({ data: { data } }))
    );
    try {
      const read = receiveCheckoutRead(
        "checkout.read",
        {
          target: { session: sessionFromWire("reader") },
          path: "large.txt",
          encoding: "utf8",
          maxBytes: null,
        },
        "test",
        (command, signal) => link.connection.request(command, { signal }),
        link.client
      );
      await expect(link.connection.request(link.attach)).resolves.toMatchObject(
        { value: true }
      );
      const result = await read;
      expect(result?.data === data).toBe(true);
      const frame = parseServiceFrame(link.received[0]);
      expect(frame).toMatchObject({
        type: "request",
        command: { kind: "checkoutRead" },
      });
      if (frame?.type !== "request" || frame.command.kind !== "checkoutRead")
        throw new Error("Missing checkout stream");
      expect(
        JSON.stringify({
          ...frame.command,
          operation: { ...frame.command.operation, streamId: "stream" },
        })
      ).toBe(
        '{"kind":"checkoutRead","workspace":"test","agentId":"reader","operation":{"op":"checkout.read","request":{"path":"large.txt","encoding":"utf8","maxBytes":null},"streamId":"stream"}}'
      );
      expect(link.client.has(frame.command.operation.streamId)).toBe(false);
      expect(link.runner.has(frame.command.operation.streamId)).toBe(false);
    } finally {
      await link.close();
    }
  });

  it.each([
    ["current", "utf8"],
    ["launch", "utf8"],
    ["current", "base64"],
    ["launch", "base64"],
  ] as const)(
    "streams unlimited %s %s checkout reads",
    async (checkout, encoding) => {
      const bytes = Buffer.alloc(5 * 1024 * 1024, 0xff);
      bytes.set([0, 128, 239, 127]);
      const data =
        encoding === "base64"
          ? bytes.toString("base64")
          : "¥".repeat(3 * 1024 * 1024);
      const link = await loopback(
        true,
        undefined,
        Buffer.from(JSON.stringify({ data: { data } }))
      );
      try {
        const result = await receiveCheckoutRead(
          "checkout.read",
          {
            target: { session: sessionFromWire("reader"), checkout },
            path: "payload",
            encoding,
            maxBytes: null,
          },
          "test",
          (command, signal) => link.connection.request(command, { signal }),
          link.client
        );
        expect(result?.data === data).toBe(true);
        if (encoding === "base64")
          expect(Buffer.from(result!.data, "base64").equals(bytes)).toBe(true);
        const frame = parseServiceFrame(link.received[0]);
        if (frame?.type !== "request" || frame.command.kind !== "checkoutRead")
          throw new Error("Missing checkout read frame");
        if (checkout === "launch")
          expect(frame.command.operation.checkout).toBe("launch");
        else expect(frame.command.operation).not.toHaveProperty("checkout");
        expect(frame.command.operation.request).toEqual({
          path: "payload",
          encoding,
          maxBytes: null,
        });
      } finally {
        await link.close();
      }
    }
  );

  it("round-trips old and selected read frames and rejects unknown selectors", () => {
    const operation = {
      op: "checkout.read",
      request: { path: "file", encoding: "base64", maxBytes: null },
      streamId: "stream_1",
    };
    const frame = {
      type: "request",
      id: "read_1",
      command: {
        kind: "checkoutRead",
        workspace: "test",
        agentId: "reader",
        operation,
      },
    };
    for (const checkout of [undefined, "current", "launch"] as const) {
      const input = {
        ...frame,
        command: {
          ...frame.command,
          operation: { ...operation, ...(checkout && { checkout }) },
        },
      };
      const parsed = parseServiceFrame(JSON.parse(JSON.stringify(input)));
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(input));
    }
    for (const checkout of ["moved", "unknown", null, 1])
      expect(
        parseServiceFrame({
          ...frame,
          command: { ...frame.command, operation: { ...operation, checkout } },
        })
      ).toBeNull();
  });

  it.each([true, false])(
    "reads attachments and preserves the old request shape without streams (%s)",
    async (streamed) => {
      const bytes = streamed
        ? Buffer.alloc(21 * 1024 * 1024, 0xa6)
        : Buffer.from([0, 255, 128]);
      const link = await loopback(streamed, undefined, bytes);
      const command = {
        kind: "sessionFile",
        agentId: "agent",
        workspace: "test",
        operation: { kind: "collect", path: "/tmp/attachment" },
      } as const;
      try {
        const result = await receiveFile(
          command,
          (command, signal) => link.connection.request(command, { signal }),
          streamed ? link.client : undefined
        );
        expect(result.length).toBe(bytes.length);
        expect(result.equals(bytes)).toBe(true);
        const request = streamed
          ? {
              ...command,
              operation: { ...command.operation, streamId: expect.any(String) },
            }
          : command;
        expect(link.received).toEqual([
          { type: "request", id: expect.any(String), command: request },
        ]);
      } finally {
        await link.close();
      }
    }
  );

  it.each([true, false])(
    "puts files and keeps the old inline frame without streams (%s)",
    async (streamed) => {
      const bytes = streamed
        ? Buffer.alloc(21 * 1024 * 1024, 0x5b)
        : Buffer.from([0, 255, 128]);
      const link = await loopback(streamed);
      const target = {
        kind: "sessionFile",
        agentId: "agent",
        workspace: "test",
      } as const;
      try {
        const path = await sendFile(
          target,
          "notes (1).txt",
          {
            size: bytes.length,
            open: () => Readable.from([bytes]),
            read: async () => bytes,
          },
          (command, signal) => link.connection.request(command, { signal }),
          streamed ? link.client : undefined
        );
        expect(path).toBe("/files/notes (1).txt");
        expect(link.delivered).toHaveLength(1);
        expect(link.delivered[0]!.equals(bytes)).toBe(true);
        const operation = streamed
          ? {
              kind: "deliver",
              name: "notes (1).txt",
              streamId: expect.any(String),
              size: bytes.length,
            }
          : {
              kind: "deliver",
              name: "notes (1).txt",
              data: bytes.toString("base64"),
            };
        expect(link.received).toEqual([
          {
            type: "request",
            id: expect.any(String),
            command: { ...target, operation },
          },
        ]);
      } finally {
        await link.close();
      }
    }
  );

  it("streams 100 MiB to a slow sink while another session stays attached", async () => {
    const link = await loopback();
    const total = 100 * 1024 * 1024;
    let produced = 0;
    let drained = 0;
    let maxAhead = 0;
    let maxSink = 0;
    let maxLatency = 0;
    let exchanged = 0;
    let done = false;
    let startRss = process.memoryUsage.rss();
    let peakRss = startRss;
    const source = Readable.from(
      (function* () {
        for (let offset = 0; offset < total; offset += STREAM_CHUNK) {
          const chunk = Buffer.alloc(
            STREAM_CHUNK,
            (offset / STREAM_CHUNK) % 251
          );
          produced += chunk.length;
          maxAhead = Math.max(maxAhead, produced - drained);
          yield chunk;
        }
      })(),
      { objectMode: false, highWaterMark: STREAM_CHUNK }
    );
    const sink = new Writable({
      write(bytes: Buffer, _encoding, callback) {
        maxSink = Math.max(maxSink, sink.writableLength);
        if (
          !bytes.equals(
            Buffer.alloc(bytes.length, (drained / STREAM_CHUNK) % 251)
          )
        )
          return callback(new Error("Unexpected blob bytes"));
        const drain = () => {
          drained += bytes.length;
          callback();
        };
        if ((drained + bytes.length) % STREAM_WINDOW === 0)
          setTimeout(drain, 1);
        else drain();
      },
    });
    try {
      startRss = process.memoryUsage.rss();
      peakRss = startRss;
      const start = performance.now();
      const probe = async () => {
        const { channel } = await link.connection.request(link.attach, {
          openChannel: true,
        });
        if (!channel) throw new Error("Attach did not open");
        do {
          const sentAt = performance.now();
          const response = once(channel, "data", {
            signal: AbortSignal.timeout(750),
          });
          channel.write("hello\n");
          const [echo] = await response;
          if (echo.toString() !== "hello\n")
            throw new Error("Attach data changed");
          maxLatency = Math.max(maxLatency, performance.now() - sentAt);
          peakRss = Math.max(peakRss, process.memoryUsage.rss());
          exchanged++;
          await delay(5);
        } while (!done);
        channel.destroy();
      };
      const transfer = Promise.all([
        link.client.receive("blob", sink),
        link.runner.send("blob", source),
      ]).finally(() => {
        done = true;
      });
      await Promise.all([transfer, probe()]);
      const seconds = (performance.now() - start) / 1000;
      expect(drained).toBe(total);
      expect(exchanged).toBeGreaterThan(5);
      expect(maxLatency).toBeLessThan(750);
      expect(maxSink).toBeLessThanOrEqual(STREAM_WINDOW);
      expect(maxAhead).toBeLessThanOrEqual(STREAM_WINDOW + 3 * STREAM_CHUNK);
      const mib = (bytes: number) => (bytes / 1024 ** 2).toFixed(1);
      console.log(
        `100 MiB in ${seconds.toFixed(2)} s, ${(100 / seconds).toFixed(1)} MiB/s, ` +
          `peak sampled RSS ${mib(peakRss)} MiB (delta ${mib(peakRss - startRss)} MiB), ` +
          `peak sink ${maxSink} bytes, source ahead ${maxAhead} bytes, ` +
          `${exchanged} attach echoes, max RTT ${maxLatency.toFixed(1)} ms`
      );
    } finally {
      await link.close();
    }
  }, 8_000);

  it.each(["cancelled", "timeout"] as const)(
    "bounds a stalled sink and ends both sides with %s while a second blob completes",
    async (code) => {
      const link = await loopback(true, 500);
      const abort = new AbortController();
      let produced = 0;
      const source = Readable.from(
        (function* () {
          while (true) {
            produced += STREAM_CHUNK;
            yield Buffer.alloc(STREAM_CHUNK);
          }
        })(),
        { objectMode: false, highWaterMark: STREAM_CHUNK }
      );
      const sink = new Writable({ write() {} });
      try {
        const firstWrite = new Promise<void>((resolve) => {
          sink._write = () => resolve();
        });
        const stalled = Promise.allSettled([
          link.client.receive("stalled", sink, abort.signal, { stall: false }),
          link.runner.send("stalled", source, undefined, { stall: "blocked" }),
        ]);
        await firstWrite;
        const drained: Buffer[] = [];
        await Promise.all([
          link.client.receive(
            "small",
            new Writable({
              write(chunk: Buffer, _encoding, callback) {
                drained.push(chunk);
                callback();
              },
            })
          ),
          link.runner.send(
            "small",
            Readable.from([Buffer.from("second blob")])
          ),
        ]);
        expect(Buffer.concat(drained).toString()).toBe("second blob");
        if (code === "cancelled") abort.abort();
        for (const result of await stalled)
          expect(result).toMatchObject({
            status: "rejected",
            reason: { code },
          });
        expect(sink.writableLength).toBeLessThanOrEqual(STREAM_WINDOW);
        expect(produced).toBeLessThanOrEqual(STREAM_WINDOW + 3 * STREAM_CHUNK);
        expect(source.destroyed && sink.destroyed).toBe(true);
      } finally {
        await link.close();
      }
    }
  );

  it("allows a silent command until it actually needs credit", async () => {
    const link = await loopback(true, 100);
    const source = new Readable({ read() {} });
    const chunks: Buffer[] = [];
    try {
      const result = Promise.all([
        link.client.receive(
          "idle",
          new Writable({
            write(chunk: Buffer, _encoding, done) {
              chunks.push(chunk);
              done();
            },
          }),
          undefined,
          { stall: false }
        ),
        link.runner.send("idle", source, undefined, { stall: "blocked" }),
      ]);
      await expect(
        Promise.race([result.then(() => "closed"), delay(150, "idle")])
      ).resolves.toBe("idle");
      source.push(Buffer.from("output"));
      source.push(null);
      await result;
      expect(Buffer.concat(chunks).toString()).toBe("output");
    } finally {
      await link.close();
    }
  });

  it("cancels only the stream when a peer sends beyond its granted window", async () => {
    const link = await loopback();
    const sink = new Writable({ write() {} });
    try {
      const received = link.client.receive("over-credit", sink);
      const refused = expect(received).rejects.toMatchObject({
        code: "invalid",
      });
      const id = "over-credit";
      link.reply({ type: "stream", action: "open", id });
      const data = Buffer.alloc(STREAM_CHUNK).toString("base64");
      for (let sent = 0; sent <= STREAM_WINDOW; sent += STREAM_CHUNK)
        link.reply({ type: "stream", action: "chunk", id, data });
      await refused;
      expect(sink.writableLength).toBe(STREAM_WINDOW);
      await expect(link.connection.request(link.attach)).resolves.toMatchObject(
        { value: true }
      );
    } finally {
      await link.close();
    }
  });

  it("uses only legacy frames when the runner does not advertise credit", async () => {
    const link = await loopback(false);
    try {
      await expect(
        link.client.send("disabled", Readable.from([]))
      ).rejects.toMatchObject({ code: "unavailable" });
      await expect(link.connection.request(link.attach)).resolves.toMatchObject(
        { value: true }
      );
      expect(link.received).toEqual([
        {
          type: "request",
          id: expect.any(String),
          command: link.attach,
        },
      ]);
    } finally {
      await link.close();
    }
  });
});

it.each(["checkout.list", "checkout.read"] as const)(
  "round-trips native %s without changing existing frames",
  (op) => {
    const request =
      op === "checkout.list"
        ? { path: ".agents/personas" }
        : { path: ".agents/personas/a.md", encoding: "utf8", maxBytes: null };
    for (const mode of [undefined, "native"] as const) {
      const frame = {
        type: "request",
        id: "native_read",
        command: {
          kind: "checkoutRead",
          workspace: "test",
          agentId: "agent",
          operation: {
            op,
            request: { ...request, ...(mode && { mode }) },
            streamId: "native_stream",
          },
        },
      };
      expect(JSON.stringify(parseServiceFrame(frame))).toBe(
        JSON.stringify(frame)
      );
    }
  }
);
