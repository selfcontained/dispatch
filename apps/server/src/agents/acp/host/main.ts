/**
 * `dispatch agent-host --state <dir>`: the process that owns one agent's
 * ACP session. It spawns the engine adapter, holds its stdio for its whole
 * life, journals every event, and serves the Dispatch server over a Unix
 * socket. It is deliberately dumb: one session, one prompt at a time, no
 * queue and no policy. See docs/design/acp-runtime.md.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  AcpDriver,
  type DriverEvent,
  resolveExecutable,
  TEARDOWN_STEP_MS,
} from "../driver.js";
import { engineSpecFor } from "../engine-spec.js";
import { engineVersion } from "../../engine-availability.js";
import {
  type ClientMessage,
  encodeMessage,
  type HostLaunch,
  type HostMessage,
  hostFile,
  type JournalEntry,
  ndjsonDecoder,
} from "../host-protocol.js";

/** How long a crashed engine's host stays up so the server can read the exit. */
const EXIT_LINGER_MS = 2_000;

function log(
  level: "info" | "warn" | "error" | "debug",
  obj: unknown,
  msg: string
) {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg,
    ...(typeof obj === "object" && obj !== null ? obj : { detail: obj }),
  });
  process.stderr.write(`${line}\n`);
}

const logger = {
  info: (obj: Record<string, unknown>, msg: string) => log("info", obj, msg),
  warn: (obj: Record<string, unknown>, msg: string) => log("warn", obj, msg),
  error: (obj: Record<string, unknown>, msg: string) => log("error", obj, msg),
  debug: (obj: Record<string, unknown>, msg: string) => log("debug", obj, msg),
};

function parseArgs(argv: string[]): { stateDir: string } {
  const index = argv.indexOf("--state");
  const stateDir = index >= 0 ? argv[index + 1] : undefined;
  if (!stateDir) {
    throw new Error("usage: dispatch agent-host --state <dir>");
  }
  return { stateDir: path.resolve(stateDir) };
}

/** Append-only event log. Sync writes: a line is on disk before it is sent. */
class Journal {
  private seq = 0;

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          this.seq = (JSON.parse(line) as JournalEntry).seq;
          break;
        } catch {
          continue;
        }
      }
    }
  }

  get lastSeq(): number {
    return this.seq;
  }

  append(event: DriverEvent): JournalEntry {
    this.seq += 1;
    const entry: JournalEntry = {
      seq: this.seq,
      at: new Date().toISOString(),
      event,
    };
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  /** Every entry after `fromSeq`, in order. */
  after(fromSeq: number): JournalEntry[] {
    if (!existsSync(this.file)) return [];
    const out: JournalEntry[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as JournalEntry;
        if (entry.seq > fromSeq) out.push(entry);
      } catch {
        continue;
      }
    }
    return out;
  }
}

async function main(): Promise<void> {
  const { stateDir } = parseArgs(process.argv.slice(2));
  await mkdir(stateDir, { recursive: true });
  const launch = JSON.parse(
    await readFile(hostFile(stateDir, "launch"), "utf8")
  ) as HostLaunch;
  const { agentId } = launch;
  await writeFile(hostFile(stateDir, "pid"), `${process.pid}\n`);
  const journal = new Journal(hostFile(stateDir, "journal"));

  // The engine child's environment: the host's own (a login shell's), the
  // launch's additions, and Dispatch's bin directories ahead on PATH.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...launch.env };
  const basePath = process.env.PATH ?? "";
  childEnv.PATH = Array.from(
    new Set([...launch.pathPrefix, ...basePath.split(path.delimiter)])
  )
    .filter(Boolean)
    .join(path.delimiter);

  const driver = new AcpDriver({ logger });
  // The adapters find the host CLI through an env var that wants an absolute
  // path; a bare name from config is looked up on the child's PATH here.
  // Only the launched engine's CLI matters; one that cannot be found fails
  // the launch in engineSpecFor rather than letting the adapter pick its own.
  const bins = { ...launch.bins };
  const absolute = async (bin: string | null) =>
    bin && !bin.includes("/")
      ? resolveExecutable(bin, childEnv).catch(() => null)
      : bin;
  if (launch.engine === "claude") {
    bins.claudeBin = (await absolute(bins.claudeBin)) ?? "";
  } else {
    bins.codexBin = await absolute(bins.codexBin);
  }

  // One client at a time; the newest connection wins.
  let client: net.Socket | null = null;
  let openTurn: { seq: number; startedAt: string } | null = null;
  let running = false;
  let sessionId = "";
  let resumed = false;
  let shuttingDown = false;
  /** Set when the engine failed to start; told to every client that asks. */
  let startupError: string | null = null;

  const send = (socket: net.Socket | null, message: HostMessage) => {
    if (!socket || socket.destroyed) return;
    socket.write(encodeMessage(message));
  };

  driver.onEvent((event) => {
    const entry = journal.append(event);
    if (event.type === "turn") {
      openTurn =
        event.state === "started"
          ? { seq: entry.seq, startedAt: entry.at }
          : null;
    }
    if (event.type === "exit") {
      running = false;
      openTurn = null;
    }
    send(client, { type: "event", ...entry });
    if (event.type === "exit" && !shuttingDown) {
      // The engine died on its own. Give the server a moment to read the
      // exit event, then go: a host with no engine has nothing to serve,
      // and the server marks the agent from the closed socket.
      setTimeout(() => process.exit(event.code === 0 ? 0 : 1), EXIT_LINGER_MS);
    }
  });

  // A session id the host itself recorded outlives the launch file's: a
  // restarted host resumes the session it opened, not the one the server
  // knew about when it first launched.
  let resume = launch.resumeSessionId;
  try {
    const saved = JSON.parse(
      await readFile(hostFile(stateDir, "session"), "utf8")
    ) as { sessionId?: string };
    if (saved.sessionId) resume = saved.sessionId;
  } catch {
    // No saved session.
  }

  const socketPath = hostFile(stateDir, "socket");
  await unlink(socketPath).catch(() => {});
  const server = net.createServer((socket) => {
    if (client && client !== socket) client.destroy();
    client = socket;
    const decode = ndjsonDecoder<ClientMessage>();
    socket.on("data", (chunk) => {
      for (const message of decode(chunk)) {
        void handle(socket, message).catch((err) => {
          logger.warn({ err: String(err) }, "host: message handler failed");
        });
      }
    });
    socket.on("error", (err) => {
      logger.debug({ err: String(err) }, "host: client socket error");
    });
    socket.on("close", () => {
      if (client === socket) client = null;
    });
  });

  async function handle(socket: net.Socket, message: ClientMessage) {
    switch (message.type) {
      case "hello": {
        send(socket, {
          type: "welcome",
          agentId,
          engine: launch.engine,
          sessionId,
          resumed,
          running,
          turn: openTurn,
          journalSeq: journal.lastSeq,
          commands: driver.getCommands(agentId) ?? [],
        });
        for (const entry of journal.after(message.fromSeq)) {
          send(socket, { type: "event", ...entry });
        }
        if (startupError)
          send(socket, { type: "error", message: startupError });
        return;
      }
      case "ping":
        send(socket, { type: "pong" });
        return;
      case "prompt": {
        if (!running) {
          send(socket, {
            type: "error",
            id: message.id,
            message: "the engine is not running",
          });
          return;
        }
        if (openTurn) {
          send(socket, { type: "error", id: message.id, message: "busy" });
          return;
        }
        // The driver emits the turn's start, settle and error events; the
        // ack only says the adapter has the request.
        driver
          .prompt(
            agentId,
            message.text,
            () => send(client, { type: "prompt_accepted", id: message.id }),
            message.source
          )
          .catch((err) => {
            logger.warn({ err: String(err) }, "host: turn failed");
          });
        return;
      }
      case "cancel":
        if (running) await driver.cancel(agentId).catch(() => {});
        return;
      case "shutdown":
        await shutdown(message.force ? "SIGKILL" : "graceful");
        return;
    }
  }

  async function shutdown(mode: "graceful" | "SIGKILL"): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ agentId, mode }, "host: shutting down");
    if (mode === "graceful") {
      await Promise.race([
        driver.stop(agentId),
        new Promise((resolve) => setTimeout(resolve, TEARDOWN_STEP_MS * 4)),
      ]);
    }
    driver.killAll();
    server.close();
    await unlink(socketPath).catch(() => {});
    await unlink(hostFile(stateDir, "pid")).catch(() => {});
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("graceful"));
  process.on("SIGINT", () => void shutdown("graceful"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  logger.info({ agentId, socketPath }, "host: listening");

  try {
    const spec = engineSpecFor(launch.engine, bins);
    const engineCli =
      launch.engine === "claude" ? bins.claudeBin : bins.codexBin;
    // Which CLI, and which release of it, decides the models on offer: say
    // so in the host log, where a missing model gets investigated.
    if (engineCli && !bins.adapter) {
      logger.info(
        {
          agentId,
          engine: launch.engine,
          cli: engineCli,
          version: await engineVersion(engineCli),
        },
        "host: engine CLI"
      );
    }
    const session = await driver.start({
      agentId,
      cwd: launch.cwd,
      engine: spec,
      systemPromptAppend:
        spec.personaDelivery === "system_prompt" ? launch.systemPrompt : null,
      mcp: launch.mcp,
      sessionId: resume,
      env: childEnv,
    });
    sessionId = session.sessionId;
    resumed = session.resumed;
    running = true;
    // A chosen model is applied through the engine's own model option; an
    // engine that publishes none, or refuses the value, keeps its default.
    if (launch.model) {
      const options = driver.getConfigOptions(agentId) ?? [];
      const option = options.find(
        (o) => o.id === "model" || o.category === "model"
      );
      if (!option) {
        logger.warn(
          { agentId, model: launch.model },
          "host: engine publishes no model option"
        );
      } else {
        await driver
          .setConfigOption(agentId, option.id, launch.model)
          .catch((err) => {
            logger.warn(
              { agentId, model: launch.model, err: String(err) },
              "host: engine refused the model; keeping its default"
            );
          });
      }
    }
    await writeFile(
      hostFile(stateDir, "session"),
      JSON.stringify({ sessionId, resumed: session.resumed }),
      { mode: 0o600 }
    );
    // A client that connected before the engine was up gets the session.
    send(client, {
      type: "welcome",
      agentId,
      engine: launch.engine,
      sessionId,
      resumed,
      running,
      turn: null,
      journalSeq: journal.lastSeq,
      commands: driver.getCommands(agentId) ?? [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ agentId, err: message }, "host: engine failed to start");
    startupError = message;
    send(client, { type: "error", message });
    setTimeout(() => process.exit(1), EXIT_LINGER_MS);
  }
}

main().catch((err) => {
  log(
    "error",
    { err: err instanceof Error ? err.message : String(err) },
    "host: fatal"
  );
  process.exit(1);
});
