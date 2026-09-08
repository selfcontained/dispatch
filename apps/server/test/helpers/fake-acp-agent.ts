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
) => Promise<
  acp.StopReason | { stopReason: acp.StopReason; usage?: acp.Usage }
>;

/**
 * An in-process ACP agent wired to a ChildProcess-like object. The driver's
 * injected `spawn` returns `child`; the fake agent speaks on the other ends
 * of the same pipes, so no real process is involved.
 */
export function createFakeAcpAgent(
  opts: {
    turn?: FakeTurn;
    resumeFails?: boolean;
    /** Commands advertised right after a session opens. */
    commands?: acp.AvailableCommand[];
    /** Config options returned with the session. */
    configOptions?: acp.SessionConfigOption[];
  } = {}
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
    initialize: [] as acp.InitializeRequest[],
    newSession: [] as acp.NewSessionRequest[],
    resumeSession: [] as acp.ResumeSessionRequest[],
    setMode: [] as acp.SetSessionModeRequest[],
    setConfig: [] as acp.SetSessionConfigOptionRequest[],
    prompts: [] as string[],
    cancels: 0,
    closes: 0,
  };
  let sessionCounter = 0;
  // Assigned below; the agent's prompt handler needs it to push updates.
  let connection: acp.AgentSideConnection;
  // The turn in flight, so a cancel can reach it.
  let inFlight: AbortController | null = null;

  const announce = (sessionId: string) => {
    if (!opts.commands) return;
    setTimeout(() => {
      void connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: opts.commands ?? [],
        },
      });
    }, 0);
  };

  const agent: acp.Agent = {
    async initialize(params) {
      seen.initialize.push(params);
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
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
      const sessionId = `sess_${++sessionCounter}`;
      announce(sessionId);
      return { sessionId, configOptions: opts.configOptions ?? [] };
    },
    async resumeSession(params) {
      seen.resumeSession.push(params);
      if (opts.resumeFails) throw new Error("unknown session");
      announce(params.sessionId);
      return { configOptions: opts.configOptions ?? [] };
    },
    async setSessionMode(params) {
      seen.setMode.push(params);
      return {};
    },
    async setSessionConfigOption(params) {
      seen.setConfig.push(params);
      const options = (opts.configOptions ?? []).map((o) =>
        o.id === params.configId ? { ...o, currentValue: params.value } : o
      );
      return { configOptions: options };
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
        const result = opts.turn
          ? await opts.turn(text, emit, ask, controller.signal)
          : "end_turn";
        return typeof result === "string" ? { stopReason: result } : result;
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
