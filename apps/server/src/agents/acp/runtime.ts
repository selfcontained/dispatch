import type { RuntimeLaunch } from "../runtime.js";
import { sameConversation, type PromptConversation } from "@dispatch/shared";
import { appendFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  createLocalRunner,
  type LocalLaunchSettings,
  type SessionResult,
} from "../local-runner.js";
import type { SessionLifecycleOperation } from "@dispatch/runner-protocol";
export {
  selfCommand,
  hostCommand,
  loginShellCommand,
  hostProcessEnv,
} from "./host-command.js";

import type { FastifyBaseLogger } from "fastify";
import type {
  AvailableCommand,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";

import type { AppConfig } from "../../config.js";
import type { DriverEvent } from "./driver.js";
import type {
  PromptImage,
  PromptSource,
  PromptOptions,
} from "./prompt-source.js";
import type {
  AgentRuntime,
  QueuedPromptAction,
  RuntimeEventListener,
} from "../runtime.js";
import type {
  ClassifySteering,
  SteeringDecision,
  SteeringOutcome,
} from "../steering.js";
import {
  RunnerUnavailable,
  RunnerRevoked,
  RunnerHostGone,
  type RemoteRunnerService,
} from "../remote/service.js";
import type { Placement } from "../remote/protocol.js";
import type { RemoteEventInbox } from "../remote/event-inbox.js";
import { HostClient } from "./host-client.js";
import { type JournalEntry } from "./host-protocol.js";

/** The engine's ACP handshake can take a while on a cold adapter. */
const LAUNCH_TIMEOUT_MS = 60_000;
const ATTACH_TIMEOUT_MS = 5_000;
/**
 * Posts that queued up behind a turn go to the agent together, as one
 * prompt, rather than one turn apiece. A backlog longer than this carries
 * on into the next turn: nothing is dropped, and no prompt grows without
 * bound. One post larger than the size cap still goes, on its own.
 */
export const COMBINE_MAX_PROMPTS = 8;
export const COMBINE_MAX_CHARS = 32_000;

/** A prompt waiting for the turn ahead of it to settle. */
type Waiting = {
  /** Explicit Send now choice, scoped to the turn current when selected. */
  steerTurnSeq?: number;
  text: string;
  beforeSubmit?: () => Promise<boolean>;
  onDeferred?: () => Promise<void>;
  signal?: AbortSignal;
  images?: PromptImage[];
  source?: PromptSource;
  /** Not to be combined with others: an interrupting post, a job's nudge. */
  alone: boolean;
  /** The turn that took it, once one has; later jobs for it just wait on it. */
  taken: boolean;
  steering?: {
    seq: number;
    controller: AbortController;
    pending: boolean;
    decision?: SteeringDecision;
    outcome?: SteeringOutcome;
  };
  delivery: "auto" | "queue" | "interrupt";
  resolveSettled: () => void;
  resolveAccepted: () => void;
  rejectAccepted: (error: Error) => void;
  cancelled: boolean;
  /** Cancellation belongs to the turn active when this post arrived. */
  interruptHandled: boolean;
  interruptTargetSeq?: number;
};

type Live = {
  remote?: boolean;
  client: HostClient;
  commands: AvailableCommand[];
  configOptions: SessionConfigOption[];
  /** Serializes submission/acceptance, not the lifetime of a turn. */
  pumping: boolean;
  /** Prompts not yet sent, oldest first. */
  waiting: Waiting[];
  pending: number;
  /** Keep later prompts behind an outstanding scoped cancellation. */
  deliveryInterrupts: Map<number, Promise<void>>;
  turnOpen: boolean;
  /** The open turn is one the engine started itself, not a prompt's. */
  selfStarted: boolean;
  turnBlockIds: Set<string>;
  turnSeq: number | undefined;
  interruptedTurnSeq: number | undefined;
  conversation: PromptConversation | undefined;
  /** Event handling is serialized per agent so rows land in seq order. */
  events: Promise<void>;
  lastSeq: number;
  durableSeq: number;
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
    if (
      !next ||
      next.alone ||
      !sameConversation(
        batch[0]!.source?.conversation,
        next.source?.conversation
      ) ||
      batch[0]!.source?.userMessage !== next.source?.userMessage
    )
      break;
    size += next.text.length + COMBINED_SEPARATOR.length;
    if (size + combinedPreamble(batch.length + 1).length > COMBINE_MAX_CHARS) {
      break;
    }
    batch.push(waiting.shift()!);
  }
  return batch;
}

/**
 * Whether a prompt may join the open turn instead of waiting behind it: a
 * post or prompt in the conversation the turn is in, another agent's post
 * that names no conversation of its own, or a prompt the agent is itself
 * waiting on (a review, a finding settled). Advice from another agent is
 * worth most while the work it is about is still going; queued, it
 * arrives after the turn that needed it. An agent's answer to a question
 * resumes the asking conversation, so it keeps the conversation rule.
 */
function steers(
  w: Waiting,
  entry: Pick<Live, "conversation" | "turnSeq">
): boolean {
  if (w.steerTurnSeq !== undefined && w.steerTurnSeq === entry.turnSeq)
    return true;
  if (
    w.steering &&
    w.steering.seq === entry.turnSeq &&
    w.steering.decision?.valid()
  ) {
    if (w.steering.decision.choice === "queue_next") return false;
    if (w.steering.decision.choice === "steer_current") return true;
  }
  if (w.source?.scheduleId || w.source?.awaited === true) return true;
  if (w.source?.source !== "chat") return false;
  if (w.source.userMessage !== true && !w.source.conversation) return true;
  return sameConversation(w.source.conversation, entry.conversation);
}

/**
 * A person's post whose conversation is known and is not the one the
 * running turn answers in. Posts that resume an asking conversation
 * (`steeringExcluded`) or that the agent awaits keep their own rules.
 */
function crossesConversation(
  w: Waiting,
  entry: Pick<Live, "conversation" | "turnOpen">
): boolean {
  return (
    entry.turnOpen &&
    !!entry.conversation &&
    isUserPost(w) &&
    !!w.source?.conversation &&
    !w.source.steeringExcluded &&
    !w.source.awaited &&
    !w.source.scheduleId &&
    !sameConversation(w.source.conversation, entry.conversation)
  );
}

function isUserPost(w: Waiting): boolean {
  return w.source?.source === "chat" && w.source.userMessage === true;
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
    source: {
      ...batch[0]!.source,
      source: "chat",
      chatMessageId: ids[0]!,
      chatMessageIds: ids,
    },
  };
}

function sourceBlockIds(source?: PromptSource): string[] {
  return source?.source === "chat"
    ? [source.chatMessageId, ...(source.chatMessageIds ?? [])]
    : [];
}

export type AcpRuntimeDeps = {
  preparePromptFiles?: (
    agentId: string,
    images: PromptImage[]
  ) => Promise<PromptImage[]>;
  remote?: Pick<RemoteRunnerService, "available" | "requestSession">;
  remoteInbox?: Pick<RemoteEventInbox, "receive" | "projected">;
  recoverRemoteEvent?: (agentId: string) => Promise<void>;
  placement?: (agentId: string) => Promise<Placement | null>;
  classifySteering?: ClassifySteering;
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
  const connecting = new Map<string, Promise<Live>>();
  const listeners = new Set<RuntimeEventListener>();

  const placementOf = async (agentId: string) =>
    deps.placement?.(agentId) ?? null;
  const remoteService = () => {
    if (!deps.remote) throw new RunnerUnavailable("Remote runner is disabled.");
    return deps.remote;
  };

  const stateDir = (agentId: string) =>
    path.join(config.agentStateRoot, agentId);

  const local = createLocalRunner(config.agentStateRoot, logger);
  function requestSession(
    placement: Placement | null | undefined,
    operation: SessionLifecycleOperation,
    settings?: LocalLaunchSettings,
    onProgress?: RuntimeLaunch["onWorkspaceProgress"]
  ): Promise<SessionResult> {
    return placement
      ? remoteService().requestSession(placement, operation, onProgress)
      : local.requestSession(operation, settings);
  }

  function finishDecision(w: Waiting, outcome: SteeringOutcome) {
    if (w.steering) w.steering.outcome = outcome;
    w.steering?.decision?.finish(outcome);
    w.steering?.controller.abort();
    w.steering = undefined;
  }

  function dispatchEntry(agentId: string, entry: Live, journal: JournalEntry) {
    if (journal.seq <= entry.lastSeq) return; // replayed, already applied
    if (entry.remote && journal.seq !== entry.lastSeq + 1) {
      entry.client.replay();
      return;
    }
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
      finishDecision(w, "expired");
      w.rejectAccepted(error);
      w.resolveSettled();
    }
  }

  /** Submit input one request at a time while allowing steering during a turn. */
  async function pump(agentId: string, entry: Live): Promise<void> {
    if (
      entry.pumping ||
      entry.deliveryInterrupts.size ||
      live.get(agentId) !== entry
    )
      return;
    entry.pumping = true;
    try {
      while (
        entry.waiting.length &&
        (!entry.remote || entry.client.isReady()) &&
        !entry.deliveryInterrupts.size &&
        live.get(agentId) === entry
      ) {
        const urgent = entry.waiting.filter((w) => w.delivery === "interrupt");
        for (const w of urgent) {
          // A steering request may settle the arrival-time turn while the pump
          // is locked. Its interrupt must never migrate to a subsequent turn.
          if (
            !entry.turnOpen ||
            (w.interruptTargetSeq !== undefined &&
              w.interruptTargetSeq !== entry.turnSeq)
          )
            w.interruptHandled = true;
        }
        if (entry.turnOpen && urgent.length) {
          if (urgent.every((w) => w.interruptHandled)) break;
          if (
            !entry.client.welcome?.interruptSupported ||
            entry.turnSeq === undefined
          ) {
            for (const w of urgent.filter((w) => !w.interruptHandled)) {
              entry.waiting.splice(entry.waiting.indexOf(w), 1);
              w.rejectAccepted(
                new Error(
                  "This agent host cannot safely interrupt an active turn. Restart the agent and retry."
                )
              );
              w.resolveSettled();
            }
            continue;
          }
          if (entry.interruptedTurnSeq !== entry.turnSeq) {
            const targetSeq = entry.turnSeq;
            entry.interruptedTurnSeq = targetSeq;
            for (const w of urgent.filter((w) => !w.interruptHandled)) {
              w.interruptHandled = true;
              w.interruptTargetSeq ??= targetSeq;
            }
            try {
              // Keep the pump locked until cancel returns, even if settlement
              // wins the race. Never let a pending cancel hit the next turn.
              await entry.client.interrupt(crypto.randomUUID(), targetSeq);
            } catch (error) {
              if (entry.turnSeq === targetSeq)
                entry.interruptedTurnSeq = undefined;
              // Preserve stored posts as failed deliveries for explicit retry.
              // Never claim settlement or dispatch concurrently after failure.
              for (const w of entry.waiting.filter(
                (w) =>
                  w.delivery === "interrupt" &&
                  w.interruptTargetSeq === targetSeq
              )) {
                entry.waiting.splice(entry.waiting.indexOf(w), 1);
                w.rejectAccepted(
                  error instanceof Error ? error : new Error(String(error))
                );
                w.resolveSettled();
              }
            }
            if (!entry.turnOpen) continue;
          }
          for (const w of urgent) w.interruptHandled = true;
          // Settlement, not the cancellation response, releases the new turn.
          break;
        }
        const steering = entry.turnOpen;
        let batch: Waiting[];
        if (steering) {
          if (!entry.client.welcome?.steeringSupported) break;
          const index = entry.waiting.findIndex(
            (w) =>
              w.delivery === "auto" &&
              !w.images?.length &&
              !w.steering?.pending &&
              !(
                isUserPost(w) &&
                entry.waiting
                  .slice(0, entry.waiting.indexOf(w))
                  .some(
                    (earlier) =>
                      isUserPost(earlier) && earlier.steering?.pending
                  )
              ) &&
              steers(w, entry)
          );
          if (index < 0) break;
          batch = entry.waiting.splice(index, 1);
        } else {
          for (const w of entry.waiting) finishDecision(w, "expired");
          batch = takeBatch(entry.waiting);
        }
        for (const w of batch) w.taken = true;
        const { text, source } = combine(batch);
        const id = crypto.randomUUID();
        let ended = false;
        let accepted = false;
        let submitted = false;
        const onSettle = () => {
          ended = true;
          if (accepted) for (const w of batch) w.resolveSettled();
        };
        entry.settleWaiters.push(onSettle);
        /** The batch was not consumed: put it back to go out after this turn. */
        const requeue = async () => {
          await batch[0]?.onDeferred?.();
          entry.settleWaiters = entry.settleWaiters.filter(
            (w) => w !== onSettle
          );
          if (batch[0]?.signal?.aborted) {
            for (const w of batch) {
              w.rejectAccepted(
                Object.assign(
                  new Error("Scheduled delivery cancelled before submission."),
                  { name: "ScheduledDeliveryCancelledError" }
                )
              );
              w.resolveSettled();
            }
            return;
          }
          for (const w of batch) {
            w.taken = false;
            w.delivery = "queue";
          }
          // Keep declined input ahead of ordinary queued work, but behind
          // interrupts that arrived while the request was pending.
          const firstOrdinary = entry.waiting.findIndex(
            (w) => w.delivery !== "interrupt"
          );
          entry.waiting.splice(
            firstOrdinary < 0 ? entry.waiting.length : firstOrdinary,
            0,
            ...batch
          );
        };
        try {
          if (
            batch.some((w) => w.signal?.aborted) ||
            (batch[0]?.beforeSubmit && !(await batch[0].beforeSubmit()))
          ) {
            entry.settleWaiters = entry.settleWaiters.filter(
              (w) => w !== onSettle
            );
            for (const w of batch) {
              w.rejectAccepted(
                Object.assign(
                  new Error("Scheduled delivery cancelled before submission."),
                  { name: "ScheduledDeliveryCancelledError" }
                )
              );
              w.resolveSettled();
            }
            continue;
          }
          if (steering) {
            const outcome = await entry.client.steer(id, text, source);
            if (outcome === "promptRequired") {
              // The engine won the idle race. The message was not consumed;
              // wait for its terminal event, then start an ordinary tracked turn.
              for (const w of batch) finishDecision(w, "declined");
              await requeue();
              continue;
            }
            for (const w of batch)
              finishDecision(
                w,
                w.steering?.decision?.valid() &&
                  w.steering.decision.choice === "steer_current"
                  ? "steered"
                  : "default"
              );
          } else {
            const inputs = batch.flatMap((item) => item.images ?? []);
            const images = inputs.some(
              (input) => input.runnerName !== undefined
            )
              ? await deps.preparePromptFiles?.(agentId, inputs)
              : inputs;
            if (!images)
              throw new Error("Runner prompt file delivery is unavailable.");
            if (entry.remote) {
              const dir = stateDir(agentId);
              await mkdir(dir, { recursive: true, mode: 0o700 });
              await appendFile(
                path.join(dir, "remote-prompts.jsonl"),
                JSON.stringify({
                  id,
                  journalId: entry.journalId,
                  blocks: sourceBlockIds(source),
                }) + "\n",
                { mode: 0o600, flush: true }
              );
            }
            // Set this before submitting: ack and settle can arrive together.
            submitted = true;
            entry.turnOpen = true;
            entry.turnBlockIds = new Set(sourceBlockIds(source));
            entry.conversation = source?.conversation;
            const outcome = await entry.client.prompt(
              id,
              text,
              source,
              images.length ? images : undefined
            );
            if (outcome === "deferred") {
              // The engine started a turn of its own first. The prompt waits
              // here, still deletable and interruptible, until that settles.
              for (const w of batch) finishDecision(w, "declined");
              await requeue();
              continue;
            }
          }
          if (steering && !ended) {
            for (const blockId of sourceBlockIds(source))
              entry.turnBlockIds.add(blockId);
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
          for (const w of batch) finishDecision(w, "failed");
          if (submitted) entry.turnOpen = false;
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
      for (const w of entry.waiting) finishDecision(w, "expired");
      entry.turnOpen = event.state === "started";
      entry.turnSeq = event.state === "started" ? seq : undefined;
      entry.turnBlockIds = new Set(
        event.state === "started" ? sourceBlockIds(event.source) : []
      );
      entry.conversation =
        event.state === "started" ? event.source?.conversation : undefined;
      if (event.state === "settled") {
        // A turn the engine started itself settles no prompt: one submitted
        // meanwhile waits behind it and settles with its own turn.
        if (!entry.selfStarted) {
          const waiters = entry.settleWaiters;
          entry.settleWaiters = [];
          for (const resolve of waiters) resolve();
        }
        void pump(agentId, entry);
      }
      entry.selfStarted =
        event.state === "started" && event.source?.source === "engine";
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
    const journalId = entry.journalId;
    const inbox =
      entry.remote && seq > 0 && journalId ? deps.remoteInbox : undefined;
    entry.events = entry.events.then(async () => {
      if (inbox && journalId) {
        await inbox.receive(agentId, { journalId, seq, event });
        entry.durableSeq = seq;
      }
      for (const listener of listeners) {
        try {
          await listener(agentId, event, seq, Boolean(inbox));
        } catch (err) {
          if (inbox) throw err;
          logger.warn({ err, agentId }, "runtime event listener failed");
        }
      }
      if (inbox && journalId) await inbox.projected(agentId, journalId, seq);
    });
    // Leave a failed projection recoverable in the inbox. Never apply later
    // events over a partial projection. The service reopens it on attach.
    void entry.events.catch((err) => {
      if (live.get(agentId) !== entry) return;
      logger.error(
        { err, agentId, seq },
        "remote event projection interrupted"
      );
      entry.client.close();
      live.delete(agentId);
      failWaiting(entry, new Error("Remote output projection interrupted"));
      for (const resolve of entry.settleWaiters.splice(0)) resolve();
    });
  }

  function connect(
    agentId: string,
    timeoutMs: number,
    abandoned?: () => boolean
  ): Promise<Live> {
    const pending = connecting.get(agentId);
    if (pending) return pending;
    const request = openHost(agentId, timeoutMs, abandoned).finally(() =>
      connecting.delete(agentId)
    );
    connecting.set(agentId, request);
    return request;
  }

  async function openHost(
    agentId: string,
    timeoutMs: number,
    abandoned: () => boolean = () => false
  ): Promise<Live> {
    const existing = live.get(agentId);
    if (existing) return existing;
    const placement = await placementOf(agentId);
    if (placement) await deps.recoverRemoteEvent?.(agentId);
    const cursor = await deps.hostSeq(agentId);
    const entry: Live = {
      remote: Boolean(placement),
      client: null as unknown as HostClient,
      commands: [],
      configOptions: [],
      pumping: false,
      waiting: [],
      pending: 0,
      deliveryInterrupts: new Map(),
      turnOpen: false,
      selfStarted: false,
      turnBlockIds: new Set(),
      turnSeq: undefined,
      interruptedTurnSeq: undefined,
      conversation: undefined,
      events: Promise.resolve(),
      lastSeq: cursor.seq,
      durableSeq: cursor.seq,
      journalId: cursor.journalId,
      settleWaiters: [],
    };
    entry.client = new HostClient({
      agentId,
      remote: Boolean(placement),
      openSocket: async () => {
        if (placement) await entry.events;
        const { channel } = await requestSession(placement, {
          kind: "attach",
          agentId,
        });
        if (!channel) throw new Error("Runner returned no session channel");
        return channel;
      },
      ...(placement
        ? {
            reconnectError: (error: unknown) => {
              if (
                error instanceof RunnerRevoked ||
                error instanceof RunnerHostGone
              )
                return "gone";
              if (error instanceof RunnerUnavailable) return "retry";
              return undefined;
            },
            onReady: () => void pump(agentId, entry),
          }
        : {}),
      logger,
      fromSeq: () =>
        entry.remote && deps.remoteInbox ? entry.durableSeq : entry.lastSeq,
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
          entry.durableSeq = 0;
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
        entry.selfStarted = welcome.turn?.source?.source === "engine";
        entry.turnSeq = welcome.turn?.seq;
        entry.turnBlockIds = new Set(sourceBlockIds(welcome.turn?.source));
        entry.conversation = welcome.turn?.source?.conversation;
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
    const placement = await placementOf(agentId);
    const response = await requestSession(placement, {
      kind: "log",
      agentId,
    }).catch(() => null);
    return String(response?.value ?? "");
  }

  function enqueuePrompt(
    entry: Live,
    agentId: string,
    text: string,
    source?: PromptSource,
    opts?: PromptOptions
  ) {
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
      ...(opts?.beforeSubmit ? { beforeSubmit: opts.beforeSubmit } : {}),
      ...(opts?.onDeferred ? { onDeferred: opts.onDeferred } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.images?.length ? { images: opts.images } : {}),
      ...(source ? { source } : {}),
      alone:
        opts?.delivery === "interrupt" ||
        opts?.alone === true ||
        source?.source !== "chat",
      // Steering accepts text only. Keep images for the next ordinary turn.
      delivery:
        opts?.delivery === "interrupt"
          ? "interrupt"
          : opts?.images?.length
            ? "queue"
            : (opts?.delivery ?? "queue"),
      taken: false,
      resolveAccepted,
      rejectAccepted,
      resolveSettled,
      cancelled: false,
      interruptTargetSeq: entry.turnSeq,
      interruptHandled:
        !entry.turnOpen ||
        (entry.turnSeq !== undefined &&
          entry.interruptedTurnSeq === entry.turnSeq),
    };
    if (own.delivery === "interrupt") {
      const firstOrdinary = entry.waiting.findIndex(
        (w) => w.delivery !== "interrupt"
      );
      entry.waiting.splice(
        firstOrdinary < 0 ? entry.waiting.length : firstOrdinary,
        0,
        own
      );
    } else if (isUserPost(own)) {
      // A person's post goes ahead of queued agent and system traffic,
      // behind interrupts and the person's own earlier posts. A deferred
      // batch put back at the front may sit ahead of those posts.
      let after = entry.waiting.length;
      while (after > 0 && !isUserPost(entry.waiting[after - 1]!)) after--;
      const firstOther = entry.waiting.findIndex(
        (w, i) => i >= after && w.delivery !== "interrupt" && !isUserPost(w)
      );
      entry.waiting.splice(
        firstOther < 0 ? entry.waiting.length : firstOther,
        0,
        own
      );
    } else {
      entry.waiting.push(own);
    }
    entry.pending += 1;
    if (
      deps.classifySteering &&
      own.delivery === "auto" &&
      isUserPost(own) &&
      !own.source?.steeringExcluded &&
      !own.source?.awaited &&
      !own.source?.scheduleId &&
      !own.images?.length &&
      entry.turnOpen &&
      entry.turnSeq !== undefined &&
      entry.conversation &&
      entry.client.welcome?.steeringSupported &&
      source?.source === "chat"
    ) {
      const state: NonNullable<Waiting["steering"]> = {
        seq: entry.turnSeq,
        controller: new AbortController(),
        pending: true,
        decision: undefined as SteeringDecision | undefined,
      };
      own.steering = state;
      const timer = setTimeout(() => {
        if (own.steering !== state) return;
        finishDecision(own, "expired");
        void pump(agentId, entry);
      }, 3000);
      void deps
        .classifySteering({
          agentId,
          messageId: source.chatMessageId,
          turnSeq: state.seq,
          activeMessageIds: [...entry.turnBlockIds],
          conversation: entry.conversation,
          defaultSteers: steers(own, entry),
          signal: state.controller.signal,
        })
        .then((decision) => {
          if (
            own.steering !== state ||
            live.get(agentId) !== entry ||
            !entry.turnOpen ||
            entry.turnSeq !== state.seq ||
            own.taken
          ) {
            decision?.finish(state.outcome ?? "expired");
            return;
          }
          state.pending = false;
          state.decision = decision;
          if (decision?.valid() && decision.choice === "queue_next")
            decision.finish("queued");
          if (decision?.choice === "keep_existing_default")
            decision.finish("default");
        })
        .catch(() => {
          if (own.steering === state) state.pending = false;
        })
        .finally(() => {
          clearTimeout(timer);
          void pump(agentId, entry);
        });
    }
    if (opts?.signal) {
      const discard = () => {
        if (own.taken) return;
        const index = entry.waiting.indexOf(own);
        if (index < 0) return;
        entry.waiting.splice(index, 1);
        finishDecision(own, "overridden");
        own.cancelled = true;
        own.rejectAccepted(
          Object.assign(
            new Error("Scheduled delivery cancelled before submission."),
            { name: "ScheduledDeliveryCancelledError" }
          )
        );
        own.resolveSettled();
      };
      opts.signal.addEventListener("abort", discard, { once: true });
      void settled.finally(() =>
        opts.signal?.removeEventListener("abort", discard)
      );
      if (opts.signal.aborted) discard();
    }
    accepted.catch(() => {});
    void pump(agentId, entry);
    return { accepted, settled };
  }

  runtime = {
    tracksProcesses: () => true,
    async getBackgroundWork(agentId) {
      const entry = live.get(agentId);
      if (!entry) return { status: "offline", items: [] };
      const result = await entry.client.getBackgroundWork();
      return live.get(agentId) === entry
        ? result
        : { status: "offline", items: [] };
    },
    async getMcpInventory(agentId) {
      const entry = live.get(agentId);
      if (!entry) return { agentId, status: "offline", inventory: null };
      const result = await entry.client.getMcpInventory(agentId);
      return live.get(agentId) === entry
        ? result
        : { agentId, status: "offline", inventory: null };
    },
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
      const {
        placement,
        cwd,
        bins,
        env,
        pathPrefix,
        onWorkspaceProgress,
        ...launch
      } = input;
      const { launchExited } = await requestSession(
        placement,
        { kind: "launch", agentId: input.agentId, launch },
        { cwd, bins, env, pathPrefix },
        onWorkspaceProgress
      );
      try {
        const entry = await connect(
          input.agentId,
          LAUNCH_TIMEOUT_MS,
          launchExited
        );
        const welcome = entry.client.welcome;
        if (!welcome) throw new Error("no welcome from the agent host");
        return { sessionId: welcome.sessionId, resumed: welcome.resumed };
      } catch (err) {
        if (placement) throw err; // A disconnected remote host may still be running.
        const message = err instanceof Error ? err.message : String(err);
        const tail = await readLogTail(input.agentId);
        // A host whose engine never came up has nothing to serve.
        await runtime.stop(input.agentId, true).catch(() => {});
        throw new Error(`${message}${tail}`);
      }
    },

    async attach(agentId) {
      if (connecting.has(agentId)) {
        try {
          await connecting.get(agentId);
          return true;
        } catch {
          return false;
        }
      }
      const current = live.get(agentId);
      if (current) return !current.remote || current.client.isReady();
      const placement = await placementOf(agentId);
      if (placement && !deps.remote?.available(placement)) return false;
      if (!(await runtime.isAlive(agentId))) return false;
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
      const placement = await placementOf(agentId);
      try {
        const { value } = await requestSession(placement, {
          kind: "alive",
          agentId,
        });
        return value === true;
      } catch (error) {
        if (error instanceof RunnerRevoked) return false;
        if (error instanceof RunnerUnavailable) return true;
        throw error;
      }
    },

    prompt(agentId, text, source, opts) {
      const entry = live.get(agentId);
      const pending = connecting.get(agentId);
      if (entry && (!entry.remote || !pending))
        return enqueuePrompt(entry, agentId, text, source, opts);

      // Dispatch may finish starting while an already running remote host is
      // still reconnecting. Attach before the first send, sharing any replay
      // already under way. This path never retries a submitted prompt.
      const delivery = (async () => {
        if (!deps.remote || !(await placementOf(agentId)))
          throw new Error(
            "The agent is not running; the prompt cannot be delivered."
          );
        const host = await (pending ?? connect(agentId, ATTACH_TIMEOUT_MS));
        if (live.get(agentId) !== host)
          throw new Error(
            "The agent host disconnected before prompt submission."
          );
        return enqueuePrompt(host, agentId, text, source, opts);
      })();
      return {
        accepted: delivery.then((result) => result.accepted),
        settled: delivery.then((result) => result.settled),
      };
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
        if (!entry || !prompt) return null;
        // Send now on a post from another conversation than the running
        // turn's: steering it in would answer it where it was not asked, so
        // it stops that turn and opens the next one where it was sent.
        const act: QueuedPromptAction =
          action === "send-now" && crossesConversation(prompt, entry)
            ? "interrupt"
            : action;
        return { entry, prompt, act };
      });
      // No awaits between checking and claiming: partially delivered posts
      // cannot be deleted, nor can a prompt already handed to the engine.
      if (!targets.length || targets.some((target) => !target)) return false;
      if (
        targets.some((target) => {
          const { entry, prompt, act } = target!;
          return act === "send-now"
            ? entry.turnOpen &&
                (prompt.delivery === "interrupt" ||
                  !!prompt.images?.length ||
                  (!steers(prompt, entry) &&
                    !entry.client.welcome?.steeringSupported))
            : // An interrupt already asked for is not asked for twice, and a
              // host that cannot cut a turn is refused up front rather than
              // failing the post after the fact.
              act === "interrupt" &&
                (prompt.delivery === "interrupt" ||
                  (entry.turnOpen &&
                    !entry.client.welcome?.interruptSupported));
        })
      )
        return false;
      for (const target of targets) {
        const { entry, prompt, act } = target!;
        finishDecision(prompt, "overridden");
        entry.waiting.splice(entry.waiting.indexOf(prompt), 1);
        if (act === "delete") {
          prompt.cancelled = true;
          const error = new Error("Queued message deleted.");
          error.name = "QueuedPromptDeletedError";
          prompt.rejectAccepted(error);
          prompt.resolveSettled();
          continue;
        }
        prompt.alone = true;
        // Ahead of ordinary posts, behind interrupts already waiting.
        const firstOrdinary = entry.waiting.findIndex(
          (w) => w.delivery !== "interrupt"
        );
        entry.waiting.splice(
          firstOrdinary < 0 ? entry.waiting.length : firstOrdinary,
          0,
          prompt
        );
        if (act === "interrupt") {
          // Exactly what a post sent as an interrupt gets on arrival: the
          // cancellation belongs to the turn open now, and is skipped when
          // that turn is already being stopped.
          prompt.delivery = "interrupt";
          prompt.interruptTargetSeq = entry.turnSeq;
          prompt.interruptHandled =
            !entry.turnOpen ||
            (entry.turnSeq !== undefined &&
              entry.interruptedTurnSeq === entry.turnSeq);
        } else {
          prompt.delivery = "auto";
          prompt.steerTurnSeq = entry.turnOpen ? entry.turnSeq : undefined;
        }
      }
      for (let i = 0; i < targets.length; i++)
        void pump(agentIds[i]!, targets[i]!.entry);
      return action === "send-now" &&
        targets.some((target) => target!.act === "interrupt")
        ? "interrupt"
        : true;
    },

    async interruptDelivery(agentIds, blockId) {
      const targets = agentIds.flatMap((agentId) => {
        const entry = live.get(agentId);
        return entry?.turnOpen ? [{ agentId, entry }] : [];
      });
      if (
        !targets.length ||
        targets.some(
          ({ entry }) =>
            !entry.client.welcome?.interruptSupported ||
            entry.turnSeq === undefined ||
            entry.turnBlockIds.has(blockId)
        )
      )
        return false;
      // Capture the turn before any awaits: an interrupt must never hit later work.
      const requests = targets.map(({ agentId, entry }) => ({
        agentId,
        entry,
        seq: entry.turnSeq!,
      }));
      await Promise.all(
        requests.map(async ({ agentId, entry, seq }) => {
          const existing = entry.deliveryInterrupts.get(seq);
          if (existing) return existing;
          if (entry.interruptedTurnSeq === seq) return;
          entry.interruptedTurnSeq = seq;
          const request = entry.client
            .interrupt(crypto.randomUUID(), seq)
            .catch((error) => {
              if (entry.turnSeq === seq && entry.interruptedTurnSeq === seq)
                entry.interruptedTurnSeq = undefined;
              throw error;
            })
            .finally(() => {
              entry.deliveryInterrupts.delete(seq);
              void pump(agentId, entry);
            });
          entry.deliveryInterrupts.set(seq, request);
          await request;
        })
      );
      return true;
    },

    isBusy(agentId) {
      const entry = live.get(agentId);
      return entry ? entry.turnOpen || entry.pending > 0 : false;
    },

    inputState(agentId) {
      const entry = live.get(agentId);
      return {
        active: entry?.turnOpen ?? false,
        steeringSupported: entry?.client.welcome?.steeringSupported ?? false,
        interruptSupported: entry?.client.welcome?.interruptSupported ?? false,
        conversation: entry?.conversation ?? null,
      };
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
      const placement = await placementOf(agentId);
      const operation = { kind: "stop", agentId, force } as const;
      if (placement) await requestSession(placement, operation);
      const entry = live.get(agentId);
      if (entry) {
        live.delete(agentId);
        failWaiting(entry, new Error("The agent stopped before delivery."));
        if (!placement) {
          try {
            entry.client.shutdown(force);
          } catch {
            // A disconnected local host can still be stopped by its supervisor.
          }
        }
      }
      if (!placement) await requestSession(null, operation);
      entry?.client.close();
    },

    async listHosted() {
      return (await local.listHosted()).filter((id) => id.startsWith("agt_"));
    },
    hostPid: local.hostPid,

    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    readLogTail,

    async clearRemoteState(agentId) {
      await rm(stateDir(agentId), { recursive: true, force: true });
    },

    async discard(agentId) {
      const placement = await placementOf(agentId);
      const operation = { kind: "discard", agentId } as const;
      if (placement) await requestSession(placement, operation);
      const entry = live.get(agentId);
      if (entry) {
        live.delete(agentId);
        entry.client.close();
      }
      if (placement)
        await rm(stateDir(agentId), { recursive: true, force: true });
      else await requestSession(null, operation);
    },
  };
  return runtime;
}
