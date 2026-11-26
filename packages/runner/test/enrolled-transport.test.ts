import { enrolledAdmission } from "../src/workload/agents/remote/operation-admission.js";
import { enrolledChannels } from "../src/workload/agents/remote/channel-operations.js";
import { SharedCheckoutWatches } from "../src/workload/agents/checkout-watch.js";
import { enrolledEngineCalls } from "../src/workload/agents/remote/machine-operations.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { enrolledFiles } from "../src/workload/agents/remote/file-operations.js";
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
  sessionToWire,
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
  fence?: Parameters<typeof serveOperationSocket>[3],
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

it("streams a workload checkout reply and preserves its typed failure", async () => {
  const data = "x".repeat(CONNECTION_WINDOW * 2);
  const { client } = await pair({
    calls: {},
    checkoutRead: async (_op, input) => {
      const failed = "path" in input && input.path === "missing";
      return Readable.from([
        Buffer.from(
          JSON.stringify(
            failed
              ? { error: { code: "forbidden", message: "Permission denied" } }
              : { data: { data } }
          )
        ),
      ]);
    },
  });
  const request = {
    target: { session },
    path: "large",
    encoding: "utf8",
    maxBytes: null,
  } as const;
  await expect(client.call("checkout.read", request)).resolves.toEqual({
    data,
  });
  await expect(
    client.call("checkout.read", { ...request, path: "missing" })
  ).rejects.toMatchObject({ code: "forbidden" });
});

it("cancels a waiting enrolled checkout read before its stream opens", async () => {
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const { client } = await pair({
    calls: {},
    checkoutRead: async (_op, _input, signal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      stopped.resolve();
      throw new Error("Cancelled");
    },
  });
  const abort = new AbortController();
  const reading = client.call(
    "checkout.access",
    { target: { session }, path: "file" },
    { signal: abort.signal }
  );
  await started.promise;
  abort.abort();
  await expect(reading).rejects.toMatchObject({ code: "cancelled" });
  await stopped.promise;
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

it("runs bound file operations through the workload and reports byte count and digest", async () => {
  const content = Buffer.alloc(2 * CONNECTION_WINDOW, 0x61);
  const launch = vi.fn(
    (kind: "stream" | "receive", root: string, name: string) => {
      expect(root).toBe("/fixture");
      if (kind === "stream") {
        expect(name).toBe("file.bin");
        return spawn(process.execPath, [
          "-e",
          "process.stdout.write(Buffer.alloc(" + content.length + ", 97))",
        ]);
      }
      expect(name).toBe(content.length + ":file.bin");
      return spawn(process.execPath, [
        "-e",
        "let n=0;process.stdin.on('data',x=>n+=x.length).on('end',()=>{process.exitCode=n===" +
          content.length +
          "?0:1})",
      ]);
    }
  );
  const calls = enrolledFiles(
    {
      async withSessionFile(id, file, run) {
        if (id !== sessionToWire(session))
          throw new RunnerCallError({
            code: "not_found",
            message: "Missing session",
          });
        return run("/fixture", "path" in file ? file.path : file.name);
      },
    },
    launch
  );
  const { client } = await pair({ calls });
  const chunks: Buffer[] = [];
  const sink = () =>
    new Writable({
      write(chunk, _, done) {
        chunks.push(chunk);
        done();
      },
    });
  const digest = createHash("sha256").update(content).digest("hex");
  const got = await client.getFile({ session, path: "file.bin" }, sink());
  expect(got).toMatchObject({ name: "file.bin", size: content.length, digest });
  expect(Buffer.concat(chunks).equals(content)).toBe(true);
  await Promise.all([
    client.call("files.put", {
      session,
      name: "file.bin",
      size: content.length,
      digest,
      blob: "data",
    }),
    client.sendBlob("data", Readable.from([content])),
  ]);
  await expect(
    client.getFile(
      { session: sessionFromWire("other"), path: "file.bin" },
      sink()
    )
  ).rejects.toMatchObject({ code: "not_found" });
  expect(launch).toHaveBeenCalledTimes(2);
});

it("addresses an engine workload operation without a session", async () => {
  const called = vi.fn();
  const { client } = await pair({
    calls: enrolledEngineCalls({
      async callHost(op, request) {
        called(op, request);
        throw new RunnerCallError({
          code: "fenced",
          message: "The runner is updating.",
        });
      },
    }),
  });
  await expect(
    client.call("engine.login.status", { loginId: "fixture" })
  ).rejects.toMatchObject({ code: "fenced" });
  expect(called).toHaveBeenCalledExactlyOnceWith("engine.login.status", {
    loginId: "fixture",
  });
});
it("pins enrolled admission and the original fenced message", async () => {
  const admit = vi.fn(() => null);
  const { client } = await pair(
    {
      calls: {
        "session.alive": () => ({ state: "gone" }),
        "engine.list": () => ({ entries: [] }),
        "session.stop": () => {
          throw new Error("unexpected admission");
        },
      },
    },
    enrolledAdmission({ admit })
  );
  await expect(client.call("session.alive", { session })).resolves.toEqual({
    state: "gone",
  });
  await expect(
    client.call("session.stop", { session, force: true })
  ).rejects.toMatchObject({
    code: "fenced",
    message: enrolledAdmission({ admit }).message,
  });
  await expect(client.call("engine.list", { refresh: false })).resolves.toEqual(
    { entries: [] }
  );
  await expect(
    client.call("engine.list", { refresh: false, background: true })
  ).rejects.toMatchObject({ code: "fenced" });
  expect(admit.mock.calls).toEqual([[20000], [60000]]);
});

it("carries a bound watch pulse and closes its worker after the last subscriber", async () => {
  let changed!: () => void;
  const close = vi.fn();
  const hooks = enrolledChannels(
    { checkoutDirectory: async () => "/fixture" },
    new SharedCheckoutWatches((_cwd, onChange) => {
      changed = onChange;
      return close;
    }),
    { onTerminal: () => () => {} },
    () => {
      throw new Error("unexpected terminal");
    }
  );
  const { client } = await pair({ calls: {}, opens: hooks.opens });
  const { channel } = await client.openChannel("checkout.watch", {
    target: { session },
  });
  const pulse = once(channel, "data");
  changed();
  expect(String((await pulse)[0])).toBe("1");
  channel.destroy();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("delivers terminal readiness, controls and the protected update close reason", async () => {
  let fence!: () => void;
  const unsubscribe = vi.fn();
  const hooks = enrolledChannels(
    { checkoutDirectory: async () => "/fixture" },
    new SharedCheckoutWatches(() => () => {}),
    {
      onTerminal(close) {
        fence = close;
        return unsubscribe;
      },
    },
    () =>
      spawn(process.execPath, [
        "-e",
        `
    const fs = require("fs");
    fs.writeSync(2, JSON.stringify({cwd:"/fixture",host:"fixture",user:"workload"}));
    fs.closeSync(2);
    process.stdin.pipe(process.stdout);
  `,
      ])
  );
  const { client } = await pair({ calls: {}, opens: hooks.opens });
  const { info, channel } = await client.openChannel("terminal.open", {
    target: { session },
    cols: 80,
    rows: 24,
  });
  expect(info).toMatchObject({ cwd: "/fixture", user: "workload" });
  const echo = once(channel, "data");
  channel.write('{"type":"input","data":"fixture"}\n');
  expect(String((await echo)[0])).toContain("fixture");
  const reason = once(channel, "data");
  fence();
  expect(JSON.parse(String((await reason)[0]))).toMatchObject({
    type: "error",
    reason: "update",
  });
  channel.destroy();
  await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
});

it("keeps the enrolled frame budget for large launch prompts", async () => {
  const systemText = "a".repeat(2 * 1024 * 1024);
  const { client } = await pair({
    calls: {
      "session.launch": (request) => {
        expect(request.systemText).toBe(systemText);
        return {};
      },
    },
  });
  await expect(
    client.call("session.launch", {
      session,
      launchId: "00000000-0000-4000-8000-000000000001",
      engine: "codex",
      model: null,
      effort: null,
      access: "default",
      resume: null,
      systemText,
      firstText: null,
      overflowNotice: null,
      env: {},
      mcp: [],
      owner: null,
    })
  ).resolves.toEqual({});
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

it("reassembles separately credited command outputs across frame boundaries", async () => {
  const text = "a".repeat(2 * CONNECTION_WINDOW);
  const { client } = await pair({
    calls: {
      "checkout.exec": async (_, context) => {
        await Promise.all([
          context.sendOutput!(
            "stdout",
            Readable.from([Buffer.from(text), Buffer.from("\n")]),
            context.signal!
          ),
          context.sendOutput!(
            "stderr",
            Readable.from([Buffer.from(" diagnostic \n")]),
            context.signal!
          ),
        ]);
        return { exitCode: 3, stdout: "", stderr: "" };
      },
    },
  });
  const result = await client.call("checkout.exec", {
    target: { session },
    guard: { path: "dispatch.json", digest: "fixture" },
    argv: ["fixture"],
    env: {},
    timeoutMs: null,
    maxOutput: null,
    shell: "direct",
  });
  expect(result).toEqual({ exitCode: 3, stdout: text, stderr: "diagnostic" });
});

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

it("resolves enrolled checkout operations from the session binding and workload workers", async () => {
  const { enrolledCheckouts } =
    await import("../src/workload/agents/remote/checkout-operations.js");
  const run = vi.fn(async (op: string) =>
    JSON.stringify({
      data:
        op === "write"
          ? { digest: "written" }
          : { repositoryRoot: "/held", checkoutRoot: "/held" },
    })
  );
  const read = vi.fn(() =>
    Readable.from([Buffer.from(JSON.stringify({ data: true }))])
  );
  const manifest = vi.fn(async () =>
    JSON.stringify({ content: "tools", state: "f".repeat(64) })
  );
  const absent = sessionFromWire("absent");
  const checked = async (id: string) => {
    if (id === sessionToWire(absent))
      throw new RunnerCallError({
        code: "not_found",
        message: "Missing session.",
      });
    expect(id).toBe(session);
    return "/held";
  };
  const { client } = await pair(
    enrolledCheckouts(
      {
        checkoutDirectory: checked,
        withCommandCheckout: async (
          id,
          _checkout,

          _signal,
          work
        ) => work(await checked(id)),
      },
      { run, read, manifest },
      new AbortController().signal
    )
  );
  const target = { session };
  await expect(client.call("git.roots", { target })).resolves.toEqual({
    repositoryRoot: "/held",
    checkoutRoot: "/held",
  });
  await expect(
    client.call("checkout.write", {
      target,
      path: "f",
      data: "new",
      expectedDigest: null,
    })
  ).resolves.toEqual({ digest: "written" });
  expect(run.mock.calls.map((args) => args.slice(0, 2))).toEqual([
    ["git.roots", "/held"],
    ["write", "/held"],
  ]);
  await expect(
    client.call("checkout.access", { target, path: "f" })
  ).resolves.toBe(true);
  expect(read).toHaveBeenCalledWith(
    "/held",
    { op: "checkout.access", checkout: "current", request: { path: "f" } },
    expect.any(AbortSignal)
  );
  const input = {
    target,
    path: "f",
    mode: "command-manifest",
    encoding: "utf8",
    maxBytes: null,
  } as const;
  await expect(client.call("checkout.read", input)).resolves.toEqual({
    data: "tools",
    digest: "f".repeat(64),
  });
  await expect(
    client.call("checkout.read", { ...input, maxBytes: 4 })
  ).rejects.toMatchObject({ code: "too_large" });
  await expect(
    client.call("checkout.read", { ...input, target: { session: absent } })
  ).rejects.toMatchObject({ code: "not_found" });
  expect(manifest).toHaveBeenCalledTimes(2);
  const deadlines = vi.spyOn(AbortSignal, "timeout");
  try {
    for (const [checkout, timeout] of [
      ["current", 300000],
      ["launch", 15000],
      ["moved", 15000],
    ] as const) {
      deadlines.mockClear();
      await client.call("checkout.read", {
        ...input,
        target: { session, checkout },
      });
      expect(deadlines).toHaveBeenCalledWith(timeout);
    }
  } finally {
    deadlines.mockRestore();
  }
});

it("holds the command checkout while credited output is sent and aborts a timed-out child", async () => {
  const { enrolledCommand } =
    await import("../src/workload/agents/remote/checkout-operations.js");
  const execute = vi.fn<Parameters<typeof enrolledCommand>[1]>(
    async (cwd, id, input, send, signal) => {
      expect(cwd).toBe("/held");
      expect(id).toBe(sessionToWire(session));
      if (input.argv[0] === "wait") {
        await new Promise<void>((done) =>
          signal.addEventListener("abort", () => done(), { once: true })
        );
        signal.throwIfAborted();
      }
      await Promise.all([
        send("stdout", Readable.from([Buffer.from("program output")]), signal),
        send("stderr", Readable.from([]), signal),
      ]);
      return { exitCode: 0, truncated: false };
    }
  );
  const command = enrolledCommand(
    {
      checkoutDirectory: async () => "/held",
      withCommandCheckout: async (
        _id,
        selector,

        _signal,
        work
      ) => (selector === "moved" ? null : work("/held")),
    },
    execute
  );
  const { client } = await pair({ calls: { "checkout.exec": command } });
  const run = {
    target: { session },
    guard: { path: "manifest", digest: "a".repeat(64) },
    argv: ["program"],
    env: {},
    timeoutMs: null,
    maxOutput: null,
    shell: "direct",
  } as const;
  const input = { ...run, argv: ["program"] };
  await expect(client.call("checkout.exec", input)).resolves.toEqual({
    exitCode: 0,
    stdout: "program output",
    stderr: "",
  });
  await expect(
    client.call("checkout.exec", {
      ...input,
      target: { session, checkout: "moved" },
    })
  ).rejects.toMatchObject({ code: "stale" });
  await expect(
    client.call("checkout.exec", { ...input, argv: ["wait"], timeoutMs: 30 })
  ).rejects.toMatchObject({ code: "timeout" });
  expect(execute).toHaveBeenCalledTimes(2);
});

it("runs each guard in its bound checkout and refuses stale or fenced commands before spawning", async () => {
  const { mkdtemp, realpath, rm, stat, writeFile, symlink } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { text } = await import("node:stream/consumers");
  const { enrolledCheckouts, enrolledCommand } =
    await import("../src/workload/agents/remote/checkout-operations.js");
  const { streamCommandOutput } =
    await import("../src/workload/agents/remote/runner.js");
  const base = await mkdtemp(join(tmpdir(), "enrolled-guard-"));
  const bound = join(base, "binding");
  const actual = await realpath(base);
  const manifest = "manifest.json";
  const commandModule = new URL(
    "../src/workload/agents/remote/checkout-command.ts",
    import.meta.url
  ).href;
  const readModule = new URL(
    "../src/workload/agents/checkout-worker.ts",
    import.meta.url
  ).href;
  const commandEntry = `import {runCheckoutCommandCli} from ${JSON.stringify(commandModule)}; await runCheckoutCommandCli(process.argv[1], process.argv[2]);`;
  const readEntry = `import {runCheckoutWorker} from ${JSON.stringify(readModule)}; await runCheckoutWorker(["read",process.argv[1]], {});`;
  const supervisor: Parameters<typeof enrolledCommand>[0] = {
    checkoutDirectory: async () => bound,
    withCommandCheckout: async (_id, _selector, _signal, work) => work(bound),
  };
  const worker = (
    entry: string,
    args: string[],
    input: unknown,
    signal: AbortSignal
  ) => {
    const child = spawn("bun", ["-e", entry, ...args], { signal });
    child.stdin.end(JSON.stringify(input));
    return child.stdout;
  };
  try {
    await symlink(actual, bound);
    await writeFile(join(actual, manifest), "first");
    const reads = enrolledCheckouts(
      supervisor,
      {
        run: async () => {
          throw new Error("Unexpected query");
        },
        read: (cwd, input, signal) => worker(readEntry, [cwd], input, signal),
        manifest: (cwd, id, input, signal) =>
          text(worker(commandEntry, [cwd, id], input, signal)),
      },
      new AbortController().signal
    );
    const execute = vi.fn<Parameters<typeof enrolledCommand>[1]>(
      (cwd, id, input, send, signal) =>
        streamCommandOutput(
          ["bun", "-e", commandEntry, cwd, id],
          process.env,
          JSON.stringify(input),
          input.maxOutput,
          send,
          signal
        )
    );
    const fence = new WriteFence();
    cleanup.push(() => fence.thaw());
    const { client } = await pair(
      {
        ...reads,
        calls: {
          ...reads.calls,
          "checkout.exec": enrolledCommand(supervisor, execute),
        },
      },
      fence
    );
    const target = { session, checkout: "launch" } as const;
    const read = {
      target,
      path: manifest,
      encoding: "utf8",
      maxBytes: null,
    } as const;
    const file = await client.call("checkout.read", {
      ...read,
      mode: "native",
      bindRoot: true,
    });
    const info = await stat(actual, { bigint: true });
    expect(file).toMatchObject({
      data: "first",
      root: pathFromWire(bound),
      rootIdentity: `${info.dev}:${info.ino}`,
    });
    const guarded = await client.call("checkout.read", {
      ...read,
      mode: "command-manifest",
    });
    const baseCall = {
      target,
      argv: [
        process.execPath,
        "-e",
        "require('fs').appendFileSync('executions', 'x'); process.stdout.write(process.cwd())",
      ],
      env: {},
      timeoutMs: null,
      maxOutput: null,
      shell: "direct",
    } as const;
    const run = (
      boundGuard:
        | { guard: { root: ReturnType<typeof pathFromWire>; identity: string } }
        | { guard: { path: string; digest: string } }
    ) =>
      client.call("checkout.exec", {
        ...baseCall,
        argv: [...baseCall.argv],
        ...boundGuard,
      });
    const digest = { path: manifest, digest: guarded!.digest! };
    const root = { root: file!.root!, identity: file!.rootIdentity! };
    await expect(run({ guard: digest })).resolves.toMatchObject({
      stdout: actual,
    });
    await writeFile(join(actual, manifest), "edited");
    await expect(run({ guard: digest })).rejects.toMatchObject({
      code: "stale",
    });
    await expect(run({ guard: root })).resolves.toMatchObject({
      stdout: actual,
    });
    await expect(
      run({ guard: { ...root, root: pathFromWire(actual) } })
    ).rejects.toMatchObject({ code: "stale" });
    await expect(
      run({ guard: { ...root, identity: "wrong" } })
    ).rejects.toMatchObject({
      code: "stale",
    });
    await fence.freeze();
    await expect(
      run({ guard: { ...root, identity: "wrong" } })
    ).rejects.toMatchObject({
      code: "fenced",
    });
    expect(execute).toHaveBeenCalledTimes(5);
    expect(await readFile(join(actual, "executions"), "utf8")).toBe("xx");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 20_000);
