import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { EngineSpec } from "./agent-spec.js";

/**
 * The ACP client for the Dispatch Harness. One child per Dispatch agent,
 * spawned from the agent's engine spec; this module is the only place in
 * the server that speaks the protocol. Everything downstream consumes
 * {@link DriverEvent}s.
 */

export type DriverUpdate = acp.SessionUpdate;
export type DriverUsage = acp.Usage;

export type DriverLaunch = {
  agentId: string;
  cwd: string;
  /** What to spawn and how it takes persona, full access, and subagents. */
  engine: EngineSpec;
  /** The persona, for an engine whose spec says `system_prompt`; null otherwise. */
  systemPromptAppend: string | null;
  /** Dispatch's streamable HTTP MCP endpoint for this agent. */
  mcp: { url: string; token: string };
  /** Resume this ACP session when set; falls back to a new one if the engine lost it. */
  sessionId: string | null;
  env: NodeJS.ProcessEnv;
};

export type DriverEvent =
  | { type: "update"; agentId: string; update: DriverUpdate }
  | { type: "turn"; agentId: string; state: "started"; text: string }
  | {
      type: "turn";
      agentId: string;
      state: "settled";
      stopReason?: acp.StopReason;
      /** Cumulative session usage reported with the prompt response. */
      usage?: DriverUsage;
      error?: string;
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
  "stdin" | "stdout" | "stderr" | "on" | "kill" | "killed"
>;

export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcessLike;

type ExitInfo = { code: number | null; signal: string | null; error?: Error };

type Live = {
  child: ChildProcessLike;
  conn: acp.ClientSideConnection;
  sessionId: string;
  stderrTail: string[];
  exited: Promise<ExitInfo>;
  /** Set at the top of stop(): the exit that follows is expected. */
  stopping: boolean;
  /** Session config options (model, reasoning effort) as the engine last reported. */
  config: { options: acp.SessionConfigOption[] };
  /** Slash commands as the engine last advertised them; a holder shared with the update handler, like `config`. */
  commands: { list: acp.AvailableCommand[] };
};

const STDERR_TAIL_LINES = 20;
const TEARDOWN_STEP_MS = 1_500;
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * The ACP SDK reports an agent-side exception as JSON-RPC "Internal error"
 * and keeps the real message in `data.details` (the harness itself does the
 * same for a failed turn), so surface that detail instead of the bare code.
 */
function describeRpcError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const data = (err as { data?: unknown }).data;
  let detail: string | null = null;
  if (typeof data === "string") detail = data;
  else if (data && typeof data === "object") {
    const details = (data as { details?: unknown }).details;
    if (typeof details === "string") detail = details;
    else if (Object.keys(data).length > 0) detail = JSON.stringify(data);
  }
  return detail && !err.message.includes(detail)
    ? `${err.message}: ${detail}`
    : err.message;
}

/**
 * Find the engine's executable before spawning, so a missing binary is a
 * clear message on the agent instead of a spawn error. The server resolves
 * it with its own PATH (launchd/systemd), not the user's login shell, so
 * the message points at the setting to fix.
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
    if (!dir) continue;
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
  return nodeSpawn(bin, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
}

function describeExit(exit: ExitInfo): string {
  if (exit.error) {
    const code = (exit.error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? `the harness could not be spawned (${exit.error.message})`
      : exit.error.message;
  }
  return exit.code === null
    ? `the harness exited on signal ${exit.signal}`
    : `the harness exited with code ${exit.code}`;
}

export class HarnessDriver {
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
      /** Injectable for tests that spawn a fake; defaults to a PATH lookup. */
      resolveBinary?: (bin: string, env: NodeJS.ProcessEnv) => Promise<string>;
      logger: DriverLogger;
    }
  ) {
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
      throw new Error(`the harness is already running for ${launch.agentId}`);
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
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });

    const config = { options: [] as acp.SessionConfigOption[] };
    const commands: { list: acp.AvailableCommand[] } = { list: [] };
    const client: acp.Client = {
      sessionUpdate: async (params) => {
        if (params.update.sessionUpdate === "config_option_update") {
          config.options = params.update.configOptions ?? [];
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
      // An engine that asks per call (OpenCode) gets the allow option; the
      // others never ask under the full access their spec grants. With no
      // allow option, end the call cleanly rather than pick at random.
      requestPermission: async (params) => {
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
      child.kill("SIGKILL");
      throw new Error("harness start failed: child has no stdio pipes");
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout)
    );
    const conn = new acp.ClientSideConnection(() => client, stream);

    const sessionMeta = launch.systemPromptAppend
      ? { _meta: { systemPrompt: { append: launch.systemPromptAppend } } }
      : {};
    const handshake = (async () => {
      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          ...(engine.subagentTranscripts
            ? { _meta: { "subagent-transcript": true } }
            : {}),
        },
      });
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
      if (engine.fullAccess.kind === "set_mode") {
        try {
          await conn.setSessionMode({
            sessionId: session.sessionId,
            modeId: engine.fullAccess.modeId,
          });
        } catch (err) {
          this.opts.logger.warn(
            { err, agentId: launch.agentId, modeId: engine.fullAccess.modeId },
            "the engine refused the full-access mode; continuing with its default"
          );
        }
      }
      return session;
    })();

    type Outcome =
      | { ok: true; session: { sessionId: string; resumed: boolean } }
      | { ok: false; reason: string };
    const outcome = await Promise.race<Outcome>([
      handshake.then(
        (session) => ({ ok: true, session }),
        (err) => ({ ok: false, reason: describeRpcError(err) })
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
      child.kill("SIGKILL");
      // A spawn failure aborts the handshake too, and that rejection can win
      // the race; the child's own exit reason is the useful one.
      const reason = settledExit
        ? `${describeExit(settledExit)} during startup`
        : outcome.reason;
      const tail = stderrTail.length ? `\n${stderrTail.join("\n")}` : "";
      throw new Error(`harness start failed: ${reason}${tail}`);
    }

    const entry: Live = {
      child,
      conn,
      sessionId: outcome.session.sessionId,
      stderrTail,
      exited,
      stopping: false,
      config,
      commands,
    };
    this.live.set(launch.agentId, entry);
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
      "harness session ready"
    );
    return outcome.session;
  }

  /** The session's config options as last reported; null when not running. */
  getConfigOptions(agentId: string): acp.SessionConfigOption[] | null {
    return this.live.get(agentId)?.config.options ?? null;
  }

  /** The slash commands the engine advertised; null when not running. */
  getCommands(agentId: string): acp.AvailableCommand[] | null {
    return this.live.get(agentId)?.commands.list ?? null;
  }

  /** Apply one session config option (model, reasoning effort) to later turns. */
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
      return entry.config.options;
    } catch (err) {
      throw new Error(describeRpcError(err), { cause: err });
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
    onAccepted?: () => void
  ): Promise<void> {
    const entry = this.require(agentId);
    this.emit({ type: "turn", agentId, state: "started", text });
    // A child that exits mid-turn never answers the request; the pending
    // call would hang and hold the agent's turn slot for ever.
    let exited = false;
    const gone = entry.exited.then(() => {
      exited = true;
      throw new Error("the harness exited before the turn settled");
    });
    try {
      const dispatched = entry.conn.prompt({
        sessionId: entry.sessionId,
        prompt: [{ type: "text", text }],
      });
      onAccepted?.();
      const res = await Promise.race([dispatched, gone]);
      this.emit({
        type: "turn",
        agentId,
        state: "settled",
        stopReason: res.stopReason,
        ...(res.usage ? { usage: res.usage } : {}),
      });
    } catch (err) {
      const message = describeRpcError(err);
      // The exit event already settled the turn row; a second settle would
      // only add a duplicate status line.
      if (!exited) {
        this.emit({ type: "turn", agentId, state: "settled", error: message });
      }
      throw new Error(message, { cause: err });
    }
  }

  async cancel(agentId: string): Promise<void> {
    const entry = this.require(agentId);
    await entry.conn.cancel({ sessionId: entry.sessionId });
  }

  /** Close the session, then walk stdin EOF, SIGTERM, SIGKILL until exit. */
  async stop(agentId: string): Promise<void> {
    const entry = this.live.get(agentId);
    if (!entry) return;
    entry.stopping = true;
    try {
      await Promise.race([
        entry.conn.closeSession({ sessionId: entry.sessionId }),
        new Promise((resolve) => setTimeout(resolve, TEARDOWN_STEP_MS)),
      ]);
    } catch (err) {
      this.opts.logger.debug(
        { err, agentId },
        "harness session close failed; continuing teardown"
      );
    }
    const exitedWithin = (ms: number) =>
      Promise.race([
        entry.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);
    entry.child.stdin?.end();
    if (!(await exitedWithin(TEARDOWN_STEP_MS))) entry.child.kill("SIGTERM");
    if (!(await exitedWithin(TEARDOWN_STEP_MS))) entry.child.kill("SIGKILL");
    await entry.exited;
    this.live.delete(agentId);
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.opts.logger.warn({ err }, "harness driver listener threw");
      }
    }
  }

  private require(agentId: string): Live {
    const entry = this.live.get(agentId);
    if (!entry) throw new Error(`the harness is not running for ${agentId}`);
    return entry;
  }
}
