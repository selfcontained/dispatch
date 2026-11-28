import { AgentError } from "../errors.js";
import { isPromptImageMimeType } from "./prompt-source.js";
import type { RuntimeLaunch } from "../runtime.js";
import { sameConversation, type PromptConversation } from "@dispatch/shared";
import { removeHostState } from "../../files/session-directories.js";
import type { Duplex } from "node:stream";
import type { SessionLifecycleOperation } from "@dispatch/runner-protocol";
import {
  pathFromWire,
  RunnerCallError,
  sessionFromWire,
  sessionToWire,
  type Req,
  type Res,
  operations,
} from "@dispatch/runner-protocol/contract";
import {
  localHostChannel,
  readLocalSession,
  requestLocalSession as callLocalSession,
  type LocalSessionRunner,
} from "../../runners/local.js";
import {
  controllerPlacement,
  runnerIdForPlacement,
} from "../../runners/placement.js";

import type { FastifyBaseLogger } from "fastify";
import type {
  AvailableCommand,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";

import type { AppConfig } from "../../config.js";
import type { DriverEvent } from "@dispatch/runner-protocol/host";
import type {
  PromptImage,
  PromptSource,
  PromptOptions,
} from "./prompt-source.js";
import type {
  AgentRuntime,
  QueuedPromptAction,
  RunnerHostIdentity,
  RuntimeEventListener,
} from "../runtime.js";
import type {
  ClassifySteering,
  SteeringDecision,
  SteeringOutcome,
} from "../steering.js";
import {
  RunnerResumeRefused,
  RunnerUnavailable,
  RunnerRevoked,
  RunnerHostGone,
  RunnerUpdateFenced,
  RunnerAcknowledgementLost,
  type RemoteRunnerService,
} from "../remote/service.js";
import type { RunnerUpdateHolds } from "../remote/update-hold.js";
import type { RemoteEventInbox } from "../remote/event-inbox.js";
import {
  createHostSessionClient,
  enrolledHostStream,
  type HostSessionClient,
  type HostQuiesceLease,
  isUpdateAcknowledgementLost,
} from "../../runners/enrolled/host-session-client.js";
import { type JournalEntry } from "@dispatch/runner-protocol/host";

/** The engine's ACP handshake can take a while on a cold adapter. */
const LAUNCH_TIMEOUT_MS = 60_000;
const ATTACH_TIMEOUT_MS = 5_000;
/** A launch reply lost again and again across one update is not retried forever. */
const MAX_LAUNCH_RECONCILES = 5;
/**
 * Posts that queued up behind a turn go to the agent together, as one
 * prompt, rather than one turn apiece. A backlog longer than this carries
 * on into the next turn: nothing is dropped, and no prompt grows without
 * bound. One post larger than the size cap still goes, on its own.
 */
/**
 * What a failed reconnect to an agent host means, whatever the placement. A
 * runner that answers the host is gone settles the agent; a runner that is
 * unreachable (not sent, or lost before it answered an attach) is retried for
 * as long as the app runs, keeping the prompt queue. Anything else keeps the
 * bounded retry (about 25 s) after which the host is recorded as gone.
 *
 * Local attaches go through the runner child: while it is down they wait
 * for it (unavailable, retried), and a host that does not answer is a plain
 * error that takes the bounded path, as on main.
 */
export function hostReconnectDisposition(
  error: unknown
): "retry" | "gone" | undefined {
  if (error instanceof RunnerRevoked || error instanceof RunnerHostGone)
    return "gone";
  if (isSessionUnavailable(error)) return "retry";
  if (error instanceof RunnerCallError) {
    if (error.code === "host_gone") return "gone";
  }
  return undefined;
}

/** A request that cannot establish whether the session is still running. */
function isSessionUnavailable(error: unknown): boolean {
  return (
    (error instanceof RunnerUnavailable && !(error instanceof RunnerRevoked)) ||
    (error instanceof RunnerCallError &&
      (error.code === "unavailable" || error.code === "unknown_outcome"))
  );
}

/** The stop remains pending until the runner can serve it. */
export function isStopDeferred(error: unknown): boolean {
  return (
    isSessionUnavailable(error) ||
    error instanceof RunnerUpdateFenced ||
    (error instanceof RunnerCallError && error.code === "fenced")
  );
}

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
  requiresPrompt: boolean;
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
  wakeTurnSeq?: number;
  continuationId?: string;
};

type Live = {
  agentId: string;
  inbox?: Pick<RemoteEventInbox, "receive" | "projected">;
  runnerId: string;
  /** The runner connection the host's newest channel was opened over. */
  channelEpoch?: number;
  client: HostSessionClient;
  commands: AvailableCommand[];
  configOptions: SessionConfigOption[];
  /** Serializes submission/acceptance, not the lifetime of a turn. */
  pumping: boolean;
  /** Prompts not yet sent, oldest first. */
  queue: { waiting: Waiting[]; pending: number };
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

const LOG_TAIL_LINES = 20;

type SessionResult = {
  value?: string | boolean;
  channel?: Duplex;
  /** After a launch: whether its host has exited since. */
  launchExited?: () => boolean;
  /** After a launch: stop watching for its host's exit. */
  launchSettled?: () => void;
};

/** The engine bins as launch programs; the inverse of `programsToBins`. */
function binsToPrograms(
  bins: NonNullable<RuntimeLaunch["bins"]> & {
    adapter?: { bin: string; args?: string[] };
  }
): NonNullable<Req<"session.launch">["programs"]> {
  const program = (bin: string | null | undefined) =>
    bin === null ? null : { path: bin! };
  return {
    ...(bins.claudeBin !== undefined && { claude: program(bins.claudeBin) }),
    ...(bins.codexBin !== undefined && { codex: program(bins.codexBin) }),
    ...(bins.opencodeBin !== undefined && {
      opencode: program(bins.opencodeBin),
    }),
    ...(bins.adapter && {
      adapter: {
        path: bins.adapter.bin,
        ...(bins.adapter.args !== undefined && { args: bins.adapter.args }),
      },
    }),
  };
}

/** How often a launch checks that its host is still running while it connects. */
const LAUNCH_EXIT_POLL_MS = 250;

/**
 * The launch as the contract carries it: the same request for every runner.
 * A runner that resolves its own directory, programs and PATH ignores them.
 */
function launchRequest(
  input: Pick<
    RuntimeLaunch,
    | "agentId"
    | "cwd"
    | "engine"
    | "model"
    | "effort"
    | "fullAccess"
    | "systemPrompt"
    | "personaContext"
    | "mcp"
    | "env"
    | "pathPrefix"
    | "resumeSessionId"
    | "launchId"
  > & {
    programs?: Req<"session.launch">["programs"];
  }
): Req<"session.launch"> {
  return {
    session: sessionFromWire(input.agentId),
    launchId: input.launchId ?? crypto.randomUUID(),
    engine: input.engine,
    model: input.model,
    effort: input.effort ?? null,
    access: input.fullAccess === false ? "default" : "full",
    resume: input.resumeSessionId,
    systemText: input.systemPrompt,
    firstText: input.personaContext ?? null,
    overflowNotice: null,
    env: input.env ?? {},
    mcp: input.mcp
      ? [
          {
            name: input.mcp.name ?? "dispatch",
            url: input.mcp.url,
            token: input.mcp.token,
          },
        ]
      : [],
    owner: null,
    directory: pathFromWire(input.cwd),
    ...(input.programs && { programs: input.programs }),
    ...(input.pathPrefix && { pathPrefix: input.pathPrefix.map(pathFromWire) }),
  };
}

export type AcpRuntimeDeps = {
  /** Put the prompt's files; the text names the paths the agent opens. */
  preparePromptFiles?: (
    agentId: string,
    images: PromptImage[],
    text: string
  ) => Promise<{ images: PromptImage[]; text: string }>;
  remote?: Pick<RemoteRunnerService, "available" | "call" | "openStream"> &
    Partial<Pick<RemoteRunnerService, "connectionEpoch">>;
  /**
   * The app's local runner child, once started: local hosts are attached,
   * checked and read through it.
   */
  localRunner?: () => LocalSessionRunner | undefined;
  /** How often a lost launch reply polls for the runner to return. */
  launchRetryPollMs?: number;
  /** Runner update holds: new work for a held runner waits in the queue. */
  holds?: Pick<
    RunnerUpdateHolds,
    "isHeld" | "current" | "wait" | "onRelease" | "countWith" | "isResuming"
  >;
  remoteInbox?: Pick<RemoteEventInbox, "receive" | "projected">;
  recoverRemoteEvent?: (agentId: string) => Promise<void>;
  placement?: (agentId: string) => Promise<string | null>;
  recordLaunch?: (agentId: string, launchId: string | null) => Promise<void>;
  sessionOwner?: () => Promise<string>;
  classifySteering?: ClassifySteering;
  config: Pick<
    AppConfig,
    "agentStateRoot" | "agentRuntime" | "dispatchBinDir" | "acpAdapter"
  >;
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
  type RecycleHold = { entry: Live; restarting: boolean; forced?: true };
  const recycleHolds = new Map<string, RecycleHold>();
  const inputEntry = (agentId: string) =>
    live.get(agentId) ?? recycleHolds.get(agentId)?.entry;
  const preserving = (entry: Live) => {
    const hold = recycleHolds.get(entry.agentId);
    return hold?.entry === entry && hold.restarting;
  };
  const connecting = new Map<string, Promise<Live>>();
  const listeners = new Set<RuntimeEventListener>();

  const placementOf = async (agentId: string) =>
    deps.placement?.(agentId) ?? null;
  const remoteService = () => {
    if (!deps.remote) throw new RunnerUnavailable("Remote runner is disabled.");
    return deps.remote;
  };

  const controllerId = runnerIdForPlacement(controllerPlacement);
  const runnerIdAt = (placement?: string | null) => placement ?? controllerId;

  /** An update holds new work for this host's runner. */
  const held = (entry: Live) =>
    deps.holds?.isHeld(entry.runnerId) === true ||
    recycleHolds.has(entry.agentId);

  const draining = (entry: Live) =>
    deps.holds?.current(entry.runnerId)?.draining === true &&
    !recycleHolds.has(entry.agentId);
  const canWake = (w: Waiting, entry: Live) =>
    draining(entry) &&
    entry.turnOpen &&
    w.wakeTurnSeq !== undefined &&
    w.wakeTurnSeq === entry.turnSeq;

  /**
   * Stop and discard start runner processes, so a held runner's fence would
   * refuse them: wait for the hold, and wait again if a refusal says the
   * request never started while the hold is still on.
   */
  async function heldSessionRequest(
    placement: string | null | undefined,
    operation: SessionLifecycleOperation,
    beforeRequest?: () => void
  ): Promise<SessionResult> {
    const runnerId = runnerIdAt(placement);
    for (;;) {
      if (placement && !deps.remote?.available(placement))
        throw new RunnerUnavailable(
          "The runner is disconnected or unavailable."
        );
      await deps.holds?.wait(runnerId, "stop");
      try {
        beforeRequest?.();
        return await requestSession(placement, operation);
      } catch (error) {
        if (
          error instanceof RunnerUpdateFenced &&
          deps.holds?.isHeld(runnerId)
        ) {
          if (deps.holds.isResuming(runnerId)) await deps.holds.wait(runnerId);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * A launch whose reply was lost while its runner was held for an update:
   * once the runner is back, send the same attempt again. A runner that
   * reconciles launch IDs adopts the host it already started or resumes
   * its preparation; a fenced runner refuses it, and the caller holds it.
   * Anything else keeps the original uncertain outcome.
   */
  async function requestLaunch(
    placement: string | null | undefined,
    operation: Extract<SessionLifecycleOperation, { kind: "launch" }>,
    request: Req<"session.launch">,
    beforeReconcile?: RuntimeLaunch["beforeLaunchReconcile"]
  ): Promise<SessionResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await requestSession(placement, operation, request);
      } catch (error) {
        const hold = deps.holds?.current(runnerIdAt(placement));
        if (
          !(error instanceof RunnerAcknowledgementLost) ||
          !placement ||
          operation.launch.launchId === undefined ||
          !hold ||
          attempt >= MAX_LAUNCH_RECONCILES
        )
          throw error;
        const deadline = Date.parse(hold.expiresAt);
        const pollMs = deps.launchRetryPollMs ?? 250;
        while (!deps.remote?.available(placement) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        await beforeReconcile?.();
        if (!deps.remote?.available(placement)) throw error;
        logger.info(
          {
            agentId: operation.agentId,
            runnerId: runnerIdAt(placement),
            launchId: operation.launch.launchId,
          },
          "launch reply lost during a runner update; reconciling the same launch"
        );
      }
    }
  }

  async function requestSession(
    placement: string | null | undefined,
    operation: SessionLifecycleOperation,
    request?: Req<"session.launch">
  ): Promise<SessionResult> {
    if (!placement) return requestLocalSession(operation, request);
    const runner = runnerIdAt(placement);
    const session = sessionFromWire(operation.agentId);
    const service = remoteService();
    try {
      switch (operation.kind) {
        case "launch":
          if (!request || request.session !== session)
            throw new Error("Missing or mismatched launch request");
          await service.call(runner, "session.launch", request);
          return {};
        case "attach": {
          const { channel } = await service.openStream(
            runner,
            "session.attach",
            { session }
          );
          return { channel: enrolledHostStream(channel, operation.agentId) };
        }
        case "log":
          return {
            value: (
              await service.call(runner, "session.logs", {
                session,
                lines: LOG_TAIL_LINES,
              })
            ).text,
          };
        case "alive":
          return {
            value:
              (await service.call(runner, "session.alive", { session }))
                .state === "live",
          };
        case "discard":
          await service.call(runner, "session.discard", { session });
          return {};
        case "stop": {
          const { force, expectedLaunchId, expectedOwner } = operation;
          await service.call(runner, "session.stop", {
            session,
            force,
            expectedLaunchId,
            expectedOwner,
          });
          return {};
        }
      }
    } catch (error) {
      if (!(error instanceof RunnerCallError)) throw error;
      if (error.code === "host_gone") throw new RunnerHostGone(error.message);
      if (error.code === "unavailable")
        throw new RunnerUnavailable(error.message);
      if (error.code === "unknown_outcome")
        throw new RunnerAcknowledgementLost(error.message);
      if (error.code === "fenced") throw new RunnerUpdateFenced(error.message);
      throw error;
    }
  }

  function localChild(): LocalSessionRunner {
    const child = deps.localRunner?.();
    if (!child)
      throw new RunnerCallError({
        code: "unavailable",
        message: "The local runner is unavailable",
      });
    return child;
  }

  /**
   * Local hosts are started, stopped, attached, checked and read only
   * through the runner child; the app never spawns or signals one.
   */
  async function requestLocalSession(
    operation: SessionLifecycleOperation,
    request?: Req<"session.launch">
  ): Promise<SessionResult> {
    const { agentId } = operation;
    const session = sessionFromWire(agentId);
    switch (operation.kind) {
      case "launch": {
        if (!request || sessionToWire(request.session) !== agentId)
          throw new Error("Missing or mismatched launch request");
        const child = localChild();
        await callLocalSession(child, "session.launch", request);
        // The child answers once the host runs; it may still exit before
        // it answers the app, which fails the launch at once, as before.
        let exited = false;
        let watching = true;
        const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
        void (async () => {
          while (watching && !exited && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, LAUNCH_EXIT_POLL_MS));
            if (!watching) return;
            try {
              const { state } = await child.call(
                "session.alive",
                { session },
                { wait: false }
              );
              if (state === "gone") exited = true;
            } catch {
              // Unavailable is not gone.
            }
          }
        })();
        return {
          launchExited: () => exited,
          launchSettled: () => {
            watching = false;
          },
        };
      }
      case "stop": {
        try {
          await localChild().call(
            "session.stop",
            {
              session,
              force: operation.force,
              ...(operation.expectedLaunchId !== undefined && {
                expectedLaunchId: operation.expectedLaunchId,
              }),
              ...(operation.expectedOwner !== undefined && {
                expectedOwner: operation.expectedOwner,
              }),
            },
            { wait: false, timeoutMs: 30_000 }
          );
        } catch (error) {
          if (error instanceof RunnerCallError && error.code === "timeout")
            throw new RunnerAcknowledgementLost(error.message);
          throw error;
        }
        return {};
      }
      case "discard": {
        await callLocalSession(localChild(), "session.discard", { session });
        return {};
      }
      case "attach": {
        return { channel: await localHostChannel(localChild(), agentId) };
      }
      case "alive": {
        const { state } = await readLocalSession(
          localChild(),
          "session.alive",
          { session }
        );
        return { value: state === "live" };
      }
      case "log": {
        const text = await readLocalSession(localChild(), "session.logs", {
          session,
          lines: LOG_TAIL_LINES,
        })
          .then(({ text }) => text.trim())
          .catch(() => "");
        return {
          value: text
            ? `\n\nHost log (last ${LOG_TAIL_LINES} lines):\n${text}`
            : "",
        };
      }
    }
  }

  function finishDecision(w: Waiting, outcome: SteeringOutcome) {
    if (w.steering) w.steering.outcome = outcome;
    w.steering?.decision?.finish(outcome);
    w.steering?.controller.abort();
    w.steering = undefined;
  }

  function dispatchEntry(agentId: string, entry: Live, journal: JournalEntry) {
    if (journal.seq <= entry.lastSeq) return; // replayed, already applied
    if (!entry.client.acceptsJournalSequence(entry.lastSeq, journal.seq)) {
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
    for (const w of entry.queue.waiting.splice(0)) {
      finishDecision(w, "expired");
      w.rejectAccepted(error);
      w.resolveSettled();
    }
  }

  /**
   * Whether queued input may go to the host now. A runner's host waits for
   * its replay. A local host takes input as soon as it is connected, as on
   * main (a resumed host's replay can carry the previous host's exit, which
   * would fail input held behind it); while it is not connected (the runner
   * child restarting) input waits in the queue, and the host's next ready
   * pumps it.
   */
  const deliverable = (entry: Live) => entry.client.canDeliverInput();

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
        entry.queue.waiting.length &&
        deliverable(entry) &&
        !entry.deliveryInterrupts.size &&
        live.get(agentId) === entry
      ) {
        const gated = held(entry);
        const continuation = entry.turnOpen
          ? undefined
          : entry.queue.waiting.find((w) => w.continuationId);
        if (
          gated &&
          !continuation &&
          !entry.queue.waiting.some((w) => canWake(w, entry))
        )
          break;
        const urgent =
          gated || continuation
            ? []
            : entry.queue.waiting.filter((w) => w.delivery === "interrupt");
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
              entry.queue.waiting.splice(entry.queue.waiting.indexOf(w), 1);
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
              for (const w of entry.queue.waiting.filter(
                (w) =>
                  w.delivery === "interrupt" &&
                  w.interruptTargetSeq === targetSeq
              )) {
                entry.queue.waiting.splice(entry.queue.waiting.indexOf(w), 1);
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
          const index = entry.queue.waiting.findIndex(
            (w) =>
              (!gated || canWake(w, entry)) &&
              (w.delivery === "auto" || (gated && canWake(w, entry))) &&
              !w.requiresPrompt &&
              !w.steering?.pending &&
              !(
                isUserPost(w) &&
                entry.queue.waiting
                  .slice(0, entry.queue.waiting.indexOf(w))
                  .some(
                    (earlier) =>
                      (!gated || canWake(earlier, entry)) &&
                      isUserPost(earlier) &&
                      earlier.steering?.pending
                  )
              ) &&
              steers(w, entry)
          );
          if (index < 0) break;
          batch = entry.queue.waiting.splice(index, 1);
        } else {
          for (const w of entry.queue.waiting) finishDecision(w, "expired");
          batch = continuation
            ? entry.queue.waiting.splice(
                entry.queue.waiting.indexOf(continuation),
                1
              )
            : takeBatch(entry.queue.waiting);
        }
        for (const w of batch) w.taken = true;
        const { text: combined, source } = combine(batch);
        const id = batch[0]!.continuationId ?? crypto.randomUUID();
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
            w.wakeTurnSeq = undefined;
          }
          // Keep declined input ahead of ordinary queued work, but behind
          // interrupts that arrived while the request was pending.
          const firstOrdinary = entry.queue.waiting.findIndex(
            (w) => w.delivery !== "interrupt"
          );
          entry.queue.waiting.splice(
            firstOrdinary < 0 ? entry.queue.waiting.length : firstOrdinary,
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
          const inputs = batch.flatMap((item) => item.images ?? []);
          const prepared = inputs.some(
            (input) => input.runnerName !== undefined
          )
            ? await deps.preparePromptFiles?.(agentId, inputs, combined)
            : { images: inputs, text: combined };
          if (!prepared)
            throw new Error("Prompt file delivery is unavailable.");
          const { images, text } = prepared;
          if (steering) {
            if (
              (gated || held(entry)) &&
              !batch.every((w) => canWake(w, entry))
            ) {
              for (const w of batch) finishDecision(w, "queued");
              await requeue();
              continue;
            }
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
            if (
              !continuation &&
              deps.holds?.current(entry.runnerId)?.draining
            ) {
              await requeue();
              continue;
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
              images.length ? images : undefined,
              () => !batch.some((w) => w.signal?.aborted)
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
          if (
            error instanceof RunnerUpdateFenced &&
            !submitted &&
            held(entry)
          ) {
            // The runner refused file delivery under its update fence: none
            // of it started. Back into the queue to go out on release.
            await requeue();
            continue;
          }
          entry.settleWaiters = entry.settleWaiters.filter(
            (w) => w !== onSettle
          );
          for (const w of batch) finishDecision(w, "failed");
          if (
            submitted &&
            !(
              isUpdateAcknowledgementLost(error) &&
              entry.client.isReady() &&
              (error.receipt === "claimed" ||
                (error.receipt === undefined &&
                  entry.client.welcome?.turn != null))
            )
          )
            entry.turnOpen = false;
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
      for (const w of entry.queue.waiting) finishDecision(w, "expired");
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
      if (!preserving(entry))
        failWaiting(entry, new Error("The agent exited before delivery."));
      const waiters = entry.settleWaiters;
      entry.settleWaiters = [];
      for (const resolve of waiters) resolve();
    }
    const journalId = entry.journalId;
    const inbox = seq > 0 && journalId ? entry.inbox : undefined;
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
      agentId,
      inbox: placement ? deps.remoteInbox : undefined,
      runnerId: runnerIdAt(placement),
      client: null as unknown as HostSessionClient,
      commands: [],
      configOptions: [],
      pumping: false,
      queue: recycleHolds.get(agentId)?.entry.queue ?? {
        waiting: [],
        pending: 0,
      },
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
    // A replacement replays the old host's exit; that ends no held work.
    const replaced = recycleHolds.get(agentId);
    if (replaced?.forced && replaced.restarting) replaced.entry = entry;
    entry.client = createHostSessionClient({
      agentId,
      remote: Boolean(placement),
      openSocket: async () => {
        if (placement) await entry.events;
        // No await before the request: it goes over exactly this connection.
        const epoch = deps.remote?.connectionEpoch?.(entry.runnerId);
        const { channel } = await requestSession(placement, {
          kind: "attach",
          agentId,
        });
        if (!channel) throw new Error("Runner returned no session channel");
        entry.channelEpoch = epoch ?? undefined;
        return channel;
      },
      reconnectError: hostReconnectDisposition,
      // A host that is ready again takes the input queued while it was not.
      onReady: () => void pump(agentId, entry),
      updateDeadline: () => {
        const hold = deps.holds?.current(entry.runnerId);
        return hold ? Date.parse(hold.expiresAt) : undefined;
      },
      logger,
      fromSeq: () => (entry.inbox ? entry.durableSeq : entry.lastSeq),
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
        if (live.get(agentId) !== entry) return;
        logger.warn({ agentId, reason }, "agent host is gone");
        live.delete(agentId);
        entry.client.close();
        if (preserving(entry)) return;
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
      await entry.client.connect(
        timeoutMs,
        abandoned,
        recycleHolds.get(agentId)?.restarting === true
      );
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
      entry.queue.pending -= 1;
    });
    const requiresPrompt =
      opts?.images?.some(
        (input) =>
          input.runnerName === undefined ||
          isPromptImageMimeType(input.mimeType)
      ) ?? false;
    const wakeTurnSeq =
      opts?.delivery === "auto" &&
      !requiresPrompt &&
      entry.turnOpen &&
      !source?.scheduleId &&
      (source?.awaited ||
        (source?.correlatedReply &&
          source.conversation &&
          sameConversation(source.conversation, entry.conversation)))
        ? entry.turnSeq
        : undefined;
    const own: Waiting = {
      wakeTurnSeq,
      requiresPrompt,
      text,
      ...(opts?.beforeSubmit ? { beforeSubmit: opts.beforeSubmit } : {}),
      ...(opts?.onDeferred ? { onDeferred: opts.onDeferred } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.images?.length ? { images: opts.images } : {}),
      ...(source ? { source } : {}),
      ...(opts?.continuationId && { continuationId: opts.continuationId }),
      alone:
        opts?.delivery === "interrupt" ||
        opts?.alone === true ||
        source?.source !== "chat",
      // Images need an ACP prompt. A text attachment can still steer: its
      // file is put before the steer and the text names its path.
      delivery:
        opts?.delivery === "interrupt"
          ? "interrupt"
          : requiresPrompt || held(entry)
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
    if (own.continuationId) {
      entry.queue.waiting.unshift(own);
    } else if (own.delivery === "interrupt") {
      const firstOrdinary = entry.queue.waiting.findIndex(
        (w) => w.delivery !== "interrupt"
      );
      entry.queue.waiting.splice(
        firstOrdinary < 0 ? entry.queue.waiting.length : firstOrdinary,
        0,
        own
      );
    } else if (isUserPost(own)) {
      // A person's post goes ahead of queued agent and system traffic,
      // behind interrupts and the person's own earlier posts. A deferred
      // batch put back at the front may sit ahead of those posts.
      let after = entry.queue.waiting.length;
      while (after > 0 && !isUserPost(entry.queue.waiting[after - 1]!)) after--;
      const firstOther = entry.queue.waiting.findIndex(
        (w, i) => i >= after && w.delivery !== "interrupt" && !isUserPost(w)
      );
      entry.queue.waiting.splice(
        firstOther < 0 ? entry.queue.waiting.length : firstOther,
        0,
        own
      );
    } else {
      entry.queue.waiting.push(own);
    }
    entry.queue.pending += 1;
    if (
      deps.classifySteering &&
      own.delivery === "auto" &&
      isUserPost(own) &&
      !own.source?.steeringExcluded &&
      !own.source?.awaited &&
      !own.source?.scheduleId &&
      !own.requiresPrompt &&
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
        const index = entry.queue.waiting.indexOf(own);
        if (index < 0) return;
        entry.queue.waiting.splice(index, 1);
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

  deps.holds?.onRelease(({ runnerId }) => {
    for (const [agentId, entry] of live)
      if (entry.runnerId === runnerId) void pump(agentId, entry);
  });
  deps.holds?.countWith((runnerId) => {
    let prompts = 0;
    let scheduled = 0;
    for (const entry of live.values()) {
      if (entry.runnerId !== runnerId) continue;
      // Taken prompts have already left the queue.
      for (const w of entry.queue.waiting) {
        if (w.source?.scheduleId) scheduled++;
        else prompts++;
      }
    }
    return { prompts, scheduled };
  });

  /** Work queued for a held host goes on to its replacement, or fails. */
  function releaseHold(agentId: string, hold: RecycleHold) {
    if (recycleHolds.get(agentId) !== hold) return;
    recycleHolds.delete(agentId);
    const replacement = live.get(agentId);
    if (replacement) void pump(agentId, replacement);
    else
      failWaiting(
        hold.entry,
        new Error("The agent host is unavailable before delivery.")
      );
  }

  /**
   * A local launch that failed: the error with the host's log tail, after
   * the host (if any) is stopped. A child that did not come back in time
   * says so, so the agent's error names it.
   */
  async function launchFailed(agentId: string, err: unknown) {
    if (
      err instanceof RunnerCallError &&
      err.code === "unsupported" &&
      err.details === "engine_missing"
    )
      return new AgentError(err.message, 422);
    if (err instanceof RunnerCallError && err.code === "unavailable")
      return new Error(
        "The local runner did not come back in time; the agent was not started. Try again."
      );
    const message = err instanceof Error ? err.message : String(err);
    const tail = await readLogTail(agentId);
    // A host whose engine never came up has nothing to serve.
    await runtime.stop(agentId, true).catch(() => {});
    return new Error(`${message}${tail}`);
  }

  const identify = (entry: Live): RunnerHostIdentity => {
    const welcome = entry.client.welcome;
    return {
      agentId: entry.agentId,
      build: welcome?.hostBuild,
      instanceId: welcome?.hostInstanceId,
      quiesceSupported: welcome?.quiesceSupported === true,
      ...(entry.channelEpoch !== undefined &&
        entry.client.isReady() && { attachedEpoch: entry.channelEpoch }),
    };
  };

  runtime = {
    runnerHosts(runnerId) {
      return [...live.values()]
        .filter((entry) => entry.runnerId === runnerId)
        .map(identify);
    },

    async runnerHostAlive(runnerId, agentId) {
      const placement = await placementOf(agentId);
      if (runnerIdAt(placement) !== runnerId)
        throw new Error("No matching runner placement for this host.");
      const { value } = await requestSession(placement, {
        kind: "alive",
        agentId,
      });
      return value === true;
    },

    wakeRunnerDrain(runnerId) {
      for (const [agentId, entry] of live)
        if (entry.runnerId === runnerId) void pump(agentId, entry);
    },

    holdForRecycle(runnerId, host, drainEpoch, refused) {
      const { agentId } = host;
      const entry = live.get(agentId);
      const drain = drainEpoch !== undefined;
      let reason: string | undefined;
      if (!entry) reason = "host_not_attached";
      else if (entry.runnerId !== runnerId) reason = "placement_changed";
      else if (
        !host.instanceId ||
        entry.client.welcome?.hostInstanceId !== host.instanceId
      )
        reason = "host_instance_changed";
      else if (entry.client.welcome?.quiesceSupported !== true)
        reason = "quiesce_unsupported";
      else if (
        drain &&
        (entry.channelEpoch !== drainEpoch || !entry.client.isReady())
      )
        reason = "connection_changed";
      else if (drain && entry.turnOpen) reason = "turn_open";
      else if (drain && recycleHolds.has(agentId)) reason = "host_already_held";
      else if (!drain && held(entry))
        reason =
          deps.holds?.isHeld(entry.runnerId) === true
            ? "runner_update_hold"
            : "host_already_held";
      else if (entry.pumping) reason = "delivery_in_progress";
      else if (entry.deliveryInterrupts.size) reason = "interrupt_in_progress";
      if (reason || !entry) {
        refused?.(reason ?? "host_not_attached");
        return null;
      }
      const hold = { entry, restarting: false };
      recycleHolds.set(agentId, hold);
      let lease: HostQuiesceLease | null = null;
      const current = () =>
        live.get(agentId) === entry && lease?.current() === true;
      return {
        async quiesce() {
          lease = await entry.client.quiesce();
          return current();
        },
        current,
        async shutdown() {
          if (!current()) return false;
          hold.restarting = true;
          const accepted = await lease!.shutdown();
          if (!accepted) hold.restarting = false;
          return accepted;
        },
        release() {
          if (recycleHolds.get(agentId) !== hold) return;
          lease?.release();
          releaseHold(agentId, hold);
        },
      };
    },

    holdRunnerHosts(runnerId) {
      for (const [agentId, entry] of live)
        if (entry.runnerId === runnerId && !recycleHolds.has(agentId))
          recycleHolds.set(agentId, { entry, restarting: false, forced: true });
    },

    reattachRunnerHost(agentId) {
      const hold = recycleHolds.get(agentId);
      if (hold?.forced) hold.restarting = false;
    },

    releaseRunnerHost(agentId) {
      const hold = recycleHolds.get(agentId);
      if (hold?.forced) releaseHold(agentId, hold);
    },

    runnerHostSession(agentId) {
      const welcome = live.get(agentId)?.client.welcome;
      return welcome?.running ? welcome.sessionId : undefined;
    },

    disownRunnerHost(agentId) {
      const entry = live.get(agentId);
      if (entry) {
        live.delete(agentId);
        entry.client.close();
        failWaiting(
          entry,
          new Error("The agent host is unavailable before delivery.")
        );
      }
      // With no host to pass it to, releasing fails what the hold kept.
      const hold = recycleHolds.get(agentId);
      if (hold) releaseHold(agentId, hold);
    },

    releaseRunnerHosts(runnerId) {
      for (const [agentId, hold] of recycleHolds)
        if (hold.forced && hold.entry.runnerId === runnerId)
          releaseHold(agentId, hold);
    },

    async runnerTurn(agentId) {
      const entry = live.get(agentId);
      if (!entry) return null;
      const turn = { open: entry.turnOpen, seq: entry.turnSeq };
      await entry.events;
      return turn;
    },

    async interruptRunnerTurn(agentId, seq) {
      const entry = live.get(agentId);
      if (!entry) return true;
      if (!entry.turnOpen || entry.turnSeq !== seq) {
        await entry.events;
        return true;
      }
      // Reconnecting: the host's welcome says whether this turn still runs.
      if (!entry.client.isReady()) return false;
      if (!entry.client.welcome?.interruptSupported) return true;
      if (entry.interruptedTurnSeq !== seq) {
        entry.interruptedTurnSeq = seq;
        void entry.client
          .interrupt(crypto.randomUUID(), seq)
          .catch((err: unknown) => {
            if (entry.interruptedTurnSeq === seq)
              entry.interruptedTurnSeq = undefined;
            logger.warn(
              { err, agentId, seq },
              "could not interrupt a turn for the runner update"
            );
          });
      }
      return false;
    },

    async stopRunnerHost(runnerId, agentId) {
      const placement = await placementOf(agentId);
      if (runnerIdAt(placement) !== runnerId)
        throw new Error("No matching runner placement for this host.");
      const entry = live.get(agentId);
      let hold = recycleHolds.get(agentId);
      if (entry && hold?.entry !== entry) {
        hold = { entry, restarting: false, forced: true };
        recycleHolds.set(agentId, hold);
      }
      // Kept if the reply is lost: the host may still be exiting.
      if (hold) hold.restarting = true;
      await requestSession(placement, { kind: "stop", agentId, force: false });
      if (!entry) return;
      if (live.get(agentId) === entry) live.delete(agentId);
      entry.client.close();
      entry.turnOpen = false;
      for (const resolve of entry.settleWaiters.splice(0)) resolve();
      await entry.events;
    },

    async promptReceipt(agentId, id) {
      return live.get(agentId)?.client.promptReceipt(id);
    },
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
        beforeLaunchReconcile,
        requireResume,
        ...launch
      } = input;
      if (requireResume) {
        const previous = live.get(input.agentId);
        const forced = recycleHolds.get(input.agentId);
        // The manager found no host, so a channel that isn't ready is stale.
        if (previous && forced?.forced && !previous.client.isReady()) {
          forced.entry = previous;
          forced.restarting = true;
        }
        if (previous && preserving(previous)) {
          live.delete(input.agentId);
          previous.client.close();
          await previous.events;
        }
      }
      const request = launchRequest({
        ...input,
        programs:
          bins && binsToPrograms({ ...bins, adapter: config.acpAdapter }),
      });
      request.owner = (await deps.sessionOwner?.()) ?? null;
      await deps.recordLaunch?.(input.agentId, request.launchId);
      const launched = await requestLaunch(
        placement,
        {
          kind: "launch",
          agentId: input.agentId,
          launch: {
            ...launch,
            ...(request.owner !== null && { owner: request.owner }),
          },
        },
        request,
        beforeLaunchReconcile
      ).catch(async (error: unknown) => {
        if (!placement || error instanceof RunnerHostGone)
          throw await launchFailed(input.agentId, error);
        throw error;
      });
      const { launchExited } = launched;
      try {
        const entry = await connect(
          input.agentId,
          LAUNCH_TIMEOUT_MS,
          launchExited
        ).finally(() => launched.launchSettled?.());
        const welcome = entry.client.welcome;
        if (!welcome) throw new Error("no welcome from the agent host");
        const recycle = recycleHolds.get(input.agentId);
        if (
          (requireResume || recycle?.restarting) &&
          (!welcome.resumed || welcome.sessionId !== input.resumeSessionId)
        ) {
          if (requireResume) {
            // The resume coordinator already owns the fence for this attempt.
            await requestSession(placement, {
              kind: "stop",
              agentId: input.agentId,
              force: false,
            });
          } else await runtime.stop(input.agentId, false);
          const refused =
            "The replacement host could not resume the existing session.";
          // The same ID can still resume on another launch. A new one can't.
          throw welcome.sessionId === input.resumeSessionId
            ? new Error(refused)
            : new RunnerResumeRefused(refused);
        }
        if (requireResume && recycle?.forced) recycle.restarting = false;
        return { sessionId: welcome.sessionId, resumed: welcome.resumed };
      } catch (err) {
        if (requireResume || err instanceof RunnerResumeRefused) throw err;
        // When the runner cannot confirm the launch outcome, a host may
        // still be running and the reconciler will try to attach again.
        if (
          !launchExited &&
          (await runtime.isAlive(input.agentId).catch(() => true))
        )
          throw err;
        throw await launchFailed(input.agentId, err);
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
      if (current) return current.client.canReuseAttachment();
      const placement = await placementOf(agentId);
      if (placement && !deps.remote?.available(placement)) return false;
      if (recycleHolds.get(agentId)?.restarting) return false;
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
      if (entry?.client.isConnected() || recycleHolds.get(agentId)?.restarting)
        return true;
      const placement = await placementOf(agentId);
      try {
        const { value } = await requestSession(placement, {
          kind: "alive",
          agentId,
        });
        return value === true;
      } catch (error) {
        if (error instanceof RunnerRevoked) return false;
        if (isSessionUnavailable(error)) return true;
        throw error;
      }
    },

    prompt(agentId, text, source, opts) {
      const entry = live.get(agentId);
      const pending = connecting.get(agentId);
      const recycle = recycleHolds.get(agentId);
      if (recycle)
        return enqueuePrompt(
          entry ?? recycle.entry,
          agentId,
          text,
          source,
          opts
        );
      if (entry && entry.client.canQueueDuringAttach(Boolean(pending)))
        return enqueuePrompt(entry, agentId, text, source, opts);

      // Dispatch may finish starting while an already running remote host is
      // still reconnecting. Attach before the first send, sharing any replay
      // already under way. This path never retries a submitted prompt.
      const delivery = (async () => {
        const placement = deps.remote ? await placementOf(agentId) : null;
        if (!deps.remote || !placement)
          throw new Error(
            "The agent is not running; the prompt cannot be delivered."
          );
        // Across a held update the runner may be between supervisors.
        if (!pending) await deps.holds?.wait(placement);
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
        const entry = inputEntry(id);
        const prompt = entry?.queue.waiting.find(
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
                  prompt.requiresPrompt ||
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
        entry.queue.waiting.splice(entry.queue.waiting.indexOf(prompt), 1);
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
        const firstOrdinary = entry.queue.waiting.findIndex(
          (w) => w.delivery !== "interrupt"
        );
        entry.queue.waiting.splice(
          firstOrdinary < 0 ? entry.queue.waiting.length : firstOrdinary,
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
          prompt.delivery = held(entry) ? "queue" : "auto";
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
      const entry = inputEntry(agentId);
      return entry ? entry.turnOpen || entry.queue.pending > 0 : false;
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

    async stop(agentId, force = false, expectedLaunchId) {
      const placement = await placementOf(agentId);
      const entry = live.get(agentId);
      const detach = () => {
        if (!entry || live.get(agentId) !== entry) return;
        live.delete(agentId);
        if (!preserving(entry))
          failWaiting(entry, new Error("The agent stopped before delivery."));
      };
      try {
        await heldSessionRequest(
          placement,
          { kind: "stop", agentId, force, expectedLaunchId },
          () => {
            if (placement) return;
            // Native shutdown writes to the existing channel before the
            // supervisor's grace period starts. The enrolled supervisor
            // owns shutdown and the queue stays connected until it answers.
            detach();
            if (entry?.client.isConnected()) {
              try {
                entry.client.shutdown(force);
              } catch {
                // The connection closed during shutdown.
              }
            }
          }
        );
        detach();
      } catch (error) {
        if (isStopDeferred(error)) detach();
        throw error;
      } finally {
        if (entry && live.get(agentId) !== entry) entry.client.close();
      }
      const recycle = recycleHolds.get(agentId);
      if (recycle?.restarting) await recycle.entry.events;
    },

    async retryStop(agentId, force, placement, expectedLaunchId, ownerOnly) {
      const expectedOwner = ownerOnly ? await deps.sessionOwner?.() : undefined;
      if (ownerOnly && (!expectedOwner || !expectedLaunchId)) return;
      // A background attempt must not hold up a later Start while waiting
      // for an update. The runner can refuse admission until it thaws.
      await requestSession(placement, {
        kind: "stop",
        agentId,
        force,
        expectedLaunchId,
        ...(expectedOwner !== undefined && { expectedOwner }),
      });
    },

    async inspectNativeHost(agentId) {
      const { state } = await readLocalSession(localChild(), "session.alive", {
        session: sessionFromWire(agentId),
      });
      const process = { sessionHandle: agentId, processState: state };
      const entry = live.get(agentId);
      const welcome =
        process.processState === "live"
          ? (entry?.client.nativeWelcome() ?? null)
          : null;
      return {
        ...process,
        activity: welcome?.running
          ? runtime.isBusy(agentId)
            ? "busy"
            : "idle"
          : "unknown",
        attached: welcome !== null,
        capabilities: welcome
          ? {
              steering: welcome.steeringSupported === true,
              interrupt: welcome.interruptSupported === true,
              mcpInventory: welcome.mcpInventorySupported === true,
              backgroundWork: welcome.backgroundWorkSupported === true,
            }
          : null,
        cursor:
          welcome && entry
            ? {
                seq: entry.lastSeq,
                journalId: entry.journalId,
              }
            : null,
      };
    },

    async stopIdleHostForRecovery(agentId) {
      if (runtime.isBusy(agentId)) return false;
      const client = createHostSessionClient({
        agentId,
        remote: false,
        openSocket: async () => {
          const { channel } = await requestSession(null, {
            kind: "attach",
            agentId,
          });
          if (!channel) throw new Error("no channel to the agent host");
          return channel;
        },
        logger,
        fromSeq: () => Number.MAX_SAFE_INTEGER,
        journalId: () => null,
        onEvent: () => {},
        onWelcome: () => {},
        onGone: () => {},
      });
      try {
        const welcome = await client.connect(ATTACH_TIMEOUT_MS);
        if (
          welcome.agentId !== agentId ||
          welcome.turn ||
          runtime.isBusy(agentId)
        )
          return false;
        client.shutdown(false, true);
        // The child waits for it to exit and never signals it (served while
        // the runner is frozen for an update's probation).
        try {
          await callLocalSession(localChild(), "session.stop", {
            session: sessionFromWire(agentId),
            force: false,
            idleOnly: true,
          });
        } catch (error) {
          if (error instanceof RunnerCallError && error.code === "busy")
            return false;
          throw error;
        }
        const entry = live.get(agentId);
        if (entry) {
          live.delete(agentId);
          if (!preserving(entry))
            failWaiting(entry, new Error("The agent stopped before delivery."));
          entry.client.close();
        }
        return true;
      } catch {
        return false;
      } finally {
        client.close();
      }
    },

    async listSessions(placement, ownerOnly) {
      const owner = ownerOnly ? await deps.sessionOwner?.() : null;
      if (owner === undefined) return undefined;
      if (!placement)
        return readLocalSession(localChild(), "session.list", { owner });
      const result = await deps.remote?.call(placement, "session.list", {
        owner,
      });
      if (result === undefined) return undefined;
      if (!operations["session.list"].response.check(result))
        throw new Error("Invalid runner session list");
      return result;
    },

    async listRunnerSessions(runnerId) {
      if (!deps.remote?.available(runnerId)) return undefined;
      return runtime.listSessions!(runnerId);
    },

    inventoryLiveness() {
      const lists = new Map<string, Promise<Res<"session.list"> | undefined>>();
      return async (agentId) => {
        if (
          live.get(agentId)?.client.isConnected() ||
          recycleHolds.get(agentId)?.restarting
        )
          return true;
        const placement = await placementOf(agentId);
        const key = JSON.stringify(placement);
        let list = lists.get(key);
        if (!list) {
          list = runtime.listSessions!(placement).catch((error) => {
            if (placement && isSessionUnavailable(error)) return undefined;
            throw error;
          });
          lists.set(key, list);
        }
        const inventory = await list;
        return inventory
          ? inventory.sessions.some(
              (session) =>
                sessionToWire(session.session) === agentId &&
                session.state === "live"
            )
          : runtime.isAlive(agentId);
      };
    },

    async listHosted() {
      const inventory = await runtime.listSessions!(null);
      return (inventory?.sessions ?? [])
        .filter((entry) => entry.state === "live")
        .map((entry) => sessionToWire(entry.session))
        .filter((id) => id.startsWith("agt_"));
    },

    async sampleSessions(placement, agentIds) {
      if (!agentIds.length) return [];
      const request = { sessions: agentIds.map(sessionFromWire) };
      if (!placement)
        return (await readLocalSession(localChild(), "session.sample", request))
          .samples;
      const result = await deps.remote?.call(
        placement,
        "session.sample",
        request
      );
      if (result === undefined) return [];
      if (!operations["session.sample"].response.check(result))
        throw new Error("Invalid runner session samples");
      return result.samples;
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    readLogTail,

    async clearRemoteState(agentId) {
      await removeHostState(config.agentStateRoot, agentId);
    },

    async discard(agentId) {
      const placement = await placementOf(agentId);
      const operation = { kind: "discard", agentId } as const;
      await heldSessionRequest(placement, operation);
      const entry = live.get(agentId);
      if (entry) {
        live.delete(agentId);
        entry.client.close();
      }
      if (placement) await removeHostState(config.agentStateRoot, agentId);
    },
  };
  return runtime;
}
