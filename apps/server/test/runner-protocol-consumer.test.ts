import { Duplex } from "node:stream";
import {
  type Frame,
  type RemoteLaunch,
  type RunnerFrame,
  type SessionReply,
  parseRunnerHealth,
  type ServiceFrame,
  type Command,
  parseReadyFrame,
  parseLaunchProgress,
  type LaunchProgress,
  parseServiceFrame,
  parseSessionCommand,
  parseConnectCreated,
  parseConnectPoll,
  runnerRequestId,
  sessionCommandId,
  isOpaqueId,
  isSessionFileData,
  MAX_SESSION_FILE_BYTES,
  isCheckoutReply,
  isSessionCheckout,
  isCheckoutObservation,
  parseGitHubPullRequestWatchEvent,
  isGitHubPullRequestDetails,
  isGitHubPullRequestDiff,
  isCheckoutViewData,
  remotePlacement,
  workspaceLocator,
} from "@dispatch/runner-protocol";
import {
  parseEngineInventory,
  type EngineInventoryEntry,
  type EngineOperationAck,
} from "@dispatch/runner-protocol/engine-management";
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
    githubManagement: true,
    pullRequestStatus: true,
    pullRequestWatch: true,
    pullRequestEvidence: true,
    checkoutInspection: true,
    checkoutViews: true,
    sharedWorktree: true,
    sessionCheckout: true,
  };
  expect(parseReadyFrame(managed)).toEqual(managed);
});

it("negotiates workspace progress per runner when workspace handles match", async () => {
  const ready = { type: "ready", version: 1, workspaces: ["workspace"] };
  const placement = (runner: string) =>
    workspaceLocator({ runner, workspace: "workspace" });
  const legacy = placement("legacy");
  const current = placement("current");
  const peers = new Map(
    [legacy, current].map((locator) => {
      const advertised = parseReadyFrame({
        ...ready,
        workspacePreparation: locator === current,
      })!;
      const messages: ServiceFrame[] = [];
      const connection = new RunnerConnection((frame) => messages.push(frame));
      return [locator, { advertised, messages, connection }];
    })
  );
  const launch = (locator: string, received: LaunchProgress[]) => {
    const { connection, advertised } = peers.get(locator)!;
    return connection.request(
      {
        kind: "launch",
        agentId: "host/session",
        workspace: "workspace",
        launch: {
          agentId: "host/session",
          engine: "codex",
          model: null,
          systemPrompt: null,
          resumeSessionId: null,
          ...(advertised.workspacePreparation && { prepareWorkspace: true }),
        },
      },
      { onProgress: (event) => received.push(event) }
    );
  };
  const legacyProgress: LaunchProgress[] = [];
  const enhancedProgress: LaunchProgress[] = [];
  const earlier = launch(legacy, legacyProgress);
  const enhanced = launch(current, enhancedProgress);
  const currentPeer = peers.get(current)!;
  const legacyPeer = peers.get(legacy)!;
  const request = (peer: typeof currentPeer) => {
    const frame = parseServiceFrame(peer.messages[0]);
    if (frame?.type !== "request" || frame.command.kind !== "launch")
      throw new Error("Expected launch request.");
    return { id: frame.id, launch: frame.command.launch };
  };
  const currentRequest = request(currentPeer);
  const legacyRequest = request(legacyPeer);
  expect(currentRequest.launch.prepareWorkspace).toBe(true);
  expect(legacyRequest.launch).not.toHaveProperty("prepareWorkspace");
  const progress = parseLaunchProgress({
    type: "launch_progress",
    id: currentRequest.id,
    progress: { phase: "workspace" },
  })!;
  currentPeer.connection.receive(progress);
  legacyPeer.connection.receive(progress);
  expect(enhancedProgress).toEqual([{ phase: "workspace" }]);
  expect(legacyProgress).toEqual([]);
  expect(
    parseLaunchProgress({
      ...progress,
      progress: { phase: "ready", status: "failed" },
    })
  ).toBeNull();
  for (const [peer, id] of [
    [currentPeer, currentRequest.id],
    [legacyPeer, legacyRequest.id],
  ] as const) {
    expect(peer.advertised.workspaces).toEqual(["workspace"]);
    peer.connection.receive({ type: "result", id, value: true });
  }
  await expect(Promise.all([earlier, enhanced])).resolves.toEqual([
    { value: true, channel: undefined },
    { value: true, channel: undefined },
  ]);
  currentPeer.connection.receive(progress);
  expect(enhancedProgress).toHaveLength(1);
  for (const peer of peers.values()) peer.connection.close();
});

it("validates runner-scoped GitHub command payloads", () => {
  const parse = (operation: unknown) =>
    parseServiceFrame({
      type: "request",
      id: "request-1",
      command: {
        kind: "github",
        workspace: "@session",
        agentId: "@github",
        operation,
      },
    });
  expect(
    parse({
      type: "pullRequestStatus",
      owner: "example",
      repo: "project",
      number: 42,
    })
  ).not.toBeNull();
  expect(
    parse({
      type: "pullRequestStatus",
      owner: "example",
      repo: "project",
      number: 0,
    })
  ).toBeNull();
  const target = { owner: "example", repo: "project", number: 42 };
  expect(
    parse({ type: "watchPullRequests", targets: [target] })
  ).not.toBeNull();
  expect(parse({ type: "watchPullRequests", targets: [] })).toBeNull();
  expect(
    parse({ type: "watchPullRequests", targets: Array(65).fill(target) })
  ).toBeNull();
  expect(
    parse({ type: "watchPullRequests", targets: [{ ...target, owner: ".." }] })
  ).toBeNull();
  expect(
    parse({ ...target, type: "pullRequestStatus", refreshWatch: true })
  ).not.toBeNull();
  expect(
    parse({ ...target, type: "pullRequestStatus", refreshWatch: "yes" })
  ).toBeNull();
  expect(
    parseGitHubPullRequestWatchEvent({
      type: "observation",
      target,
      observedAt: -1,
      observation: null,
    })
  ).toBeNull();
  expect(parse({ type: "login" })).not.toBeNull();
  expect(parse({ type: "repositorySearch", query: "org/repo" })).not.toBeNull();
  expect(parse({ type: "repositorySearch", query: "--help\n" })).toBeNull();
  expect(
    parse({ type: "pullRequestHead", owner: "..", repo: "repo", number: 1 })
  ).toBeNull();
  expect(
    parse({ type: "pullRequestHead", owner: "org", repo: "repo", number: 1 })
  ).not.toBeNull();
});

it("validates the checkout view commands and matching results", () => {
  const parse = (command: unknown) =>
    parseServiceFrame({ type: "request", id: "read", command });
  const session = { agentId: "author", workspace: "@session" };
  const query = { kind: "preview", path: "src/example.ts" } as const;
  expect(parse({ ...session, kind: "watchCheckout" })).not.toBeNull();
  expect(parse({ ...session, kind: "viewCheckout", query })).not.toBeNull();
  for (const path of ["/etc/config", "../elsewhere", "a/.git/config", "a//b"])
    expect(
      parse({ ...session, kind: "viewCheckout", query: { ...query, path } })
    ).toBeNull();
  expect(
    isCheckoutViewData(query, { kind: "text", text: "contents", size: 8 })
  ).toBe(true);
  expect(
    isCheckoutViewData(query, {
      kind: "image",
      src: "https://example.com",
      size: 8,
    })
  ).toBe(false);
  expect(
    isCheckoutViewData(
      { kind: "directory", path: "src" },
      {
        truncated: false,
        entries: [{ kind: "file", name: "A", path: "other/A" }],
      }
    )
  ).toBe(false);
});

it("validates checkout queries, results and borrowed launches", () => {
  const parse = (command: unknown) =>
    parseServiceFrame({ type: "request", id: "request-1", command });
  const request = {
    kind: "inspectCheckout",
    agentId: "author",
    workspace: "@session",
  };
  const read = { kind: "readFile", path: ".agents/owners.json" } as const;
  expect(parse({ ...request, query: read })).not.toBeNull();
  for (const path of ["/etc/config", "../other", "a//b", "./config"])
    expect(parse({ ...request, query: { ...read, path } })).toBeNull();
  expect(isCheckoutReply({ kind: "changes", files: [] }, read)).toBe(false);
  expect(isCheckoutReply({ kind: "readFile", content: null }, read)).toBe(true);
  const command = {
    kind: "launch",
    workspace: "@session",
    agentId: "reviewer",
  };
  const launch = {
    agentId: "reviewer",
    engine: "codex",
    model: null,
    systemPrompt: null,
    resumeSessionId: null,
    useWorktreeOf: "author",
  };
  expect(parse({ ...command, launch })).not.toBeNull();
  const existingDefault = (allowDefault: boolean) => ({
    ...command,
    launch: {
      ...launch,
      useWorktreeOf: undefined,
      repository: {
        url: "https://example.test/project.git",
        checkout: { kind: "branch", branch: "main", allowDefault },
      },
    },
  });
  expect(parse(existingDefault(true))).not.toBeNull();
  expect(parse(existingDefault(false))).toBeNull();
  const implicitDefault = {
    ...command,
    launch: {
      ...launch,
      useWorktreeOf: undefined,
      repository: {
        url: "https://example.test/project.git",
        checkout: { kind: "default" },
      },
    },
  };
  expect(parse(implicitDefault)).toMatchObject({
    command: { launch: { repository: { checkout: { kind: "default" } } } },
  });

  expect(parse({ ...command, agentId: "other", launch })).toBeNull();
  expect(
    parse({ ...command, launch: { ...launch, useWorktreeOf: "reviewer" } })
  ).toBeNull();
  expect(
    parse({
      ...command,
      launch: {
        ...launch,
        repository: {
          url: "https://repo.test/x",
          checkout: { kind: "branch", branch: "x" },
        },
      },
    })
  ).toBeNull();
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

// Independent service and deterministic runner peer. Both sides speak NDJSON;
// runner session state outlives the service's authenticated connection.
const githubTarget = { owner: "example", repo: "repo", number: 42 };
const githubDetails = {
  credentialContext: "c".repeat(64),
  number: 42,
  title: "Sample",
  body: "Private source",
  baseRefName: "main",
  headRefName: "feature",
  baseRefOid: "a".repeat(40),
  headRefOid: "b".repeat(40),
  additions: 1,
  deletions: 0,
  files: [{ path: "source.ts", additions: 1, deletions: 0 }],
};
const githubDiff = {
  files: [{ ...githubDetails.files[0], patch: "@@ -1 +1 @@\n-old\n+new" }],
};

function fixtureRunner(current: boolean) {
  const workspace = current ? "@session" : "workload/β";
  const agentId = "collector/requests%2F:42";
  const session = { workspace, agentId };
  const ready: RunnerFrame = {
    type: "ready",
    version: 1,
    workspaces: [workspace],
    ...(current && {
      managedWorkspace: true,
      health: true,
      engineManagement: true,
      githubManagement: true,
      pullRequestEvidence: true,
      pullRequestWatch: true,
      sessionCheckout: true,
      checkoutRelease: true,
      sessionFiles: true,
    }),
  };
  const sample = {
    version: "fixture",
    sessions: 1,
    working: 0,
    cpuPercent: null,
    memoryUsed: 64,
    memoryTotal: 128,
  };
  const inventory: EngineInventoryEntry[] = [
    {
      id: "codex",
      label: "Codex",
      installed: true,
      signedIn: null,
      version: null,
      actions: [],
    },
  ];
  const sessionId = "engine/session:42";
  const journalId = "journal/42";
  type Report = { text: string; context?: unknown };
  type Event = Extract<SessionReply<Report>, { type: "event" }>;
  const journal: Event[] = [];
  let running = false;
  let resumed = false;
  const requests: ServiceFrame[] = [];

  let selectedCheckout = "/workload/launch";
  const stateId = "b".repeat(64);
  let released = false;
  const files = new Map<string, string>();

  function connect(cut?: "partial-frame" | "lost-ack") {
    const service = new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        if (cut === "partial-frame") {
          runner.push(chunk.subarray(0, Math.floor(chunk.length / 2)));
          service.destroy();
          runner.destroy();
        } else runner.push(chunk);
        done();
      },
    });
    const runner = new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        service.push(chunk);
        done();
      },
    });
    const channels = new Map<string, Duplex>();
    const reports: RunnerFrame[] = [];
    const send = wireFrames<RunnerFrame, ServiceFrame>(service, (frame) => {
      switch (frame.type) {
        case "result":
        case "data":
        case "close":
          connection.receive(frame);
          break;
        default:
          reports.push(frame);
      }
    });
    const connection = new RunnerConnection(send);
    service.once("close", () => connection.close());
    const reply = wireFrames<unknown, RunnerFrame>(runner, (value) => {
      const frame = parseServiceFrame(value);
      if (!frame) throw new Error("Malformed fixture service frame");
      requests.push(frame);
      switch (frame.type) {
        case "accept_health":
          if (!current) throw new Error("Reports were not advertised");
          reply({ type: "health", sample });
          if (frame.engineInventory)
            reply({ type: "engine_inventory", entries: inventory });
          break;
        case "data":
          channels.get(frame.id)?.push(Buffer.from(frame.data, "base64"));
          break;
        case "close":
          channels.get(frame.id)?.destroy();
          break;
        case "request": {
          const { command, id } = frame;
          const result = (value: boolean | string) =>
            reply({ type: "result", id, value });
          if (
            current &&
            command.kind === "engine" &&
            command.workspace === workspace &&
            command.operation.type === "status"
          ) {
            const ack: EngineOperationAck = { ok: true };
            result(JSON.stringify(ack));
          } else if (
            current &&
            command.kind === "github" &&
            command.workspace === workspace
          ) {
            if (command.operation.type === "watchPullRequests") {
              const channel = hostChannel(id, reply, () => channels.delete(id));
              channels.set(id, channel);
              result(true);
              for (const target of command.operation.targets) {
                channel.write(
                  JSON.stringify({
                    type: "observation",
                    target,
                    observedAt: Date.now(),
                    observation: {
                      state: "OPEN",
                      title: "Tracked",
                      draft: false,
                      head: githubDetails.headRefOid,
                      rollup: [],
                    },
                  }) + "\n"
                );
              }
            } else if (command.operation.type === "pullRequestDetails")
              result(JSON.stringify(githubDetails));
            else if (
              command.operation.type === "pullRequestDiff" &&
              command.operation.credentialContext ===
                githubDetails.credentialContext &&
              command.operation.base === githubDetails.baseRefOid &&
              command.operation.head === githubDetails.headRefOid
            )
              result(JSON.stringify(githubDiff));
            else result("null");
          } else if (
            command.workspace !== workspace ||
            command.agentId !== agentId
          ) {
            reply({ type: "result", id, error: "Unknown session binding" });
          } else if (command.kind === "sessionFile" && current && running) {
            const operation = command.operation;
            const root = "/workload/files/";
            if (operation.kind === "deliver") {
              files.set(root + operation.name, operation.data);
              if (cut === "lost-ack") {
                service.destroy();
                runner.destroy();
              } else result(root + operation.name);
            } else {
              const bytes = files.get(operation.path);
              if (bytes === undefined)
                reply({ type: "result", id, error: "File unavailable" });
              else result(bytes);
            }
          } else if (command.kind === "checkoutRelease" && current) {
            if (command.operation.kind === "observe") {
              result(
                JSON.stringify({
                  ownership: released ? "none" : "owned",
                  owner: released ? null : "machine/owner",
                  borrowers: released ? [] : ["machine/borrower"],
                  checkout: released
                    ? null
                    : {
                        path: selectedCheckout,
                        branch: "feature",
                        stateId,
                        unmerged: true,
                        changedFiles: ["retained.txt"],
                        uncommittedFiles: [],
                      },
                })
              );
            } else if (
              !running &&
              command.operation.expectedState === stateId
            ) {
              released = true;
              result("released");
            } else {
              result("retained");
            }
          } else if (command.kind === "sessionCheckout" && current && running) {
            if (command.operation.kind === "select")
              selectedCheckout = command.operation.path ?? "/workload/launch";
            result(
              JSON.stringify({
                path: selectedCheckout,
                moved: selectedCheckout !== "/workload/launch",
                origin: "https://example.test/project.git",
              })
            );
          } else if (command.kind === "launch") {
            resumed = command.launch.resumeSessionId === sessionId;
            running = true;
            result(true);
          } else if (command.kind === "stop") {
            running = false;
            result(true);
          } else if (command.kind === "attach") {
            if (!running) {
              reply({ type: "result", id, code: "host-gone" });
              break;
            }
            const channel = hostChannel(id, reply, () => channels.delete(id));
            channels.set(id, channel);
            const report = wireFrames<unknown, SessionReply<Report>>(
              channel,
              (raw) => {
                const message = parseSessionCommand(raw);
                if (message?.type === "hello") {
                  report({
                    type: "welcome",
                    agentId,
                    engine: "codex",
                    sessionId,
                    resumed,
                    running,
                    journalSeq: journal.length,
                    journalId,
                  });
                  const cursor =
                    message.journalId === journalId ? message.fromSeq : 0;
                  for (const event of journal.slice(cursor)) report(event);
                  if (message.replayComplete)
                    report({ type: "replay_complete" });
                } else if (
                  message?.type === "prompt" &&
                  message.journalId === journalId
                ) {
                  report({ type: "prompt_accepted", id: message.id });
                  const event: Event = {
                    type: "event",
                    seq: journal.length + 1,
                    journalId,
                    at: "2030-01-01T00:00:00.000Z",
                    event: { text: message.text, context: message.source },
                  };
                  journal.push(event);
                  report(event);
                } else {
                  report({
                    type: "error",
                    id: sessionCommandId(raw),
                    message: "Unsupported session request",
                  });
                }
              }
            );
            result(true);
          } else {
            reply({ type: "result", id, error: "Unsupported runner request" });
          }
          break;
        }
      }
    });
    reply(ready);
    return {
      connection,
      reports,
      send,
      close() {
        for (const channel of channels.values()) channel.destroy();
        connection.close();
        service.destroy();
        runner.destroy();
      },
    };
  }
  return {
    connect,
    session,
    sample,
    inventory,
    requests,
    sessionId,
    journalId,
  };
}

it("lets an independent host select a checkout by opaque session handle after negotiation", async () => {
  const runner = fixtureRunner(true);
  const launch: RemoteLaunch = {
    agentId: runner.session.agentId,
    engine: "codex",
    model: null,
    systemPrompt: null,
    resumeSessionId: null,
  };
  const initial = runner.connect();
  try {
    await vi.waitFor(() =>
      expect(parseReadyFrame(initial.reports[0])?.sessionCheckout).toBe(true)
    );
    await initial.connection.request({
      ...runner.session,
      kind: "launch",
      launch,
    });
    const move = {
      ...runner.session,
      kind: "sessionCheckout" as const,
      operation: { kind: "select" as const, path: "/workload/moved" },
    };
    expect(
      parseServiceFrame({
        type: "request",
        id: "relative",
        command: {
          ...move,
          operation: { kind: "select", path: "runner://foreign/@session" },
        },
      })
    ).toBeNull();
    await expect(
      initial.connection.request({ ...move, agentId: "another/host" })
    ).rejects.toThrow("Unknown session binding");
    const { value } = await initial.connection.request(move);
    const selected = JSON.parse(String(value));
    expect(isSessionCheckout(selected)).toBe(true);
    expect(selected).toMatchObject({ path: "/workload/moved", moved: true });
    expect(
      isSessionCheckout({
        ...selected,
        origin: "https://user:token@example.test/repo",
      })
    ).toBe(false);
  } finally {
    initial.close();
  }
  const resumed = runner.connect();
  try {
    const { value } = await resumed.connection.request({
      ...runner.session,
      kind: "sessionCheckout",
      operation: { kind: "describe" },
    });
    expect(JSON.parse(String(value))).toMatchObject({
      path: "/workload/moved",
      moved: true,
    });
  } finally {
    resumed.close();
  }
});

it.each([true, false])(
  "independent checkout release consumer negotiates capability: %s",
  async (current) => {
    const runner = fixtureRunner(current);
    const peer = runner.connect();
    try {
      await vi.waitFor(() => expect(peer.reports[0]).toBeDefined());
      const ready = parseReadyFrame(peer.reports[0]);
      expect(ready?.checkoutRelease).toBe(current ? true : undefined);
      if (!ready?.checkoutRelease) {
        expect(runner.requests).toHaveLength(0);
        return;
      }
      const observe = {
        ...runner.session,
        kind: "checkoutRelease",
        operation: { kind: "observe" },
      } as const;
      const observation: unknown = JSON.parse(
        String((await peer.connection.request(observe)).value)
      );
      expect(isCheckoutObservation(observation)).toBe(true);
      if (!isCheckoutObservation(observation) || !observation.checkout)
        throw new Error("Missing checkout observation");
      expect(observation.borrowers).toEqual(["machine/borrower"]);
      const release = {
        ...observe,
        operation: {
          kind: "release",
          expectedState: observation.checkout.stateId,
        },
      } as const;
      expect(
        parseServiceFrame({
          type: "request",
          id: "bad",
          command: {
            ...release,
            operation: { kind: "release", expectedState: "../bad" },
          },
        })
      ).toBeNull();
      expect((await peer.connection.request(release)).value).toBe("released");
      expect((await peer.connection.request(release)).value).toBe("released");
    } finally {
      peer.close();
    }
  }
);

it.each([true, false])(
  "independent service starts and resumes a runner session (current capabilities: %s)",
  async (current) => {
    const runner = fixtureRunner(current);
    let peer = runner.connect();
    const launch: RemoteLaunch = {
      agentId: runner.session.agentId,
      engine: "codex",
      model: null,
      systemPrompt: null,
      resumeSessionId: null,
    };
    async function attach() {
      const { channel } = await peer.connection.request(
        { ...runner.session, kind: "attach" },
        { openChannel: true }
      );
      if (!channel) throw new Error("Missing session channel");
      const messages: SessionReply[] = [];
      const send = wireFrames<SessionReply, unknown>(channel, (frame) =>
        messages.push(frame)
      );
      const take = async () => {
        await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
        return messages.shift();
      };
      return { send, take };
    }

    try {
      await vi.waitFor(() => expect(peer.reports[0]).toBeDefined());
      const ready = parseReadyFrame(peer.reports[0]);
      expect(ready?.workspaces).toEqual([runner.session.workspace]);
      if (ready?.health) {
        peer.send({
          type: "accept_health",
          engineInventory: ready.engineManagement,
        });
        await vi.waitFor(() => expect(peer.reports).toHaveLength(3));
        const [, health, inventory] = peer.reports;
        expect(
          health?.type === "health" && parseRunnerHealth(health.sample)
        ).toEqual(runner.sample);
        expect(
          inventory?.type === "engine_inventory" &&
            parseEngineInventory(inventory.entries)
        ).toEqual(runner.inventory);
      }

      await expect(
        peer.connection.request({ ...runner.session, kind: "attach" })
      ).rejects.toBeInstanceOf(RunnerHostGone);
      await expect(
        peer.connection.request({
          ...runner.session,
          workspace: "unknown",
          kind: "launch",
          launch,
        })
      ).rejects.toThrow("Unknown session binding");
      expect(
        (
          await peer.connection.request({
            ...runner.session,
            kind: "launch",
            launch,
          })
        ).value
      ).toBe(true);
      const status = ready?.engineManagement
        ? await peer.connection.request({
            kind: "engine",
            workspace: runner.session.workspace,
            agentId: "service/status",
            operation: { type: "status" },
          })
        : { unavailable: true };
      expect(status).toMatchObject(
        current
          ? { value: JSON.stringify({ ok: true }) }
          : { unavailable: true }
      );

      if (ready?.githubManagement && ready.pullRequestWatch) {
        const { value, channel } = await peer.connection.request(
          {
            kind: "github",
            workspace: runner.session.workspace,
            agentId: "independent-watcher",
            operation: { type: "watchPullRequests", targets: [githubTarget] },
          },
          { openChannel: true }
        );
        expect(value).toBe(true);
        const snapshots: unknown[] = [];
        wireFrames(channel!, (raw) =>
          snapshots.push(parseGitHubPullRequestWatchEvent(raw))
        );
        await vi.waitFor(() =>
          expect(snapshots).toEqual([
            expect.objectContaining({
              type: "observation",
              target: githubTarget,
              observedAt: expect.any(Number),
              observation: expect.objectContaining({ rollup: [] }),
            }),
          ])
        );
        channel!.destroy();
        await vi.waitFor(() =>
          expect(runner.requests).toContainEqual(
            expect.objectContaining({ type: "close" })
          )
        );
      } else {
        expect(ready?.pullRequestWatch).toBeUndefined();
      }
      if (ready?.githubManagement && ready.pullRequestEvidence) {
        const route = {
          kind: "github" as const,
          workspace: runner.session.workspace,
          agentId: "collector/evidence",
        };
        const details = JSON.parse(
          String(
            (
              await peer.connection.request({
                ...route,
                operation: { type: "pullRequestDetails", ...githubTarget },
              })
            ).value
          )
        );
        expect(isGitHubPullRequestDetails(details)).toBe(true);
        expect(details).toEqual(githubDetails);
        const diff = JSON.parse(
          String(
            (
              await peer.connection.request({
                ...route,
                operation: {
                  type: "pullRequestDiff",
                  ...githubTarget,
                  credentialContext: details.credentialContext,
                  base: details.baseRefOid,
                  head: details.headRefOid,
                },
              })
            ).value
          )
        );
        expect(isGitHubPullRequestDiff(diff)).toBe(true);
        expect(diff).toEqual(githubDiff);
      }
      expect(
        runner.requests.some(
          (frame) => frame.type === "request" && frame.command.kind === "github"
        )
      ).toBe(current);
      const first = await attach();
      first.send({ type: "hello", fromSeq: 0, replayComplete: true });
      const welcome = await first.take();
      expect(welcome).toMatchObject({
        type: "welcome",
        sessionId: runner.sessionId,
        resumed: false,
        running: true,
        journalId: runner.journalId,
      });
      expect(await first.take()).toEqual({ type: "replay_complete" });
      first.send({ type: "future_request", id: "bad:1" });
      expect(await first.take()).toMatchObject({ type: "error", id: "bad:1" });
      if (welcome?.type !== "welcome") throw new Error("Missing host welcome");
      const context = { ticket: 42 };
      for (const [index, text] of ["first report", "second report"].entries()) {
        const id = `operation/${index}`;
        first.send({
          type: "prompt",
          id,
          text,
          journalId: welcome.journalId,
          ...(current && { source: context }),
        });
        expect(await first.take()).toEqual({ type: "prompt_accepted", id });
        expect(await first.take()).toMatchObject({
          type: "event",
          seq: index + 1,
          event: current ? { text, context } : { text },
        });
      }

      await peer.connection.request({
        ...runner.session,
        kind: "stop",
        force: false,
      });
      peer.close();
      peer = runner.connect();
      await vi.waitFor(() =>
        expect(parseReadyFrame(peer.reports[0])).not.toBeNull()
      );
      const resume = { ...launch, resumeSessionId: welcome.sessionId };
      expect(
        (
          await peer.connection.request({
            ...runner.session,
            kind: "launch",
            launch: resume,
          })
        ).value
      ).toBe(true);
      const second = await attach();
      second.send({
        type: "hello",
        fromSeq: 1,
        journalId: welcome.journalId,
        replayComplete: true,
      });
      expect(await second.take()).toMatchObject({
        type: "welcome",
        sessionId: runner.sessionId,
        resumed: true,
        journalSeq: 2,
      });
      expect(await second.take()).toMatchObject({
        type: "event",
        seq: 2,
        event: { text: "second report" },
      });
      expect(await second.take()).toEqual({ type: "replay_complete" });
      expect(
        runner.requests.filter((frame) => frame.type === "accept_health")
      ).toHaveLength(current ? 1 : 0);
      expect(
        runner.requests.filter(
          (frame) => frame.type === "request" && frame.command.kind === "engine"
        )
      ).toHaveLength(current ? 1 : 0);
    } finally {
      peer.close();
    }
  }
);

it.each([true, false])(
  "independent service negotiates and retries a complete session file: %s",
  async (current) => {
    const runner = fixtureRunner(current);
    const peer = runner.connect();
    const data = Buffer.from([0, 255, 128]).toString("base64");
    const deliver = {
      ...runner.session,
      kind: "sessionFile",
      operation: { kind: "deliver", name: "sample.bin", data },
    } as const;
    const collect = {
      ...runner.session,
      kind: "sessionFile",
      operation: { kind: "collect", path: "/workload/files/sample.bin" },
    } as const;
    try {
      await vi.waitFor(() => expect(peer.reports[0]).toBeDefined());
      expect(parseReadyFrame(peer.reports[0])?.sessionFiles).toBe(
        current ? true : undefined
      );
      if (!current) {
        expect(runner.requests).toHaveLength(0);
        return;
      }
      await peer.connection.request({
        ...runner.session,
        kind: "launch",
        launch: {
          agentId: runner.session.agentId,
          engine: "codex",
          model: null,
          systemPrompt: null,
          resumeSessionId: null,
        },
      });
      for (const [cut, written] of [
        ["partial-frame", false],
        ["lost-ack", true],
      ] as const) {
        const interrupted = runner.connect(cut);
        try {
          await expect(
            interrupted.connection.request(deliver)
          ).rejects.toBeInstanceOf(RunnerUnavailable);
          if (written)
            expect((await peer.connection.request(collect)).value).toBe(data);
          else
            await expect(peer.connection.request(collect)).rejects.toThrow(
              "File unavailable"
            );
        } finally {
          interrupted.close();
        }
      }
      expect((await peer.connection.request(deliver)).value).toBe(
        collect.operation.path
      );
      const collected = (await peer.connection.request(collect)).value;
      expect(isSessionFileData(collected)).toBe(true);
      expect(collected).toBe(data);
      await expect(
        peer.connection.request({ ...collect, agentId: "other/session" })
      ).rejects.toThrow("Unknown session binding");
    } finally {
      peer.close();
    }
  }
);

it("bounds decoded session files and rejects unsafe paths at the wire boundary", () => {
  expect(
    isSessionFileData(Buffer.alloc(MAX_SESSION_FILE_BYTES).toString("base64"))
  ).toBe(true);
  expect(
    isSessionFileData(
      Buffer.alloc(MAX_SESSION_FILE_BYTES + 1).toString("base64")
    )
  ).toBe(false);
  expect(isSessionFileData("a=a=")).toBe(false);
  expect(isSessionFileData("")).toBe(true);
  for (const operation of [
    { kind: "deliver", name: "../file", data: "" },
    { kind: "deliver", name: "slash/file", data: "" },
    { kind: "collect", path: "/root/../other/file" },
    { kind: "collect", path: "path\0name" },
  ]) {
    expect(
      parseServiceFrame({
        type: "request",
        id: "file/42",
        command: {
          workspace: "my/space",
          agentId: "my/session",
          kind: "sessionFile",
          operation,
        },
      })
    ).toBeNull();
  }
});
