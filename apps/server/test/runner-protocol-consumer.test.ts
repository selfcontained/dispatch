import { Duplex } from "node:stream";
import {
  parseConnectCreated,
  parseConnectPoll,
  parseSessionCommand,
  sessionCommandId,
} from "@dispatch/runner-protocol";
import { hostChannel, wireFrames } from "@dispatch/runner-client/v1/node";
import { expect, it } from "vitest";

it("consumes host channel framing without Dispatch server imports", async () => {
  const received: unknown[] = [];
  // Feed each write to the decoder a byte at a time, including split UTF-8.
  const transport = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      for (const byte of chunk) transport.emit("data", Buffer.from([byte]));
      done();
    },
  });
  const send = wireFrames<unknown, unknown>(transport, (frame) =>
    received.push(frame)
  );
  const hello = { type: "hello", journalId: "journal:β", fromSeq: 0 };
  send(hello);
  const channel = hostChannel("provider:attach/42", send, () => {});
  await new Promise<void>((resolve, reject) => {
    channel.write(Buffer.from([0, 255]), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  channel.destroy();
  expect(received).toEqual([
    hello,
    { type: "data", id: "provider:attach/42", data: "AP8=" },
    { type: "close", id: "provider:attach/42" },
  ]);
  transport.destroy();
});

it("decodes the host session vocabulary including legacy and extended prompts", () => {
  const source = {
    source: "chat",
    chatMessageId: "message:1",
    chatMessageIds: ["message:1", "message:2"],
    conversation: { streamId: "stream:1", threadId: null },
    answerIn: "message:2",
    userMessage: true,
    steeringExcluded: false,
    awaited: false,
    scheduleId: "schedule:1",
    scheduleDeliveryId: "delivery:1",
    attribution: { displayName: "Fixture" },
  };
  const prompt = {
    type: "prompt",
    id: "prompt:1",
    text: "",
    journalId: "journal:1",
    source,
    images: [{ path: "/fixture/image", mimeType: "image/png", alt: "Fixture" }],
  };
  for (const command of [
    { type: "hello", fromSeq: 0 },
    { type: "hello", fromSeq: 1, journalId: null, replayComplete: true },
    { type: "prompt", id: "legacy", text: "Hello" },
    prompt,
    { ...prompt, source: { ticket: 42, tags: ["intake"] } },
    { type: "steer", id: "steer:1", text: "Follow-up", source },
    { type: "cancel" },
    { type: "interrupt", id: "interrupt:1", turnSeq: 2 },
    {
      type: "answer_permission",
      id: "permission:1",
      requestId: "request:2",
      optionId: null,
    },
    { type: "set_config", id: "set:1", configId: "mode", value: "default" },
    { type: "shutdown", force: false },
    { type: "shutdown" },
    { type: "mcp_inventory", id: "inventory:1", sessionId: "session:1" },
    { type: "background_work", id: "background:1", sessionId: "session:1" },
    { type: "ping", futureFlag: true },
  ]) {
    expect(parseSessionCommand(command)).toBe(command);
  }
  for (const command of [
    null,
    { type: "hello", fromSeq: -1 },
    { type: "hello", fromSeq: 1.5 },
    { type: "hello", fromSeq: 0, replayComplete: "true" },
    { ...prompt, journalId: 7 },
    { ...prompt, images: [{ path: "/fixture/image" }] },
    { type: "steer", id: "steer:1", text: 1 },
    { type: "interrupt", id: "interrupt:1", turnSeq: 2 ** 53 },
    { type: "answer_permission", id: "permission:1", requestId: "request:2" },
    { type: "set_config", id: "set:1", configId: "mode", value: true },
    { type: "shutdown", force: "false" },
    { type: "mcp_inventory", id: "inventory:1" },
    { type: "background_work", id: "background:1", sessionId: [] },
    { type: "future-command", id: "future:1" },
  ]) {
    expect(parseSessionCommand(command)).toBeNull();
  }
  expect(sessionCommandId({ ...prompt, text: false })).toBe(prompt.id);
});

it("recognizes only supported enrollment replies and retains their extensions", () => {
  const created = {
    id: "connect/request:1",
    code: "TEST-CODE",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  const withLink = {
    ...created,
    approveUrl: "http://service.example/approve",
    futureField: true,
  };
  expect(parseConnectCreated(created)).toBe(created);
  expect(parseConnectCreated(withLink)).toBe(withLink);
  for (const result of [
    null,
    { ...created, id: ".." },
    { ...created, code: "CODE\nFORGED" },
    { ...created, expiresAt: "tomorrow" },
    { ...created, approveUrl: "file:///tmp/approve" },
  ]) {
    expect(parseConnectCreated(result)).toBeNull();
  }
  const approved = {
    status: "approved",
    id: "collector/runner:1",
    name: "Collector",
    endpoint: "https://runner.example:4000",
    cert: "fixture PEM",
    ca: "fixture CA",
    newerField: true,
  };
  for (const reply of [
    { status: "pending" },
    { status: "denied" },
    { status: "expired" },
    approved,
  ]) {
    expect(parseConnectPoll(reply)).toBe(reply);
  }
  for (const reply of [
    null,
    { status: "queued" },
    { ...approved, endpoint: "http://runner.example:4000" },
    { ...approved, name: [] },
    { ...approved, cert: "" },
    { ...approved, ca: false },
  ]) {
    expect(parseConnectPoll(reply)).toBeNull();
  }
});
