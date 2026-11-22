import { sessionCommandId } from "@dispatch/runner-protocol";
import { applyLaunchEffort } from "../launch-effort.js";
import { firstPromptContext } from "../persona-context.js";
import type { PromptSource } from "../prompt-source.js";
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
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  AcpDriver,
  type DriverEvent,
  resolveExecutable,
  TEARDOWN_STEP_MS,
} from "../driver.js";
import { openCodeInstructionsEnv } from "../opencode-instructions.js";
import { buildHostEnv } from "../host-env.js";
import { engineSpecFor } from "../engine-spec.js";
import { embeddedBuild, isHostInstanceId } from "../../build-identity.js";
import { engineVersion } from "../../engine-availability.js";
import {
  type ClientMessage,
  encodeMessage,
  type HostLaunch,
  type HostMessage,
  hostFile,
  type JournalEntry,
  ndjsonDecoder,
  parseClientMessage,
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
  readonly id: string;

  constructor(
    private readonly file: string,
    idFile: string
  ) {
    // The first event is authoritative: losing only the sidecar must not
    // turn an intact journal into a new history and replay it twice.
    let firstLine = "";
    let embeddedId = "";
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as JournalEntry;
          if (!Number.isInteger(entry.seq)) continue;
          firstLine = line;
          embeddedId = entry.journalId ?? "";
          break;
        } catch {
          continue;
        }
      }
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
    this.id =
      embeddedId ||
      (firstLine
        ? `legacy-${createHash("sha256").update(firstLine).digest("hex")}`
        : randomUUID());
    // The sidecar is a convenient readable identity, but can be rebuilt
    // from a nonempty journal. A missing or empty journal gets a new ID,
    // even if a stale sidecar survived its replacement.
    writeFileSync(idFile, `${this.id}\n`, { mode: 0o600 });
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
      journalId: this.id,
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
  const hostIdentity = isHostInstanceId(launch.hostInstanceId)
    ? { hostInstanceId: launch.hostInstanceId, hostBuild: embeddedBuild }
    : undefined;
  await writeFile(hostFile(stateDir, "pid"), `${process.pid}\n`);
  const journal = new Journal(
    hostFile(stateDir, "journal"),
    hostFile(stateDir, "journalId")
  );

  // These receipts belong to this journal. A claimed operation may have
  // reached the provider even if the adapter never acknowledged pickup.
  const receipts = new Map<string, "claimed" | "accepted">();
  const receiptFile = path.join(stateDir, "prompt-receipts.jsonl");
  function recordReceipt(id: string, state: "claimed" | "accepted") {
    appendFileSync(
      receiptFile,
      JSON.stringify({ journalId: journal.id, id, state }) + "\n",
      { mode: 0o600, flush: true }
    );
    receipts.set(id, state);
  }
  try {
    for (const line of readFileSync(receiptFile, "utf8").trim().split("\n")) {
      if (!line) continue;
      const receipt = JSON.parse(line);
      if (receipt.journalId === journal.id)
        receipts.set(receipt.id, receipt.state);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // The engine child's environment: the host's own (a login shell's), the
  // launch's additions, and Dispatch's bin directories ahead on PATH.
  const childEnv = buildHostEnv(launch, stateDir);
  // Record only executable lookup context, never the full environment (tokens).
  logger.info(
    { agentId, engine: launch.engine, path: childEnv.PATH },
    "Agent executable search PATH; configure additional runtimes in ~/.dispatch/env"
  );

  let lease: { socket: net.Socket; id: string } | null = null;
  let submittedPrompts = 0;
  let mutatingRequests = 0;
  const driver = new AcpDriver({
    logger,
    onPermissions: (_id, requests) => {
      if (requests.length) lease = null;
      send(client, { type: "permissions", requests });
    },
  });
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
  } else if (launch.engine === "opencode") {
    bins.opencodeBin = await absolute(bins.opencodeBin ?? "opencode");
  } else {
    bins.codexBin = await absolute(bins.codexBin);
  }

  // One client at a time; the newest connection wins.
  let client: net.Socket | null = null;
  let openTurn: {
    seq: number;
    startedAt: string;
    source?: PromptSource;
  } | null = null;
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
      if (event.state === "started") lease = null;
      openTurn =
        event.state === "started"
          ? { seq: entry.seq, startedAt: entry.at, source: event.source }
          : null;
    }
    if (event.type === "exit") {
      running = false;
      openTurn = null;
    }
    if (
      launch.reportTurnActivity &&
      (event.type === "turn" || event.type === "exit")
    ) {
      const marker = path.join(stateDir, "turn-active");
      try {
        if (openTurn) writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
        else rmSync(marker, { force: true });
      } catch {
        // Telemetry must never interrupt event delivery.
      }
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
    const claim = () => {
      if (client !== socket) {
        lease = null;
        client?.destroy();
      }
      client = socket;
    };
    // Runner inventory connects only to read kernel peer credentials.
    // Keep the existing client until the new connection sends a command.
    let claimed = !hostIdentity;
    if (claimed) claim();
    const rejectCommand = (id?: string) =>
      send(socket, { type: "error", id, message: "Invalid host command." });
    const decode = ndjsonDecoder<unknown>(() => rejectCommand());
    socket.on("data", (chunk) => {
      for (const value of decode(chunk)) {
        const message = parseClientMessage(value);
        if (!message) {
          rejectCommand(sessionCommandId(value));
          continue;
        }
        if (!claimed) {
          claim();
          claimed = true;
        }
        void handle(socket, message).catch((err) => {
          logger.warn({ err: String(err) }, "host: message handler failed");
        });
      }
    });
    socket.on("error", (err) => {
      logger.debug({ err: String(err) }, "host: client socket error");
    });
    socket.on("close", () => {
      if (lease?.socket === socket) lease = null;
      if (client === socket) client = null;
    });
  });

  const idle = () =>
    running &&
    !shuttingDown &&
    !openTurn &&
    submittedPrompts === 0 &&
    mutatingRequests === 0 &&
    driver.getPermissions(agentId).length === 0 &&
    driver.isBackgroundIdle(agentId);

  async function handle(socket: net.Socket, message: ClientMessage) {
    if (socket !== client || shuttingDown) return;
    switch (message.type) {
      case "hello": {
        send(socket, {
          type: "welcome",
          ...hostIdentity,
          agentId,
          engine: launch.engine,
          sessionId,
          resumed,
          running,
          mcpInventorySupported: driver.supportsMcpInventory(agentId),
          backgroundWorkSupported: true,
          steeringSupported: driver.supportsSteering(agentId),
          interruptSupported: true,
          promptReceiptSupported: true,
          quiesceSupported: true,
          turn: openTurn,
          journalSeq: journal.lastSeq,
          journalId: journal.id,
          commands: driver.getCommands(agentId) ?? [],
          configOptions: driver.getConfigOptions(agentId) ?? [],
          permissions: driver.getPermissions(agentId),
        });
        const fromSeq =
          (message.journalId && message.journalId !== journal.id) ||
          message.fromSeq > journal.lastSeq
            ? 0
            : message.fromSeq;
        for (const entry of journal.after(fromSeq)) {
          send(socket, { type: "event", ...entry });
        }
        if (message.replayComplete) send(socket, { type: "replay_complete" });
        if (startupError)
          send(socket, { type: "error", message: startupError });
        return;
      }
      case "quiesce": {
        const canLease = !lease && idle();
        if (canLease) lease = { socket, id: message.id };
        send(socket, {
          type: "quiesce_result",
          id: message.id,
          state: canLease ? "idle" : "busy",
        });
        return;
      }
      case "release_quiesce":
        if (lease?.socket === socket && lease.id === message.id) lease = null;
        return;
      case "background_work": {
        const result =
          running && message.sessionId === sessionId
            ? driver.getBackgroundWork(agentId)
            : { status: "offline" as const, items: [] };
        send(socket, {
          type: "background_work_result",
          id: message.id,
          result,
        });
        return;
      }
      case "mcp_inventory": {
        const result =
          running && message.sessionId === sessionId
            ? await driver.getMcpInventory(agentId)
            : { agentId, status: "offline" as const, inventory: null };
        send(socket, { type: "mcp_inventory_result", id: message.id, result });
        return;
      }
      case "ping":
        send(socket, { type: "pong" });
        return;
      case "prompt_receipt":
        send(socket, {
          type: "prompt_receipt_result",
          id: message.id,
          journalId: journal.id,
          state:
            message.journalId === journal.id
              ? (receipts.get(message.id) ?? "unclaimed")
              : "rotated",
        });
        return;
      case "prompt": {
        if (message.journalId) {
          const previous = receipts.get(message.id);
          if (message.journalId !== journal.id || previous === "claimed") {
            send(socket, {
              type: "error",
              id: message.id,
              message: "Prompt execution is unknown; do not resubmit.",
            });
            return;
          }
          if (previous === "accepted") {
            send(socket, { type: "prompt_accepted", id: message.id });
            return;
          }
        }
        if (!running) {
          send(socket, {
            type: "error",
            id: message.id,
            message: "the engine is not running",
          });
          return;
        }
        if (lease) {
          send(socket, { type: "prompt_deferred", id: message.id });
          return;
        }
        // A turn the engine started itself raced this prompt: hand it back
        // to the server's queue rather than hold it here unacknowledged.
        if (openTurn && driver.hasEngineInitiatedTurn(agentId)) {
          send(socket, { type: "prompt_deferred", id: message.id });
          return;
        }
        if (openTurn || submittedPrompts) {
          send(socket, { type: "error", id: message.id, message: "busy" });
          return;
        }
        // The driver emits the turn's start, settle and error events; the
        // ack only says the adapter has the request.
        if (message.journalId) recordReceipt(message.id, "claimed");
        submittedPrompts++;
        // Reserve the slot before handing off to the driver, which may
        // itself wait for an engine-originated turn before opening ours.
        const submit = async () => {
          if (shuttingDown) return;
          await driver.prompt(
            agentId,
            message.text,
            () => {
              if (message.journalId) recordReceipt(message.id, "accepted");
              send(socket, { type: "prompt_accepted", id: message.id });
            },
            message.source,
            message.images
          );
        };
        const pending = hostIdentity
          ? Promise.resolve().then(submit)
          : submit();
        void pending
          .catch((err) => {
            logger.warn({ err: String(err) }, "host: turn failed");
          })
          .finally(() => {
            submittedPrompts--;
          });
        return;
      }
      case "steer": {
        if (lease) {
          send(socket, {
            type: "error",
            id: message.id,
            message: "Host is quiesced.",
          });
          return;
        }
        mutatingRequests++;
        try {
          const outcome = await driver.steer(
            agentId,
            message.text,
            message.source
          );
          send(socket, { type: "steer_result", id: message.id, outcome });
        } catch (err) {
          send(socket, { type: "error", id: message.id, message: String(err) });
        } finally {
          mutatingRequests--;
        }
        return;
      }
      case "interrupt": {
        try {
          // No await between checking the turn identity and invoking cancel.
          // A stale request must never cancel a later unrelated turn.
          if (running && openTurn?.seq === message.turnSeq)
            await driver.cancel(agentId);
          send(socket, { type: "interrupt_result", id: message.id });
        } catch (err) {
          send(socket, { type: "error", id: message.id, message: String(err) });
        }
        return;
      }
      case "cancel":
        if (running) await driver.cancel(agentId).catch(() => {});
        return;
      case "answer_permission": {
        try {
          driver.answerPermission(agentId, message.requestId, message.optionId);
          send(socket, { type: "permission_answered", id: message.id });
        } catch (err) {
          send(socket, {
            type: "error",
            id: message.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "set_config": {
        if (!running) {
          send(socket, {
            type: "error",
            id: message.id,
            message: "the engine is not running",
          });
          return;
        }
        // The driver emits the `config` event that tells the server what the
        // engine runs now; the reply only says the engine took it.
        if (lease) {
          send(socket, {
            type: "error",
            id: message.id,
            message: "Host is quiesced.",
          });
          return;
        }
        mutatingRequests++;
        try {
          const options = await driver.setConfigOption(
            agentId,
            message.configId,
            message.value
          );
          send(socket, { type: "config_set", id: message.id, options });
        } catch (err) {
          send(socket, {
            type: "error",
            id: message.id,
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          mutatingRequests--;
        }
        return;
      }
      case "shutdown": {
        if ("quiesceId" in message) {
          const ownLease =
            lease?.socket === socket && lease.id === message.quiesceId;
          const accepted = ownLease && idle();
          if (ownLease) lease = null;
          send(socket, {
            type: "quiesce_shutdown_result",
            id: message.quiesceId,
            accepted,
          });
          if (accepted) await shutdown("graceful");
        } else {
          await shutdown(message.force ? "SIGKILL" : "graceful");
        }
        return;
      }
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
    const spec = engineSpecFor(launch.engine, bins, launch.fullAccess ?? true);
    const engineCli =
      launch.engine === "claude"
        ? bins.claudeBin
        : launch.engine === "opencode"
          ? bins.opencodeBin
          : bins.codexBin;
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
      effort: resume ? null : (launch.effort ?? null),
      model: launch.model,
      systemPromptAppend:
        spec.personaDelivery === "system_prompt" ? launch.systemPrompt : null,
      firstPromptAppend: firstPromptContext(
        spec.personaDelivery,
        launch.systemPrompt,
        launch.personaContext
      ),
      mcp: launch.mcp,
      sessionId: resume,
      env:
        spec.personaDelivery === "instructions_file"
          ? await openCodeInstructionsEnv(
              stateDir,
              launch.systemPrompt,
              childEnv
            )
          : childEnv,
    });
    sessionId = session.sessionId;
    resumed = session.resumed;
    // OpenCode applies and verifies the chosen model during its handshake.
    // The bundled adapters retain their existing fallback to the CLI default.
    if (launch.model && launch.engine !== "opencode") {
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
    await applyLaunchEffort(
      driver,
      agentId,
      launch.engine,
      launch.effort,
      resume
        ? {
            onError: (err) =>
              logger.warn(
                { agentId, effort: launch.effort, err: String(err) },
                "host: saved effort is unavailable; keeping engine settings on resume"
              ),
          }
        : undefined
    );
    await writeFile(
      hostFile(stateDir, "session"),
      JSON.stringify({ sessionId, resumed: session.resumed }),
      { mode: 0o600 }
    );
    running = driver.isRunning(agentId);
    // A client that connected before the engine was up gets the session.
    send(client, {
      type: "welcome",
      ...hostIdentity,
      agentId,
      engine: launch.engine,
      sessionId,
      resumed,
      running,
      mcpInventorySupported: driver.supportsMcpInventory(agentId),
      backgroundWorkSupported: true,
      steeringSupported: driver.supportsSteering(agentId),
      interruptSupported: true,
      promptReceiptSupported: true,
      quiesceSupported: true,
      turn: openTurn,
      journalSeq: journal.lastSeq,
      journalId: journal.id,
      commands: driver.getCommands(agentId) ?? [],
      configOptions: driver.getConfigOptions(agentId) ?? [],
      permissions: driver.getPermissions(agentId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ agentId, err: message }, "host: engine failed to start");
    startupError = message;
    running = false;
    driver.killAll();
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
