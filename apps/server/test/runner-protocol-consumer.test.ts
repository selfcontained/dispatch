import { Duplex } from "node:stream";
import {
  type Frame,
  type ServiceFrame,
  type Command,
  parseReadyFrame,
  parseServiceFrame,
  parseSessionCommand,
  parseConnectCreated,
  parseConnectPoll,
  runnerRequestId,
  sessionCommandId,
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
  const send = wireFrames<unknown, Frame>(transport, (value) => {
    const frame = parseServiceFrame(value);
    if (!frame) throw new Error("Malformed service frame");
    received.push(frame);
  });
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

const requestFrame = (command: object) => ({
  type: "request",
  id: "caller/request:1",
  command: { agentId: "caller/agent:1", workspace: "@session", ...command },
});

it("accepts each v1 execution command and preserves additive launch fields", () => {
  for (const kind of ["attach", "alive", "discard", "log", "repo"]) {
    const request = requestFrame({ kind });
    expect(parseServiceFrame(request)).toBe(request);
  }
  const stop = requestFrame({ kind: "stop", force: false });
  expect(parseServiceFrame(stop)).toBe(stop);

  const launch = {
    agentId: "legacy-launch-id",
    engine: "claude",
    model: null,
    systemPrompt: "",
    resumeSessionId: null,
    fullAccess: false,
    effort: "high",
    personaContext: null,
    mcp: {
      url: "https://service.example/mcp",
      token: "fixture",
      name: "tool-service",
      futureMcpField: true,
    },
  };
  for (const checkout of [
    { kind: "new", branch: "topic/new", base: "main" },
    { kind: "branch", branch: "topic/existing" },
    { kind: "pr", branch: "topic/pr", number: 42 },
  ]) {
    const request = {
      ...requestFrame({
        kind: "launch",
        launch: {
          ...launch,
          repository: { url: "https://git.example/project.git", checkout },
        },
      }),
      futureFrameField: {},
    };
    expect(parseServiceFrame(request)).toBe(request);
  }
  for (const fields of [
    { fullAccess: "false" },
    { engine: "future-engine" },
    { model: false },
    { systemPrompt: 1 },
    { effort: 1 },
    { personaContext: [] },
    { resumeSessionId: [] },
    { mcp: { url: "http://service.example/mcp", token: "fixture" } },
    { mcp: { url: "https://service.example/mcp", token: 1 } },
    {
      repository: {
        url: "https://git.example/project",
        checkout: { kind: "pr", branch: "topic/pr", number: -1 },
      },
    },
    {
      repository: {
        url: "https://git.example/project",
        checkout: { kind: "new", branch: "--option" },
      },
    },
    {
      repository: {
        url: "https://user:pass@git.example/project",
        checkout: { kind: "branch", branch: "topic" },
      },
    },
  ]) {
    const request = requestFrame({
      kind: "launch",
      launch: { ...launch, ...fields },
    });
    expect(parseServiceFrame(request)).toBeNull();
    expect(runnerRequestId(request)).toBe(request.id);
  }
  expect(parseServiceFrame(requestFrame({ kind: "stop" }))).toBeNull();
  expect(
    parseServiceFrame(requestFrame({ kind: "future-command" }))
  ).toBeNull();
  expect(parseServiceFrame({ ...stop, command: null })).toBeNull();
  expect(parseServiceFrame({ ...stop, id: "" })).toBeNull();
  expect(runnerRequestId({ ...stop, id: [] })).toBeUndefined();
  expect(
    parseServiceFrame({ type: "data", id: "channel", data: "AP8=\n" })
  ).toBeNull();
});

it("validates operation-specific engine arguments", () => {
  for (const operation of [
    { type: "status", futureStatusParameter: true },
    { type: "install", engine: "codex" },
    { type: "update", engine: "claude" },
    { type: "login_start", engine: "opencode" },
    { type: "login_start", engine: "opencode", restart: false },
    { type: "login_submit", loginId: "login:1", code: "fixture" },
    { type: "login_cancel", loginId: "login:1" },
    { type: "login_status", loginId: "login:1" },
  ]) {
    const request = requestFrame({
      kind: "engine",
      agentId: "@engine",
      operation,
    });
    expect(parseServiceFrame(request)).toBe(request);
  }
  for (const operation of [
    null,
    { type: "install" },
    { type: "update", engine: "future-engine" },
    { type: "login_start", engine: "codex", restart: "no" },
    { type: "login_submit", loginId: "login:1", code: 42 },
    { type: "login_cancel", loginId: null },
    { type: "login_status" },
    { type: "future-operation" },
  ]) {
    expect(
      parseServiceFrame(requestFrame({ kind: "engine", operation }))
    ).toBeNull();
  }
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
    { ...prompt, source: { ...source, conversation: { streamId: "stream" } } },
    { ...prompt, source: { ...source, chatMessageIds: [null] } },
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
