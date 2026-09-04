import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * The ACP client for DeepSeek Harness. One `dsh --profile acp` child per
 * Dispatch agent; this module is the only place in the server that speaks
 * the protocol. Everything downstream consumes {@link DriverEvent}s.
 */

export type DriverUpdate = acp.SessionUpdate;
export type DriverUsage = acp.Usage;

export type DriverLaunch = {
  agentId: string;
  cwd: string;
  /** The per-agent `--patch` overlay (see overlay.ts). */
  overlayPath: string;
  /** Dispatch's streamable HTTP MCP endpoint for this agent. */
  mcp: { url: string; token: string };
  /** Resume this ACP session when set; otherwise create one. */
  sessionId: string | null;
  env: NodeJS.ProcessEnv;
};

export type DriverEvent =
  | { type: "update"; agentId: string; update: DriverUpdate }
  | { type: "turn"; agentId: string; state: "started" }
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

type Live = {
  child: ChildProcessLike;
  conn: acp.ClientSideConnection;
  sessionId: string;
  stderrTail: string[];
  exited: Promise<{ code: number | null; signal: string | null }>;
};

const STDERR_TAIL_LINES = 20;
const TEARDOWN_STEP_MS = 1_500;

/**
 * The ACP SDK reports an agent-side exception as JSON-RPC "Internal error"
 * and keeps the real message in `data.details` (dsh itself does the same
 * for a failed turn), so surface that detail instead of the bare code.
 */
export function describeRpcError(err: unknown): string {
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

function defaultSpawn(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
): ChildProcessLike {
  return nodeSpawn(bin, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
}

export class DshDriver {
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Set<DriverListener>();
  private readonly spawnFn: SpawnFn;

  constructor(
    private readonly opts: {
      dshBin: string;
      dshHome: string;
      spawn?: SpawnFn;
      logger: DriverLogger;
    }
  ) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
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

  async start(launch: DriverLaunch): Promise<{ sessionId: string }> {
    if (this.live.has(launch.agentId)) {
      throw new Error(`dsh already running for ${launch.agentId}`);
    }
    const child = this.spawnFn(
      this.opts.dshBin,
      ["--profile", "acp", "--patch", launch.overlayPath],
      {
        cwd: launch.cwd,
        env: {
          ...launch.env,
          DSH_HOME: this.opts.dshHome,
          DSH_PERMISSION_MODE: "danger-full-access",
        },
      }
    );
    const stderrTail: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.on("exit", (code, signal) =>
          resolve({ code, signal: signal ?? null })
        );
      }
    );

    const client: acp.Client = {
      sessionUpdate: async (params) => {
        this.emit({
          type: "update",
          agentId: launch.agentId,
          update: params.update,
        });
      },
      // Permission prompts never fire under danger-full-access; if one does,
      // allow it once rather than wedge the turn.
      requestPermission: async (params) => {
        const allow =
          params.options.find((o) => o.kind === "allow_once") ??
          params.options[0];
        return {
          outcome: { outcome: "selected", optionId: allow.optionId },
        };
      },
    };
    if (!child.stdin || !child.stdout) {
      child.kill("SIGKILL");
      throw new Error("dsh start failed: child has no stdio pipes");
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout)
    );
    const conn = new acp.ClientSideConnection(() => client, stream);

    try {
      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
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
      let sessionId: string;
      if (launch.sessionId) {
        await conn.resumeSession({
          sessionId: launch.sessionId,
          cwd: launch.cwd,
          mcpServers,
        });
        sessionId = launch.sessionId;
      } else {
        const res = await conn.newSession({ cwd: launch.cwd, mcpServers });
        sessionId = res.sessionId;
      }
      const entry: Live = { child, conn, sessionId, stderrTail, exited };
      this.live.set(launch.agentId, entry);
      void exited.then(({ code, signal }) => {
        if (this.live.get(launch.agentId) === entry) {
          this.live.delete(launch.agentId);
        }
        this.emit({
          type: "exit",
          agentId: launch.agentId,
          code,
          signal,
          stderrTail: stderrTail.join("\n"),
        });
      });
      this.opts.logger.info(
        { agentId: launch.agentId, sessionId, resumed: !!launch.sessionId },
        "dsh session ready"
      );
      return { sessionId };
    } catch (err) {
      child.kill("SIGKILL");
      const tail = stderrTail.length ? `\n${stderrTail.join("\n")}` : "";
      throw new Error(`dsh start failed: ${describeRpcError(err)}${tail}`, {
        cause: err,
      });
    }
  }

  /** Runs one turn; resolves when the agent settles it. */
  async prompt(agentId: string, text: string): Promise<void> {
    const entry = this.require(agentId);
    this.emit({ type: "turn", agentId, state: "started" });
    try {
      const res = await entry.conn.prompt({
        sessionId: entry.sessionId,
        prompt: [{ type: "text", text }],
      });
      this.emit({
        type: "turn",
        agentId,
        state: "settled",
        stopReason: res.stopReason,
        ...(res.usage ? { usage: res.usage } : {}),
      });
    } catch (err) {
      const message = describeRpcError(err);
      this.emit({ type: "turn", agentId, state: "settled", error: message });
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
    try {
      await Promise.race([
        entry.conn.closeSession({ sessionId: entry.sessionId }),
        new Promise((resolve) => setTimeout(resolve, TEARDOWN_STEP_MS)),
      ]);
    } catch (err) {
      this.opts.logger.debug(
        { err, agentId },
        "dsh session close failed; continuing teardown"
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
        this.opts.logger.warn({ err }, "dsh driver listener threw");
      }
    }
  }

  private require(agentId: string): Live {
    const entry = this.live.get(agentId);
    if (!entry) throw new Error(`dsh is not running for ${agentId}`);
    return entry;
  }
}
