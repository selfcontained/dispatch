import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";
import type {
  AvailableCommand,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";

import type { AppConfig } from "../../config.js";
import type { DriverEvent } from "./driver.js";
import type { PromptSource } from "./prompt-source.js";
import type {
  AgentRuntime,
  RuntimeEventListener,
  RuntimeLaunch,
} from "../runtime.js";
import { HostClient } from "./host-client.js";
import {
  type HostLaunch,
  hostFile,
  type JournalEntry,
} from "./host-protocol.js";

/** The engine's ACP handshake can take a while on a cold adapter. */
const LAUNCH_TIMEOUT_MS = 60_000;
const ATTACH_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 8_000;
const KILL_GRACE_MS = 2_000;
const LOG_TAIL_LINES = 20;

/**
 * Posts that queued up behind a turn go to the agent together, as one
 * prompt, rather than one turn apiece. A backlog longer than this carries
 * on into the next turn: nothing is dropped, and no prompt grows without
 * bound. One post larger than the size cap still goes, on its own.
 */
export const COMBINE_MAX_PROMPTS = 8;
export const COMBINE_MAX_CHARS = 32_000;

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
  return selfCommand("agent-host");
}

/**
 * This executable plus one of its modes. Under `bun src/main.ts` that is bun
 * plus the script; a compiled binary is itself. Both the agent host and the
 * bundled ACP adapters are modes of this binary, so both are spawned this way.
 */
export function selfCommand(mode: string): string[] {
  const script = process.argv[1];
  if (script && /\.[cm]?[jt]s$/.test(script) && existsSync(script)) {
    return [process.execPath, script, mode];
  }
  return [process.execPath, mode];
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
  const posix =
    '[ -f "$HOME/.dispatch/env" ] && . "$HOME/.dispatch/env"; exec "$@"';
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
    return {
      bin: shell,
      args: ["-lc", posix, "dispatch-agent-host", ...command],
    };
  }
  return {
    bin: "/bin/bash",
    args: ["-lc", posix, "dispatch-agent-host", ...command],
  };
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
  "DISPATCH_FILES_ROOT",
  "TLS_CERT",
  "TLS_KEY",
  "TLS_CA",
]);

/** The fake ACP adapter test seam must reach the detached host process. */
const ENV_ALLOW_DISPATCH = new Set(["DISPATCH_ACP_ADAPTER_COMMAND"]);

export function hostProcessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (
      ENV_DENY_EXACT.has(key) ||
      (key.startsWith("DISPATCH_") && !ENV_ALLOW_DISPATCH.has(key))
    )
      continue;
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

/** A prompt waiting for the turn ahead of it to settle. */
type Waiting = {
  text: string;
  source?: PromptSource;
  /** Not to be combined with others: an interrupting post, a job's nudge. */
  alone: boolean;
  /** The turn that took it, once one has; later jobs for it just wait on it. */
  taken: boolean;
  delivery: "auto" | "queue";
  resolveSettled: () => void;
  resolveAccepted: () => void;
  rejectAccepted: (error: Error) => void;
  cancelled: boolean;
};

type Live = {
  client: HostClient;
  commands: AvailableCommand[];
  configOptions: SessionConfigOption[];
  /** Serializes submission/acceptance, not the lifetime of a turn. */
  pumping: boolean;
  /** Prompts not yet sent, oldest first. */
  waiting: Waiting[];
  pending: number;
  turnOpen: boolean;
  /** Event handling is serialized per agent so rows land in seq order. */
  events: Promise<void>;
  lastSeq: number;
  journalId: string | null;
  /** Resolvers for turns waiting on their settle event. */
  settleWaiters: Array<() => void>;
};

/**
 * The prompts the next turn sends, removed from the front of the queue: the
 * oldest alone if it must go alone, otherwise it and the posts right behind
 * it, up to the caps. Order is kept: the batch stops at the first prompt
 * that cannot join it.
 */
function takeBatch(waiting: Waiting[]): Waiting[] {
  const batch = [waiting.shift()!];
  if (batch[0]!.alone) return batch;
  let size = batch[0]!.text.length;
  while (batch.length < COMBINE_MAX_PROMPTS) {
    const next = waiting[0];
    if (!next || next.alone) break;
    size += next.text.length + COMBINED_SEPARATOR.length;
    if (size + combinedPreamble(batch.length + 1).length > COMBINE_MAX_CHARS) {
      break;
    }
    batch.push(waiting.shift()!);
  }
  return batch;
}

const COMBINED_SEPARATOR = "\n\n";

function combinedPreamble(count: number): string {
  return `${count} posts arrived while you were busy. Each is a separate message with its own envelope; read them all, then answer each one as it needs.\n\n`;
}

/**
 * One prompt for the batch. A single prompt goes as it came; several go as
 * their envelopes in order, and the turn names the first post as its
 * opener along with every post it carries.
 */
function combine(batch: Waiting[]): { text: string; source?: PromptSource } {
  if (batch.length === 1) {
    const [only] = batch;
    return {
      text: only!.text,
      ...(only!.source ? { source: only!.source } : {}),
    };
  }
  const ids = batch.map((w) =>
    w.source?.source === "chat" ? w.source.chatMessageId : ""
  );
  return {
    text:
      combinedPreamble(batch.length) +
      batch.map((w) => w.text).join(COMBINED_SEPARATOR),
    source: { source: "chat", chatMessageId: ids[0]!, chatMessageIds: ids },
  };
}

export type AcpRuntimeDeps = {
  config: Pick<AppConfig, "agentStateRoot" | "agentRuntime" | "dispatchBinDir">;
  logger: FastifyBaseLogger;
  /** The journal position last applied for this agent. */
  hostSeq: (
    agentId: string
  ) => Promise<{ seq: number; journalId: string | null }>;
  /** Persist a new journal identity and reset its sequence watermark. */
  syncJournal: (
    agentId: string,
    journalId: string | null,
    reset: boolean
  ) => Promise<void>;
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

  async function syncJournal(
    agentId: string,
    entry: Live,
    journalId: string | null,
    reset: boolean
  ): Promise<void> {
    while (live.get(agentId) === entry) {
      try {
        await deps.syncJournal(agentId, journalId, reset);
        return;
      } catch (err) {
        logger.warn(
          { err, agentId, journalId },
          "could not sync agent host journal; retrying before replay"
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  function failWaiting(entry: Live, error: Error) {
    for (const w of entry.waiting.splice(0)) {
      w.rejectAccepted(error);
      w.resolveSettled();
    }
  }

  /** Submit input one request at a time while allowing steering during a turn. */
  async function pump(agentId: string, entry: Live): Promise<void> {
    if (entry.pumping || live.get(agentId) !== entry) return;
    entry.pumping = true;
    try {
      while (entry.waiting.length && live.get(agentId) === entry) {
        const steering = entry.turnOpen;
        let batch: Waiting[];
        if (steering) {
          if (!entry.client.welcome?.steeringSupported) break;
          const index = entry.waiting.findIndex((w) => w.delivery === "auto");
          if (index < 0) break;
          batch = entry.waiting.splice(index, 1);
        } else {
          batch = takeBatch(entry.waiting);
        }
        for (const w of batch) w.taken = true;
        const { text, source } = combine(batch);
        const id = crypto.randomUUID();
        let ended = false;
        let accepted = false;
        const onSettle = () => {
          ended = true;
          if (accepted) for (const w of batch) w.resolveSettled();
        };
        entry.settleWaiters.push(onSettle);
        try {
          if (steering) {
            const outcome = await entry.client.steer(id, text, source);
            if (outcome === "promptRequired") {
              // The engine won the idle race. The message was not consumed;
              // wait for its terminal event, then start an ordinary tracked turn.
              entry.settleWaiters = entry.settleWaiters.filter(
                (w) => w !== onSettle
              );
              for (const w of batch) {
                w.taken = false;
                w.delivery = "queue";
              }
              entry.waiting.unshift(...batch);
              continue;
            }
          } else {
            // Set this before submitting: ack and settle can arrive together.
            entry.turnOpen = true;
            await entry.client.prompt(id, text, source);
          }
          accepted = true;
          for (const w of batch) {
            w.resolveAccepted();
            if (ended) w.resolveSettled();
          }
        } catch (error) {
          entry.settleWaiters = entry.settleWaiters.filter(
            (w) => w !== onSettle
          );
          if (!steering) entry.turnOpen = false;
          for (const w of batch) {
            w.rejectAccepted(
              error instanceof Error ? error : new Error(String(error))
            );
            w.resolveSettled();
          }
          // A failed request may have reached the engine. Never resend it here.
        }
      }
    } finally {
      entry.pumping = false;
    }
  }

  /** Seq 0 marks an event the server made up (a host that vanished). */
  function emit(agentId: string, entry: Live, event: DriverEvent, seq: number) {
    if (event.type === "turn") {
      entry.turnOpen = event.state === "started";
      if (event.state === "settled") {
        const waiters = entry.settleWaiters;
        entry.settleWaiters = [];
        for (const resolve of waiters) resolve();
        void pump(agentId, entry);
      }
    }
    if (
      event.type === "update" &&
      event.update.sessionUpdate === "available_commands_update"
    ) {
      entry.commands = event.update.availableCommands ?? [];
    }
    if (event.type === "config") entry.configOptions = event.options;
    if (event.type === "exit") {
      entry.turnOpen = false;
      failWaiting(entry, new Error("The agent exited before delivery."));
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
    const cursor = await deps.hostSeq(agentId);
    const entry: Live = {
      client: null as unknown as HostClient,
      commands: [],
      configOptions: [],
      pumping: false,
      waiting: [],
      pending: 0,
      turnOpen: false,
      events: Promise.resolve(),
      lastSeq: cursor.seq,
      journalId: cursor.journalId,
      settleWaiters: [],
    };
    entry.client = new HostClient({
      agentId,
      socketPath: hostFile(stateDir(agentId), "socket"),
      logger,
      fromSeq: () => entry.lastSeq,
      journalId: () => entry.journalId,
      onEvent: (journal) => dispatchEntry(agentId, entry, journal),
      onPermissions: (requests) =>
        emit(agentId, entry, { type: "permissions", agentId, requests }, 0),
      onWelcome: (welcome) => {
        const changed = Boolean(
          welcome.journalId &&
          entry.journalId &&
          welcome.journalId !== entry.journalId
        );
        const reset = changed || welcome.journalSeq < entry.lastSeq;
        if (reset) {
          logger.warn(
            {
              agentId,
              storedSeq: entry.lastSeq,
              journalSeq: welcome.journalSeq,
              storedJournalId: entry.journalId,
              journalId: welcome.journalId,
            },
            "agent host journal changed; replaying from the beginning"
          );
          entry.lastSeq = 0;
        }
        if (
          welcome.journalId &&
          (reset || entry.journalId !== welcome.journalId)
        ) {
          entry.journalId = welcome.journalId;
          // Replay events are serialized after this reset, so their GREATEST
          // updates start from the new journal's position.
          entry.events = entry.events.then(() =>
            syncJournal(agentId, entry, welcome.journalId!, reset)
          );
        } else if (reset) {
          entry.events = entry.events.then(() =>
            syncJournal(agentId, entry, null, true)
          );
        }
        entry.turnOpen = welcome.turn !== null;
        entry.commands = welcome.commands;
        if (welcome.configOptions) entry.configOptions = welcome.configOptions;
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
      return tail
        ? `\n\nHost log (last ${LOG_TAIL_LINES} lines):\n${tail}`
        : "";
    } catch {
      return "";
    }
  }

  runtime = {
    tracksProcesses: () => true,
    getCommands(agentId) {
      const entry = live.get(agentId);
      return entry?.client.welcome?.running ? entry.commands : null;
    },
    getConfigOptions(agentId) {
      const entry = live.get(agentId);
      return entry?.client.welcome?.running ? entry.configOptions : null;
    },
    getPermissions(agentId) {
      return (
        live.get(agentId)?.client.getPermissions() ?? {
          connected: false,
          requests: [],
        }
      );
    },
    async answerPermission(agentId, requestId, optionId) {
      const client = live.get(agentId)?.client;
      if (!client?.getPermissions().connected)
        throw new Error("The agent host is not connected.");
      await client.answerPermission(crypto.randomUUID(), requestId, optionId);
    },
    async setConfigOption(agentId, configId, value) {
      const entry = live.get(agentId);
      if (!entry?.client.welcome?.running) {
        throw new Error("The agent's session is not running.");
      }
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const options = await entry.client.setConfig(id, configId, value);
      entry.configOptions = options;
      return options;
    },

    async launch(input) {
      const dir = stateDir(input.agentId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const launch: HostLaunch = {
        agentId: input.agentId,
        cwd: input.cwd,
        engine: input.engine,
        bins: input.bins,
        model: input.model,
        fullAccess: input.fullAccess ?? true,
        systemPrompt: input.systemPrompt,
        mcp: input.mcp,
        env: input.env,
        pathPrefix: input.pathPrefix,
        resumeSessionId: input.resumeSessionId,
      };
      await writeFile(
        hostFile(dir, "launch"),
        JSON.stringify(launch, null, 2),
        {
          mode: 0o600,
        }
      );
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
        logger.error(
          { err, agentId: input.agentId },
          "agent host spawn failed"
        );
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

    prompt(agentId, text, source, opts) {
      const entry = live.get(agentId);
      if (!entry) {
        const err = new Error(
          "The agent is not running; the prompt cannot be delivered."
        );
        return { accepted: Promise.reject(err), settled: Promise.reject(err) };
      }
      let resolveAccepted!: () => void;
      let rejectAccepted!: (err: Error) => void;
      const accepted = new Promise<void>((resolve, reject) => {
        resolveAccepted = resolve;
        rejectAccepted = reject;
      });
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }).finally(() => {
        entry.pending -= 1;
      });
      const own: Waiting = {
        text,
        ...(source ? { source } : {}),
        alone: opts?.alone === true || source?.source !== "chat",
        delivery: opts?.delivery ?? "queue",
        taken: false,
        resolveAccepted,
        rejectAccepted,
        resolveSettled,
        cancelled: false,
      };
      entry.waiting.push(own);
      entry.pending += 1;
      accepted.catch(() => {});
      void pump(agentId, entry);
      return { accepted, settled };
    },

    controlQueuedPrompt(agentIds, blockId, action) {
      const targets = agentIds.map((id) => {
        const entry = live.get(id);
        const prompt = entry?.waiting.find(
          (w) =>
            !w.taken &&
            !w.cancelled &&
            w.source?.source === "chat" &&
            w.source.chatMessageId === blockId
        );
        return entry && prompt ? { entry, prompt } : null;
      });
      // No awaits between checking and claiming: partially delivered posts
      // cannot be deleted, nor can a prompt already handed to the engine.
      if (!targets.length || targets.some((target) => !target)) return false;
      for (const target of targets) {
        const { entry, prompt } = target!;
        entry.waiting.splice(entry.waiting.indexOf(prompt), 1);
        if (action === "delete") {
          prompt.cancelled = true;
          const error = new Error("Queued message deleted.");
          error.name = "QueuedPromptDeletedError";
          prompt.rejectAccepted(error);
          prompt.resolveSettled();
        } else {
          prompt.alone = true;
          entry.waiting.unshift(prompt);
          prompt.delivery = "auto";
        }
      }
      for (let i = 0; i < targets.length; i++)
        void pump(agentIds[i]!, targets[i]!.entry);
      return true;
    },

    isBusy(agentId) {
      const entry = live.get(agentId);
      return entry ? entry.turnOpen || entry.pending > 0 : false;
    },

    hasOpenTurn(agentId) {
      return live.get(agentId)?.turnOpen ?? false;
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
        failWaiting(entry, new Error("The agent stopped before delivery."));
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
