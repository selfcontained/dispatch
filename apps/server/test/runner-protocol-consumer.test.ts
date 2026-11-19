import { Duplex } from "node:stream";
import {
  type Frame,
  type ServiceFrame,
  type Command,
  parseReadyFrame,
  isOpaqueId,
  remotePlacement,
  workspaceLocator,
} from "@dispatch/runner-protocol";
import { hostChannel, wireFrames } from "@dispatch/runner-protocol/node";
import {
  RunnerConnection,
  RunnerHostGone,
  RunnerUnavailable,
} from "@dispatch/runner-protocol/connection";
import { expect, it, vi } from "vitest";

it("round-trips opaque locator components without URL normalization", () => {
  const placement = { runner: "Runner/β", workspace: "../repo?x=%2F#main" };
  const locator = workspaceLocator(placement);
  expect(locator).toBe("runner://Runner%2F%CE%B2/..%2Frepo%3Fx%3D%252F%23main");
  expect(remotePlacement(locator)).toEqual(placement);
  expect(remotePlacement("runner://lima/proof")).toEqual({
    runner: "lima",
    workspace: "proof",
  });
  for (const invalid of [
    "runner://lima/",
    "runner://lima/raw/slash",
    "runner://lima/raw?query",
    "runner://lima/%FF",
    "runner://lima/%00",
    "runner://lima/proof\n",
  ]) {
    expect(remotePlacement(invalid)).toBeNull();
  }
  expect(isOpaqueId("provider/act:42")).toBe(true);
  expect(isOpaqueId("a".repeat(129))).toBe(false);
  expect(isOpaqueId("\ud800")).toBe(false);
});

it("consumes the v1 launch and channel framing without Dispatch server imports", async () => {
  const received: Frame[] = [];
  // Feed each write to the decoder a byte at a time, including split UTF-8.
  const transport = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      for (const byte of chunk) transport.emit("data", Buffer.from([byte]));
      done();
    },
  });
  const send = wireFrames(transport, (frame) => received.push(frame));
  const launch: Frame = {
    type: "request",
    id: "provider:launch/42",
    command: {
      kind: "launch",
      agentId: "provider:agent/42",
      workspace: "workspace:β",
      launch: {
        agentId: "provider:agent/42",
        engine: "codex",
        model: null,
        systemPrompt: null,
        resumeSessionId: null,
      },
    },
  };
  send(launch);
  const channel = hostChannel("provider:attach/42", send, () => {});
  await new Promise<void>((resolve, reject) => {
    channel.write(Buffer.from([0, 255]), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  channel.destroy();
  expect(received).toEqual([
    launch,
    { type: "data", id: "provider:attach/42", data: "AP8=" },
    { type: "close", id: "provider:attach/42" },
  ]);
  transport.destroy();
});

it("negotiates advertised v1 capabilities independently on each ready frame", () => {
  const ready = { type: "ready", version: 1, workspaces: ["proof"] };
  expect(parseReadyFrame({ ...ready, futureExtension: true })).toEqual(ready);
  expect(parseReadyFrame({ ...ready, health: "yes" })).toEqual(ready);
  expect(parseReadyFrame({ ...ready, version: 2 })).toBeNull();
  expect(parseReadyFrame({ ...ready, workspaces: [""] })).toBeNull();
  expect(parseReadyFrame({ ...ready, managedWorkspace: true })).toBeNull();
  const managed = {
    ...ready,
    managedWorkspace: true,
    workspaces: ["@session"],
    health: true,
    engineManagement: true,
  };
  expect(parseReadyFrame(managed)).toEqual(managed);
});

function peer() {
  const sent: ServiceFrame[] = [];
  const connection = new RunnerConnection((frame) => sent.push(frame));
  return { connection, sent };
}
const attach: Command = {
  kind: "attach",
  agentId: "session-A",
  workspace: "shared",
};
function requestId(frame: ServiceFrame | undefined) {
  if (frame?.type !== "request") throw new Error("Expected a service request");
  return frame.id;
}

it("correlates out-of-order replies and buffers channel bytes before the attach receipt", async () => {
  const { connection, sent } = peer();
  const attached = connection.request(attach, { openChannel: true });
  const alive = connection.request({ ...attach, kind: "alive" });
  const id = requestId(sent[0]);
  connection.receive({ type: "result", id: requestId(sent[1]), value: false });
  expect((await alive).value).toBe(false);
  connection.receive({ type: "data", id, data: "AP8=" });
  connection.receive({ type: "result", id, value: true });
  const { channel } = await attached;
  expect(channel!.read()).toEqual(Buffer.from([0, 255]));
  connection.receive({ type: "close", id });
  for await (const _chunk of channel!)
    throw new Error("Unexpected extra channel data");
  expect(channel!.destroyed).toBe(true);
});

it("disconnect settles only its own requests and a missing host has a distinct result", async () => {
  const alpha = peer();
  const beta = peer();
  const lost = alpha.connection.request(attach);
  const pending = beta.connection.request(attach);
  alpha.connection.close();
  await expect(lost).rejects.toThrow(/acknowledgement was lost/);
  await expect(alpha.connection.request(attach)).rejects.toBeInstanceOf(
    RunnerUnavailable
  );
  beta.connection.receive({
    type: "result",
    id: requestId(beta.sent[0]),
    code: "host-gone",
  });
  await expect(pending).rejects.toBeInstanceOf(RunnerHostGone);
});

it("a timed-out request has an unknown outcome even if its receipt arrives late", async () => {
  vi.useFakeTimers();
  try {
    const { connection, sent } = peer();
    const lost = expect(connection.request(attach)).rejects.toThrow(
      /execution is unknown/
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await lost;
    connection.receive({ type: "result", id: requestId(sent[0]), value: true });
    expect(sent).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
