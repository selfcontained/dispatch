import { Duplex } from "node:stream";
import {
  type Frame,
  isOpaqueId,
  remotePlacement,
  workspaceLocator,
} from "@dispatch/runner-protocol";
import { hostChannel, wireFrames } from "@dispatch/runner-protocol/node";
import { expect, it } from "vitest";

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
