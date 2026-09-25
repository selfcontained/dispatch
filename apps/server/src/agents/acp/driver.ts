import { PermissionRequests } from "./permissions.js";
import type { AgentPermissionRequest } from "@dispatch/shared";
import type { PromptSource } from "./prompt-source.js";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { EngineSpec } from "./engine-spec.js";
import { isPackageBinDir } from "./package-bin-dir.js";

export type DriverUpdate = acp.SessionUpdate;
export type DriverUsage = acp.Usage;

export type DriverLaunch = {
  agentId: string;
  cwd: string;
  engine: EngineSpec;
  /** The persona, for an engine whose spec says `system_prompt`; null otherwise. */
  systemPromptAppend: string | null;
  /** Guidance for engines without system-prompt support, once per host start. */
  firstPromptAppend?: string | null;
  mcp: { url: string; token: string };
  /** Resume this ACP session when set; falls back to a new one if the engine lost it. */
  sessionId: string | null;
  env: NodeJS.ProcessEnv;
};

export type DriverEvent =
  /** Input accepted into the existing turn, journaled before its settlement. */
  | { type: "steered"; agentId: string; text: string; source?: PromptSource }
  /** Live host snapshot, emitted by the runtime with seq 0; never replayed from the journal. */
  | { type: "permissions"; agentId: string; requests: AgentPermissionRequest[] }
  | { type: "update"; agentId: string; update: DriverUpdate }
  /**
   * The engine's session config options, whole: once the session opens and
   * again whenever the engine changes them. The model option is where the
   * server learns which model is really running and which it could run.
   */
  | { type: "config"; agentId: string; options: acp.SessionConfigOption[] }
  | {
      type: "turn";
      agentId: string;
      state: "started";
      text: string;
      /**
       * What this prompt is, as the sender knew it. Dispatch puts the
       * block id in the envelope for the agent to quote back; this is the
       * same id for Dispatch's own use, so nothing has to read the
       * envelope back off the wire to find out what opened the turn.
       */
      source?: PromptSource;
      /** The model the engine runs this turn on, when it publishes one. */
      model?: string;
      /** The ACP session the turn runs in: its usage belongs to that session. */
      sessionId?: string;
    }
  | {
      type: "turn";
      agentId: string;
      state: "settled";
      stopReason?: acp.StopReason;
      /** Cumulative session usage reported with the prompt response. */
      usage?: DriverUsage;
      error?: string;
      /**
       * The adapter's category for a failed turn (`server_error`,
       * `overloaded`, `transport_lost`…), when it gave one.
       */
      errorKind?: string;
    }
  | {
      type: "exit";
      agentId: string;
      code: number | null;
      signal: string | null;
      stderrTail: string;
      /** True when Dispatch asked the child to stop; false for a crash. */
      expected: boolean;
    };

export type DriverListener = (event: DriverEvent) => void;

export type DriverLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
};

export type ChildProcessLike = Pick<
  ChildProcess,
  "stdin" | "stdout" | "stderr" | "on" | "kill" | "killed" | "pid"
>;

export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcessLike;

type ExitInfo = { code: number | null; signal: string | null; error?: Error };

type Live = {
  steeringSupported: boolean;
  turnOpen: boolean;
  steering: Promise<unknown>;
  engine: EngineSpec["id"];
  firstPromptAppend: string | null;
  child: ChildProcessLike;
  conn: acp.ClientSideConnection;
  sessionId: string;
  startedAt: string;
  exited: Promise<ExitInfo>;
  stopping: boolean;
  cancelling: boolean;
  config: { options: acp.SessionConfigOption[] };
  commands: { list: acp.AvailableCommand[] };
};

const STDERR_TAIL_LINES = 20;
const STDERR_LINE_MAX_CHARS = 1024;
const STDERR_TAIL_MAX_CHARS = 8 * 1024;
/**
 * Shared with the supervisor so its shutdown deadline covers every stop phase.
 */
export const TEARDOWN_STEP_MS = 1_500;
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * The ACP SDK reports an agent-side exception as JSON-RPC "Internal error"
 * and keeps the real message in `data.details` (the agent itself does the
 * same for a failed turn), so surface that detail instead of the bare code.
 * An `errorKind` in the data is a category for the client to act on, not
 * words for a reader: it comes back on its own and stays out of the text,
 * and a message that has one drops the generic "Internal error" label.
 */
function describeRpcError(
  err: unknown,
  engine: EngineSpec["id"]
): {
  message: string;
  errorKind?: string;
} {
  if (!(err instanceof Error)) return { message: String(err) };
  if ((err as { code?: number }).code === -32000) {
    const command = engine === "claude" ? "claude auth login" : "codex login";
    const name = engine === "claude" ? "Claude" : "Codex";
    return {
      message: `${name} sign-in required. Run \`${command}\` in a terminal on the machine running Dispatch, using the same OS account as the Dispatch server. Then restart this agent and resend your message.`,
      errorKind: "authentication_required",
    };
  }
  const raw = (err as { data?: unknown }).data;
  let data = raw;
  let errorKind: string | undefined;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const { errorKind: kind, ...rest } = raw as Record<string, unknown>;
    if (typeof kind === "string") {
      errorKind = kind;
      data = rest;
    }
  }
  let detail: string | null = null;
  if (typeof data === "string") detail = data;
  else if (data && typeof data === "object") {
    const details = (data as { details?: unknown }).details;
    if (typeof details === "string") detail = details;
    else if (Object.keys(data).length > 0) detail = JSON.stringify(data);
  }
  let message =
    detail && !err.message.includes(detail)
      ? `${err.message}: ${detail}`
      : err.message;
  if (errorKind) {
    message = message.replace(/^Internal error: (?=\S)/, "");
  }
  return errorKind ? { message, errorKind } : { message };
}

/**
 * Resolve against the service PATH, not the login shell, and report the
 * relevant setting when the executable is missing.
 */
export async function resolveExecutable(
  bin: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const executable = async (candidate: string) => {
    try {
      await access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (bin.includes("/")) {
    const absolute = path.resolve(bin);
    if (await executable(absolute)) return absolute;
    throw new Error(`${bin} is not executable at ${absolute}`);
  }
  const searchPath = env.PATH ?? process.env.PATH ?? "";
  for (const dir of searchPath.split(path.delimiter)) {
    // Relative entries resolve against whatever cwd; a package's bin dir
    // holds a dependency's copy of the CLI (see isPackageBinDir).
    if (!path.isAbsolute(dir) || isPackageBinDir(dir)) continue;
    const candidate = path.join(dir, bin);
    if (await executable(candidate)) return candidate;
  }
  throw new Error(
    `${bin} was not found on the server's PATH; set the engine's DISPATCH_*_BIN to an absolute path`
  );
}

function defaultSpawn(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
): ChildProcessLike {
  // Its own process group: an adapter spawns the engine CLI as a child of
  // its own, and a signal to the adapter alone leaves that CLI running with
  // full-access permissions and a live MCP token. signalChild targets the
  // group.
  return nodeSpawn(bin, args, {
    ...opts,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
}

/**
 * Signal the child and everything it spawned. The group is addressed by
 * the child's pid (it leads its own group, see defaultSpawn); a child
 * without a pid, or one whose group is already gone, gets the plain kill.
 */
function signalChild(child: ChildProcessLike, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // ESRCH: the group is gone already. Anything else: fall back to the
      // child itself rather than skip the signal.
    }
  }
  child.kill(signal);
}

function describeExit(exit: ExitInfo): string {
  if (exit.error) {
    const code = (exit.error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? `the agent could not be spawned (${exit.error.message})`
      : exit.error.message;
  }
  return exit.code === null
    ? `the agent exited on signal ${exit.signal}`
    : `the agent exited with code ${exit.code}`;
}

export class AcpDriver {
  private readonly permissions: PermissionRequests;
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Set<DriverListener>();
  private readonly spawnFn: SpawnFn;
  private readonly resolveBinary: (
    bin: string,
    env: NodeJS.ProcessEnv
  ) => Promise<string>;

  constructor(
    private readonly opts: {
      spawn?: SpawnFn;
      onPermissions?: (
        agentId: string,
        requests: AgentPermissionRequest[]
      ) => void;
      /** Injectable for tests that spawn a fake; defaults to a PATH lookup. */
      resolveBinary?: (bin: string, env: NodeJS.ProcessEnv) => Promise<string>;
      logger: DriverLogger;
    }
  ) {
    this.permissions = new PermissionRequests((agentId) => {
      this.opts.onPermissions?.(agentId, this.permissions.list(agentId));
    });
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.resolveBinary = opts.resolveBinary ?? resolveExecutable;
  }

  onEvent(listener: DriverListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isRunning(agentId: string): boolean {
    return this.live.has(agentId);
  }

  liveAgentIds(): string[] {
    return [...this.live.keys()];
  }

  async start(
    launch: DriverLaunch
  ): Promise<{ sessionId: string; resumed: boolean }> {
    if (this.live.has(launch.agentId)) {
      throw new Error(`the agent is already running for ${launch.agentId}`);
    }
    const { engine } = launch;
    const env: NodeJS.ProcessEnv = { ...launch.env, ...engine.env };
    const bin = await this.resolveBinary(engine.bin, env);
    const child = this.spawnFn(bin, engine.args, { cwd: launch.cwd, env });
    // Both listeners go on before any await: a spawn failure (ENOENT, EACCES,
    // missing cwd) is an `error` event with no `exit`, and an unhandled one
    // would take the whole server down.
    const stderrTail: string[] = [];
    let settledExit: ExitInfo | null = null;
    const exited = new Promise<ExitInfo>((resolve) => {
      child.on("exit", (code, signal) =>
        resolve({ code, signal: signal ?? null })
      );
      child.on("error", (error: Error) =>
        resolve({ code: null, signal: null, error })
      );
    });
    void exited.then((exit) => {
      settledExit = exit;
      this.permissions.cancel(launch.agentId);
    });
    // Bounded by lines and by bytes: the tail lands in a status row the feed
    // reads back on every page, and one line can be a whole JSON dump.
    let stderrBytes = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const raw of chunk.toString("utf8").split("\n")) {
        if (!raw.trim()) continue;
        const line =
          raw.length > STDERR_LINE_MAX_CHARS
            ? `${raw.slice(0, STDERR_LINE_MAX_CHARS)}…`
            : raw;
        stderrTail.push(line);
        stderrBytes += line.length;
        while (
          stderrTail.length > STDERR_TAIL_LINES ||
          (stderrBytes > STDERR_TAIL_MAX_CHARS && stderrTail.length > 1)
        ) {
          stderrBytes -= stderrTail.shift()?.length ?? 0;
        }
      }
    });

    const config = { options: [] as acp.SessionConfigOption[] };
    const commands: { list: acp.AvailableCommand[] } = { list: [] };
    const client: acp.Client = {
      sessionUpdate: async (params) => {
        if (params.update.sessionUpdate === "config_option_update") {
          config.options = params.update.configOptions ?? [];
          this.emit({
            type: "config",
            agentId: launch.agentId,
            options: config.options,
          });
          return;
        } else if (
          params.update.sessionUpdate === "available_commands_update"
        ) {
          commands.list = params.update.availableCommands ?? [];
        }
        this.emit({
          type: "update",
          agentId: launch.agentId,
          update: params.update,
        });
      },
      // Full access preserves automatic approval; restricted sessions wait for the user.
      requestPermission: async (params) => {
        if (
          settledExit ||
          this.live.get(launch.agentId)?.stopping ||
          this.live.get(launch.agentId)?.cancelling
        )
          return { outcome: { outcome: "cancelled" } };
        if (engine.fullAccess.kind === "approval")
          return this.permissions.ask(launch.agentId, params);
        const allow = params.options.find(
          (o) => o.kind === "allow_once" || o.kind === "allow_always"
        );
        if (!allow) {
          this.opts.logger.warn(
            {
              agentId: launch.agentId,
              options: params.options.map((o) => o.kind),
            },
            "permission request had no allow option; cancelling"
          );
          return { outcome: { outcome: "cancelled" } };
        }
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      },
    };
    if (!child.stdin || !child.stdout) {
      signalChild(child, "SIGKILL");
      throw new Error("Agent connection failed: child has no stdio pipes");
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout)
    );
    const conn = new acp.ClientSideConnection(() => client, stream);

    const meta = {
      ...(launch.systemPromptAppend
        ? { systemPrompt: { append: launch.systemPromptAppend } }
        : {}),
      ...(engine.id === "claude" && engine.fullAccess.kind === "approval"
        ? {
            claudeCode: { options: { allowDangerouslySkipPermissions: false } },
          }
        : {}),
    };
    const sessionMeta = Object.keys(meta).length ? { _meta: meta } : {};
    let steeringSupported = false;
    const handshake = (async () => {
      const initialized = await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          ...(engine.subagentTranscripts
            ? { _meta: { "subagent-transcript": true } }
            : {}),
        },
      });
      const steering = initialized._meta?.steering;
      steeringSupported =
        !!steering &&
        typeof steering === "object" &&
        (steering as { supported?: unknown }).supported === true;
      const mcpServers: acp.McpServer[] = [
        {
          type: "http",
          name: "dispatch",
          url: launch.mcp.url,
          headers: [
            { name: "Authorization", value: `Bearer ${launch.mcp.token}` },
          ],
        },
      ];
      let session: { sessionId: string; resumed: boolean } | null = null;
      if (launch.sessionId) {
        try {
          // session/resume, not session/load: load replays the history as
          // updates and the recorder would write every turn again.
          const resumed = await conn.resumeSession({
            sessionId: launch.sessionId,
            cwd: launch.cwd,
            mcpServers,
            ...sessionMeta,
          });
          config.options = resumed.configOptions ?? config.options;
          session = { sessionId: launch.sessionId, resumed: true };
        } catch (err) {
          // The engine no longer has the session (home cleared, store
          // pruned, or an earlier start died after the id was recorded). A
          // fresh session beats an agent that can never start again.
          this.opts.logger.warn(
            { err, agentId: launch.agentId, sessionId: launch.sessionId },
            "the engine could not resume the stored session; starting a new one"
          );
        }
      }
      if (!session) {
        const res = await conn.newSession({
          cwd: launch.cwd,
          mcpServers,
          ...sessionMeta,
        });
        config.options = res.configOptions ?? config.options;
        session = { sessionId: res.sessionId, resumed: false };
      }
      if (engine.fullAccess.kind === "approval") {
        // Override saved/user default modes before accepting any prompt, including on resume.
        // Failure must fail startup, never silently run with broader permissions.
        await conn.setSessionMode({
          sessionId: session.sessionId,
          modeId: engine.id === "claude" ? "default" : "read-only",
        });
      }
      return session;
    })();

    type Outcome =
      | { ok: true; session: { sessionId: string; resumed: boolean } }
      | { ok: false; reason: string };
    const outcome = await Promise.race<Outcome>([
      handshake.then(
        (session) => ({ ok: true, session }),
        (err) => ({
          ok: false,
          reason: describeRpcError(err, engine.id).message,
        })
      ),
      exited.then((exit) => ({
        ok: false,
        reason: `${describeExit(exit)} during startup`,
      })),
      new Promise<Outcome>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              reason: `the engine did not complete the ACP handshake within ${HANDSHAKE_TIMEOUT_MS / 1000}s`,
            }),
          HANDSHAKE_TIMEOUT_MS
        ).unref?.()
      ),
    ]);
    if (!outcome.ok) {
      handshake.catch(() => {});
      signalChild(child, "SIGKILL");
      // A spawn failure aborts the handshake too, and that rejection can win
      // the race; the child's own exit reason is the useful one.
      const reason = settledExit
        ? `${describeExit(settledExit)} during startup`
        : outcome.reason;
      const tail = stderrTail.length ? `\n${stderrTail.join("\n")}` : "";
      throw new Error(`Agent connection failed: ${reason}${tail}`);
    }

    const entry: Live = {
      steeringSupported,
      turnOpen: false,
      steering: Promise.resolve(),
      engine: engine.id,
      child,
      conn,
      sessionId: outcome.session.sessionId,
      startedAt: new Date().toISOString(),
      firstPromptAppend: launch.firstPromptAppend ?? null,
      exited,
      stopping: false,
      cancelling: false,
      config,
      commands,
    };
    this.live.set(launch.agentId, entry);
    this.emit({
      type: "config",
      agentId: launch.agentId,
      options: config.options,
    });
    void exited.then((exit) => {
      if (this.live.get(launch.agentId) === entry) {
        this.live.delete(launch.agentId);
      }
      this.emit({
        type: "exit",
        agentId: launch.agentId,
        code: exit.code,
        signal: exit.signal,
        stderrTail: stderrTail.join("\n"),
        expected: entry.stopping,
      });
    });
    this.opts.logger.info(
      {
        agentId: launch.agentId,
        sessionId: entry.sessionId,
        resumed: outcome.session.resumed,
      },
      "acp session ready"
    );
    return outcome.session;
  }

  getConfigOptions(agentId: string): acp.SessionConfigOption[] | null {
    return this.live.get(agentId)?.config.options ?? null;
  }

  getSessionStartedAt(agentId: string): string | null {
    return this.live.get(agentId)?.startedAt ?? null;
  }

  getCommands(agentId: string): acp.AvailableCommand[] | null {
    return this.live.get(agentId)?.commands.list ?? null;
  }

  getPermissions(agentId: string): AgentPermissionRequest[] {
    return this.permissions.list(agentId);
  }

  supportsSteering(agentId: string): boolean {
    return this.live.get(agentId)?.steeringSupported ?? false;
  }

  /** A declined steer consumes nothing; the host still owns the next prompt. */
  steer(
    agentId: string,
    text: string,
    source?: PromptSource
  ): Promise<"injected" | "promptRequired"> {
    const entry = this.require(agentId);
    const request = entry.steering
      .catch(() => {})
      .then(async () => {
        if (!entry.steeringSupported || !entry.turnOpen || entry.cancelling)
          return "promptRequired" as const;
        const result = await entry.conn.extMethod("_session/steering", {
          sessionId: entry.sessionId,
          prompt: [{ type: "text", text }],
          _meta: { steering: { idleBehavior: "promptRequired" } },
        });
        if (result.outcome === "promptRequired")
          return "promptRequired" as const;
        if (result.outcome !== "injected") {
          throw new Error(
            `The agent did not confirm steering (${String(result.outcome)}).`
          );
        }
        this.emit({
          type: "steered",
          agentId,
          text,
          ...(source ? { source } : {}),
        });
        return "injected" as const;
      });
    entry.steering = request;
    return request;
  }

  answerPermission(
    agentId: string,
    requestId: string,
    optionId: string | null
  ): void {
    this.permissions.answer(agentId, requestId, optionId);
  }

  async setConfigOption(
    agentId: string,
    configId: string,
    value: string
  ): Promise<acp.SessionConfigOption[]> {
    const entry = this.require(agentId);
    try {
      const res = await entry.conn.setSessionConfigOption({
        sessionId: entry.sessionId,
        configId,
        value,
      });
      entry.config.options = res.configOptions ?? entry.config.options;
      this.emit({ type: "config", agentId, options: entry.config.options });
      return entry.config.options;
    } catch (err) {
      throw new Error(describeRpcError(err, entry.engine).message, {
        cause: err,
      });
    }
  }

  /**
   * Runs one turn; resolves when the agent settles it.
   *
   * `onAccepted` runs once the child is live and the request has been
   * handed to it. Nothing before that point reached the engine, so a
   * caller that records a prompt as delivered has to wait for this rather
   * than for the turn being queued.
   */
  async prompt(
    agentId: string,
    text: string,
    onAccepted?: () => void,
    source?: PromptSource
  ): Promise<void> {
    const entry = this.require(agentId);
    entry.cancelling = false;
    entry.turnOpen = true;
    // The model this turn runs on, as the engine publishes it now: a model
    // switched mid-session must not relabel the turns before it.
    const modelOption = entry.config.options.find(
      (o) => o.id === "model" || o.category === "model"
    );
    const model =
      modelOption && modelOption.type === "select"
        ? String(modelOption.currentValue)
        : null;
    this.emit({
      type: "turn",
      agentId,
      state: "started",
      text,
      ...(source ? { source } : {}),
      ...(model ? { model } : {}),
      sessionId: entry.sessionId,
    });
    // A child that exits mid-turn never answers the request; the pending
    // call would hang and hold the agent's turn slot for ever.
    let exited = false;
    const gone = entry.exited.then(() => {
      exited = true;
      throw new Error("the agent exited before the turn settled");
    });
    try {
      // ACP adapters recognize commands from the first text block and may
      // handle them without a model turn. Preserve raw slash prompts, and
      // keep the guidance for the next ordinary prompt instead of consuming
      // it on a command. Do not depend on the command list arriving first.
      const guidance = text.trimStart().startsWith("/")
        ? null
        : entry.firstPromptAppend;
      const dispatched = entry.conn.prompt({
        sessionId: entry.sessionId,
        prompt: [
          ...(guidance ? [{ type: "text" as const, text: guidance }] : []),
          { type: "text", text },
        ],
      });
      if (guidance) entry.firstPromptAppend = null;
      onAccepted?.();
      const res = await Promise.race([dispatched, gone]);
      entry.turnOpen = false;
      await entry.steering.catch(() => {});
      this.emit({
        type: "turn",
        agentId,
        state: "settled",
        stopReason: res.stopReason,
        ...(res.usage ? { usage: res.usage } : {}),
      });
    } catch (err) {
      entry.turnOpen = false;
      await entry.steering.catch(() => {});
      const { message, errorKind } = describeRpcError(err, entry.engine);
      // The exit event already settled the turn row; a second settle would
      // only add a duplicate status line.
      if (!exited) {
        this.emit({
          type: "turn",
          agentId,
          state: "settled",
          error: message,
          ...(errorKind ? { errorKind } : {}),
        });
      }
      throw new Error(message, { cause: err });
    } finally {
      this.permissions.cancel(agentId);
    }
  }

  async cancel(agentId: string): Promise<void> {
    const entry = this.require(agentId);
    entry.cancelling = true;
    this.permissions.cancel(agentId);
    await entry.conn.cancel({ sessionId: entry.sessionId });
  }

  /** Close the session, then walk stdin EOF, SIGTERM, SIGKILL until exit. */
  async stop(agentId: string): Promise<void> {
    const entry = this.live.get(agentId);
    if (!entry) return;
    entry.stopping = true;
    this.permissions.cancel(agentId);
    try {
      await Promise.race([
        entry.conn.closeSession({ sessionId: entry.sessionId }),
        new Promise((resolve) => setTimeout(resolve, TEARDOWN_STEP_MS)),
      ]);
    } catch (err) {
      this.opts.logger.debug(
        { err, agentId },
        "acp session close failed; continuing teardown"
      );
    }
    const exitedWithin = (ms: number) =>
      Promise.race([
        entry.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);
    entry.child.stdin?.end();
    if (!(await exitedWithin(TEARDOWN_STEP_MS)))
      signalChild(entry.child, "SIGTERM");
    if (!(await exitedWithin(TEARDOWN_STEP_MS)))
      signalChild(entry.child, "SIGKILL");
    await entry.exited;
    this.live.delete(agentId);
  }

  /**
   * SIGKILL every child still live and forget it, without waiting for an
   * exit. The last step of a bounded shutdown: an engine child holds
   * full-access permissions and a live MCP token, the installed service unit
   * uses KillMode=process, and the caller is about to call process.exit(),
   * which would drop a kill the ladder had only just started. Synchronous on
   * purpose, so no await can be cut short between the signal and the exit.
   */
  killAll(): string[] {
    const killed: string[] = [];
    for (const [agentId, entry] of this.live) {
      this.permissions.cancel(agentId);
      try {
        signalChild(entry.child, "SIGKILL");
        killed.push(agentId);
      } catch (err) {
        this.opts.logger.warn(
          { err, agentId },
          "acp child could not be killed at shutdown"
        );
      }
    }
    this.live.clear();
    return killed;
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.opts.logger.warn({ err }, "acp driver listener threw");
      }
    }
  }

  private require(agentId: string): Live {
    const entry = this.live.get(agentId);
    if (!entry) throw new Error(`the agent is not running for ${agentId}`);
    return entry;
  }
}
