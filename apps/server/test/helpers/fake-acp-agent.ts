import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type FakeTurn = (
  prompt: string,
  emit: (update: acp.SessionUpdate) => Promise<void>,
  ask: (
    request: Pick<acp.RequestPermissionRequest, "options">
  ) => Promise<acp.RequestPermissionResponse>,
  /** Fires when the client cancels the turn; a long turn should stop then. */
  signal: AbortSignal
) => Promise<acp.StopReason>;

/**
 * An in-process ACP agent wired to a ChildProcess-like object. The driver's
 * injected `spawn` returns `child`; the fake agent speaks on the other ends
 * of the same pipes, so no real process is involved.
 */
export function createFakeAcpAgent(
  opts: { turn?: FakeTurn; resumeFails?: boolean } = {}
) {
  const toAgent = new PassThrough(); // driver stdin  -> agent input
  const fromAgent = new PassThrough(); // agent output -> driver stdout
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin: toAgent,
    stdout: fromAgent,
    stderr,
    killed: false,
    kill(signal?: NodeJS.Signals | number) {
      if (child.killed) return true;
      child.killed = true;
      queueMicrotask(() => emitter.emit("exit", null, signal ?? "SIGTERM"));
      return true;
    },
  });
  // A real child exits when its stdin closes; mirror that so the driver's
  // teardown ladder settles without a signal.
  toAgent.on("end", () => {
    if (!child.killed) {
      child.killed = true;
      queueMicrotask(() => emitter.emit("exit", 0, null));
    }
  });

  const seen = {
    newSession: [] as acp.NewSessionRequest[],
    resumeSession: [] as acp.ResumeSessionRequest[],
    prompts: [] as string[],
    cancels: 0,
    closes: 0,
  };
  let sessionCounter = 0;
  // Assigned below; the agent's prompt handler needs it to push updates.
  let connection: acp.AgentSideConnection;
  // The turn in flight, so a cancel can reach it.
  let inFlight: AbortController | null = null;

  const agent: acp.Agent = {
    async initialize() {
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "fake-dsh", version: "0.0.0" },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: { close: {}, resume: {} },
        },
        authMethods: [],
      };
    },
    async authenticate() {
      return {};
    },
    async newSession(params) {
      seen.newSession.push(params);
      return { sessionId: `sess_${++sessionCounter}`, configOptions: [] };
    },
    async resumeSession(params) {
      seen.resumeSession.push(params);
      if (opts.resumeFails) throw new Error("unknown session");
      return { configOptions: [] };
    },
    async prompt(params) {
      const text = params.prompt
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      seen.prompts.push(text);
      const emit = (update: acp.SessionUpdate) =>
        connection.sessionUpdate({ sessionId: params.sessionId, update });
      const ask = (request: Pick<acp.RequestPermissionRequest, "options">) =>
        connection.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: "perm_1", title: "permission" },
          options: request.options,
        });
      const controller = new AbortController();
      inFlight = controller;
      try {
        const stopReason = opts.turn
          ? await opts.turn(text, emit, ask, controller.signal)
          : "end_turn";
        return { stopReason };
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    },
    async cancel() {
      seen.cancels += 1;
      inFlight?.abort();
    },
    async closeSession() {
      seen.closes += 1;
      return {};
    },
  };

  const stream = acp.ndJsonStream(
    Writable.toWeb(fromAgent),
    Readable.toWeb(toAgent)
  );
  connection = new acp.AgentSideConnection(() => agent, stream);
  return { child, seen, stderr };
}
