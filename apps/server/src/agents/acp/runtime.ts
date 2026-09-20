import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";
import type { DriverEvent } from "./driver.js";
import type {
  AgentRuntime,
  RuntimeEventListener,
  RuntimeLaunch,
} from "../runtime.js";
import { HostClient } from "./host-client.js";
import { type HostLaunch, hostFile, type JournalEntry } from "./host-protocol.js";

/** The engine's ACP handshake can take a while on a cold adapter. */
const LAUNCH_TIMEOUT_MS = 60_000;
const ATTACH_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 8_000;
const KILL_GRACE_MS = 2_000;
const LOG_TAIL_LINES = 20;

/**
 * The command that runs the host: the same executable as the server. Under
 * `bun src/main.ts` that is bun plus the script; a compiled binary is
 * itself. `DISPATCH_AGENT_HOST_COMMAND` (JSON array or whitespace-separated)
 * overrides both, for tests and e2e.
 */
export function hostCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.DISPATCH_AGENT_HOST_COMMAND;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Not JSON: a plain command line.
    }
    return override.split(/\s+/).filter(Boolean);
  }
  const script = process.argv[1];
  if (script && /\.[cm]?[jt]s$/.test(script) && existsSync(script)) {
    return [process.execPath, script, "agent-host"];
  }
  return [process.execPath, "agent-host"];
}

/**
 * Wrap a command so it runs through the user's login shell: the host, and
 * so the engine, gets the PATH, ssh agent and tool config the user's own
 * shell has.
 */
export function loginShellCommand(
  command: string[],
  shell = process.env.SHELL || "/bin/bash"
): { bin: string; args: string[] } {
  const base = path.basename(shell);
  // ~/.dispatch/env is the documented place for agent-session overrides;
  // it is read after the profile so it wins.
  const posix = '[ -f "$HOME/.dispatch/env" ] && . "$HOME/.dispatch/env"; exec "$@"';
  if (base === "fish") {
    return {
      bin: shell,
      args: [
        "-lc",
        'test -f "$HOME/.dispatch/env"; and source "$HOME/.dispatch/env"; exec $argv',
        ...command,
      ],
    };
  }
  if (base === "bash" || base === "zsh" || base === "sh") {
    return { bin: shell, args: ["-lc", posix, "dispatch-agent-host", ...command] };
  }
  return { bin: "/bin/bash", args: ["-lc", posix, "dispatch-agent-host", ...command] };
}

/** What the host must not inherit from the server process. */
const ENV_DENY_EXACT = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "PGPASSWORD",
  "PGUSER",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "MEDIA_ROOT",
  "TLS_CERT",
  "TLS_KEY",
  "TLS_CA",
]);

function hostProcessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ENV_DENY_EXACT.has(key) || key.startsWith("DISPATCH_")) continue;
    env[key] = value;
  }
  return env;
}

async function readPid(stateDir: string): Promise<number | null> {
  try {
    const text = await readFile(hostFile(stateDir, "pid"), "utf8");
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

type Live = {
  client: HostClient;
  /** Prompts run one at a time, in order. */
  queue: Promise<void>;
  pending: number;
  turnOpen: boolean;
  /** Event handling is serialized per agent so rows land in seq order. */
  events: Promise<void>;
  lastSeq: number;
  /** Resolvers for turns waiting on their settle event. */
  settleWaiters: Array<() => void>;
};

export type AcpRuntimeDeps = {
  config: Pick<
    AppConfig,
    "agentStateRoot" | "agentRuntime" | "dispatchBinDir"
  >;
  logger: FastifyBaseLogger;
  /** The last journal seq the server applied for this agent (agents.host_seq). */
  hostSeq: (agentId: string) => Promise<number>;
};

/**
 * One host process per agent, connected over its Unix socket. The manager
 * only ever sees this interface; the host protocol and the state directory
 * are this module's business. See docs/design/acp-runtime.md.
 */
export function createAcpRuntime(deps: AcpRuntimeDeps): AgentRuntime {
  const { config, logger } = deps;
  // Assigned below; launch() refers back to it to tear down a failed host.
  let runtime: AgentRuntime;
  const live = new Map<string, Live>();
  const listeners = new Set<RuntimeEventListener>();

  const stateDir = (agentId: string) =>
    path.join(config.agentStateRoot, agentId);

  function dispatchEntry(agentId: string, entry: Live, journal: JournalEntry) {
    if (journal.seq <= entry.lastSeq) return; // replayed, already applied
    entry.lastSeq = journal.seq;
    emit(agentId, entry, journal.event, journal.seq);
  }

  /** Seq 0 marks an event the server made up (a host that vanished). */
  function emit(agentId: string, entry: Live, event: DriverEvent, seq: number) {
    if (event.type === "turn") {
      entry.turnOpen = event.state === "started";
      if (event.state === "settled") {
        const waiters = entry.settleWaiters;
        entry.settleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
    if (event.type === "exit") {
      entry.turnOpen = false;
      const waiters = entry.settleWaiters;
      entry.settleWaiters = [];
      for (const resolve of waiters) resolve();
    }
    entry.events = entry.events
      .catch(() => {})
      .then(async () => {
        for (const listener of listeners) {
          try {
            await listener(agentId, event, seq);
          } catch (err) {
            logger.warn({ err, agentId }, "runtime event listener failed");
          }
        }
      });
  }

  async function connect(
    agentId: string,
    timeoutMs: number,
    abandoned: () => boolean = () => false
  ): Promise<Live> {
    const existing = live.get(agentId);
    if (existing) return existing;
    const lastSeq = await deps.hostSeq(agentId);
    const entry: Live = {
      client: null as unknown as HostClient,
      queue: Promise.resolve(),
      pending: 0,
      turnOpen: false,
      events: Promise.resolve(),
      lastSeq,
      settleWaiters: [],
    };
    entry.client = new HostClient({
      agentId,
      socketPath: hostFile(stateDir(agentId), "socket"),
      logger,
      fromSeq: () => entry.lastSeq,
      onEvent: (journal) => dispatchEntry(agentId, entry, journal),
      onWelcome: (welcome) => {
        entry.turnOpen = welcome.turn !== null;
      },
      onGone: (reason) => {
        logger.warn({ agentId, reason }, "agent host is gone");
        live.delete(agentId);
        entry.client.close();
        const waiters = entry.settleWaiters;
        entry.settleWaiters = [];
        for (const resolve of waiters) resolve();
        emit(
          agentId,
          entry,
          {
            type: "exit",
            agentId,
            code: null,
            signal: null,
            stderrTail: reason,
            expected: false,
          },
          0
        );
      },
    });
    live.set(agentId, entry);
    try {
      await entry.client.connect(timeoutMs, abandoned);
    } catch (err) {
      live.delete(agentId);
      entry.client.close();
      throw err;
    }
    return entry;
  }

  async function readLogTail(agentId: string): Promise<string> {
    try {
      const log = await readFile(hostFile(stateDir(agentId), "log"), "utf8");
      const tail = log.trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
      return tail ? `\n\nHost log (last ${LOG_TAIL_LINES} lines):\n${tail}` : "";
    } catch {
      return "";
    }
  }

  runtime = {
    tracksProcesses: () => true,

    async launch(input) {
      const dir = stateDir(input.agentId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const launch: HostLaunch = {
        agentId: input.agentId,
        cwd: input.cwd,
        engine: input.engine,
        bins: input.bins,
        model: input.model,
        systemPrompt: input.systemPrompt,
        mcp: input.mcp,
        env: input.env,
        pathPrefix: input.pathPrefix,
        resumeSessionId: input.resumeSessionId,
      };
      await writeFile(hostFile(dir, "launch"), JSON.stringify(launch, null, 2), {
        mode: 0o600,
      });
      // A stale socket from a dead host would make connect() spin on
      // ECONNREFUSED until the new host replaces it; clear it first.
      await unlink(hostFile(dir, "socket")).catch(() => {});
      const logFd = openSync(hostFile(dir, "log"), "a");
      const { bin, args } = loginShellCommand([
        ...hostCommand(),
        "--state",
        dir,
      ]);
      const child = spawn(bin, args, {
        cwd: input.cwd,
        env: hostProcessEnv(process.env),
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      // The shell execs the host, so this is the host's own exit; a host
      // that dies during startup fails the launch at once instead of after
      // the whole connect timeout.
      let exited = false;
      child.on("exit", () => {
        exited = true;
      });
      child.on("error", (err) => {
        exited = true;
        logger.error({ err, agentId: input.agentId }, "agent host spawn failed");
      });
      child.unref();
      logger.info(
        { agentId: input.agentId, pid: child.pid, bin, args: args.slice(0, 3) },
        "agent host spawned"
      );
      try {
        const entry = await connect(
          input.agentId,
          LAUNCH_TIMEOUT_MS,
          () => exited
        );
        const welcome = entry.client.welcome;
        if (!welcome) throw new Error("no welcome from the agent host");
        return { sessionId: welcome.sessionId, resumed: welcome.resumed };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const tail = await readLogTail(input.agentId);
        // A host whose engine never came up has nothing to serve.
        await runtime.stop(input.agentId, true).catch(() => {});
        throw new Error(`${message}${tail}`);
      }
    },

    async attach(agentId) {
      if (live.has(agentId)) return true;
      const dir = stateDir(agentId);
      const pid = await readPid(dir);
      if (!pid || !pidAlive(pid)) return false;
      try {
        await connect(agentId, ATTACH_TIMEOUT_MS);
        return true;
      } catch (err) {
        logger.warn({ err, agentId }, "could not attach to the agent host");
        return false;
      }
    },

    async isAlive(agentId) {
      const entry = live.get(agentId);
      if (entry?.client.isConnected()) return true;
      const pid = await readPid(stateDir(agentId));
      return pid !== null && pidAlive(pid);
    },

    prompt(agentId, text) {
      const entry = live.get(agentId);
      if (!entry) {
        const err = new Error("The agent is not running; the prompt cannot be delivered.");
        return { accepted: Promise.reject(err), settled: Promise.reject(err) };
      }
      let resolveAccepted!: () => void;
      let rejectAccepted!: (err: Error) => void;
      const accepted = new Promise<void>((resolve, reject) => {
        resolveAccepted = resolve;
        rejectAccepted = reject;
      });
      entry.pending += 1;
      const settled = entry.queue
        .catch(() => {})
        .then(async () => {
          // Wait out a turn the engine started before this prompt was queued
          // (a reconnect mid-turn), then run ours and wait for its settle.
          while (entry.turnOpen) {
            await new Promise<void>((resolve) => entry.settleWaiters.push(resolve));
          }
          const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          let resolveSettle!: () => void;
          const settle = new Promise<void>((resolve) => {
            resolveSettle = resolve;
          });
          entry.settleWaiters.push(resolveSettle);
          try {
            await entry.client.prompt(id, text);
          } catch (err) {
            entry.settleWaiters = entry.settleWaiters.filter(
              (w) => w !== resolveSettle
            );
            throw err;
          }
          entry.turnOpen = true;
          resolveAccepted();
          await settle;
        })
        .finally(() => {
          entry.pending -= 1;
        });
      entry.queue = settled.catch(() => {});
      settled.catch((err: Error) => rejectAccepted(err));
      accepted.catch(() => {});
      return { accepted, settled };
    },

    isBusy(agentId) {
      const entry = live.get(agentId);
      return entry ? entry.turnOpen || entry.pending > 0 : false;
    },

    async cancel(agentId) {
      const entry = live.get(agentId);
      if (!entry) return;
      entry.client.cancel();
    },

    async stop(agentId, force) {
      const dir = stateDir(agentId);
      const entry = live.get(agentId);
      const pid = await readPid(dir);
      if (entry) {
        live.delete(agentId);
        try {
          entry.client.shutdown(force);
        } catch {
          // Not connected; fall through to the signal.
        }
      }
      if (pid && pidAlive(pid)) {
        const deadline = Date.now() + (force ? 0 : STOP_GRACE_MS);
        while (Date.now() < deadline && pidAlive(pid)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (pidAlive(pid)) {
          signalGroup(pid, "SIGTERM");
          const killAt = Date.now() + KILL_GRACE_MS;
          while (Date.now() < killAt && pidAlive(pid)) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (pidAlive(pid)) signalGroup(pid, "SIGKILL");
        }
      }
      entry?.client.close();
      await unlink(hostFile(dir, "socket")).catch(() => {});
      await unlink(hostFile(dir, "pid")).catch(() => {});
    },

    async listHosted() {
      let ids: string[] = [];
      try {
        ids = await readdir(config.agentStateRoot);
      } catch {
        return [];
      }
      const hosted: string[] = [];
      for (const id of ids) {
        if (!id.startsWith("agt_")) continue;
        const pid = await readPid(stateDir(id));
        if (pid && pidAlive(pid)) hosted.push(id);
      }
      return hosted;
    },

    async hostPid(agentId) {
      const pid = await readPid(stateDir(agentId));
      return pid && pidAlive(pid) ? pid : null;
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    readLogTail,

    async discard(agentId) {
      const entry = live.get(agentId);
      if (entry) {
        live.delete(agentId);
        entry.client.close();
      }
      await rm(stateDir(agentId), { recursive: true, force: true });
    },
  };
  return runtime;
}
