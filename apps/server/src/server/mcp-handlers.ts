import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AgentManager, AgentRecord } from "../agents/manager.js";
import type { PinSpec } from "../agents/pin-write.js";
import { AgentError } from "../agents/errors.js";
import type { AgentPin, WorktreeCleanupMode } from "../agents/types.js";
import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
} from "../agent-type-settings.js";
import { validateAgentModel } from "../shared/agent-models.js";
import { isCrossRepoMessagingEnabled } from "../cross-repo-messaging-settings.js";
import type { JobService } from "../jobs/service.js";
import type { TemplateService } from "../templates/service.js";
import { templateWorktreeConfig } from "../templates/worktree-config.js";
import { renderTemplatePromptFromFreeText } from "../templates/launch-prompt.js";
import type {
  NotifyInput,
  NotifyResult,
  SlackNotifier,
} from "../notifications/slack.js";
import {
  AGENT_LATEST_EVENT_TYPES,
  isAgentLatestEventType,
} from "../agents/latest-event.js";
import {
  isPinType,
  validatePinShortcutFields,
  validatePinCaption,
  validatePinValue,
  type PinShortcutVariant,
} from "../pins.js";
import {
  toPinListing,
  toPinSummary,
  type PinListing,
  type PinSummary,
} from "./pin-listing.js";
import {
  createLineageIndex,
  delegationChain,
  formatDelegationChain,
  isFamily,
  relationTo,
  sanitizeAgentNameForPrompt,
  type AgentRelation,
} from "../agents/lineage.js";
import { resolveRepoRoot } from "../shared/git/git-context.js";
import { isMediaFile, isTextFile, resolveMediaDir } from "../shared/media.js";
import type { ListedMediaItem } from "../shared/mcp/agent-lifecycle-tools.js";
import type {
  EnqueueAgentPrompt,
  PublishUiEvent,
  SendAgentPrompt,
} from "./mcp-handler-types.js";
import { createReviewHandlers } from "./mcp-review-handlers.js";
import { MessageStore } from "../messages/store.js";
import { createWhiteboardHandlers } from "./mcp-whiteboard-handlers.js";
import {
  activatePersonality,
  createPersonality,
  deletePersonality,
  getActivePersonalityId,
  listPersonalities,
  setActivePersonalityId,
  updatePersonality,
} from "../db/personalities.js";
import { errorMessage } from "../shared/lib/error-message.js";
import { getWorktreeLocation } from "../worktree-location-settings.js";

function buildLaunchedAgentInitialPrompt(
  launcherAgentId: string,
  prompt: string,
  child: boolean
): string {
  const header = child
    ? [
        `You were launched by Dispatch agent "${launcherAgentId}" via dispatch_launch_agent.`,
        "Use that parent agent ID when coordinating back with dispatch_send_message.",
        // Stated up front because the tool call fails at the point of use
        // otherwise, halfway through work the agent has already planned around.
        "You are a child agent: you cannot launch child agents or persona reviews of your own. " +
          "If you need to hand work off, launch an independent agent with dispatch_launch_agent's `child: false`.",
        "Your parent's pins and media are readable: pass its id as ownerAgentId to dispatch_list_pins or " +
          "dispatch_list_media. A dev-stack URL or PR link it pinned is there without asking for it.",
      ]
    : [
        `You were launched by Dispatch agent "${launcherAgentId}" via dispatch_launch_agent as an independent agent — you are not its child.`,
        "Use that agent ID when coordinating back with dispatch_send_message.",
      ];
  return [...header, "", prompt].join("\n");
}

type CreateMcpHandlersDeps = {
  pool: Pool;
  mediaRoot: string;
  agentManager: AgentManager;
  jobService: JobService;
  // Only the template lookup is needed here — the full TemplateService can
  // launch agents, which the MCP handler layer has no business doing.
  templateService: Pick<TemplateService, "getTemplate">;
  slackNotifier: SlackNotifier;
  publishUiEvent: PublishUiEvent;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  sendAgentPrompt: SendAgentPrompt;
  /**
   * Enqueue-and-settle delivery for dispatch_send_message: the row records
   * the real outcome once the pane write completes instead of "enqueued".
   */
  enqueueAgentPrompt: EnqueueAgentPrompt;
  appLog: FastifyBaseLogger;
  /**
   * Claim an archive and run its teardown in the background. Archiving cannot
   * be awaited here: the target may be the caller, whose session the teardown
   * stops. Shared with the HTTP archive route's lifecycle runtime so the
   * teardown is still tracked at shutdown and still publishes UI events.
   */
  beginBackgroundArchive: (
    agentId: string,
    cleanupWorktree?: WorktreeCleanupMode,
    opts?: { startAfter?: () => Promise<void> }
  ) => Promise<AgentRecord>;
};

function normalizePersonalityDuplicateName(error: unknown): never {
  if (errorMessage(error).includes("personalities_name_key")) {
    throw new Error("A personality with that name already exists.");
  }
  throw error;
}

export function mcpMethodNotAllowed(): {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
} {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
    id: null,
  };
}

/**
 * The set of agents a sender may address via dispatch_send_message and
 * list_agents: every other agent (self excluded), scoped to the sender's git
 * repo root unless cross-repo messaging is enabled. Direct parent ↔ child
 * relationships always bypass repo-root scoping so spawned agents can
 * coordinate with their parent regardless of working directory, as does the
 * launcher ↔ launched pair for agents launched outside the lineage. This is the
 * single definition of that visibility boundary — both message delivery and
 * agent listing consult it, so they can never disagree about who is reachable.
 */
async function addressableAgents<
  T extends {
    id: string;
    cwd: string;
    parentAgentId?: string | null;
    launchedByAgentId?: string | null;
  },
>(
  all: T[],
  agentId: string,
  senderRepoRoot: string | null,
  crossRepo: boolean
): Promise<T[]> {
  const sender = all.find((a) => a.id === agentId);
  const senderParentId = sender?.parentAgentId ?? null;
  const senderLauncherId = sender?.launchedByAgentId ?? null;

  const result: T[] = [];
  for (const a of all) {
    if (a.id === agentId) continue;
    if (crossRepo) {
      result.push(a);
      continue;
    }
    // Direct parent ↔ child always visible. parentAgentId is trusted because
    // MCP-originated creation sets it server-side; the HTTP path is localhost-only.
    if (a.id === senderParentId || a.parentAgentId === agentId) {
      result.push(a);
      continue;
    }
    // A `child: false` launch has no parent but still needs to coordinate with
    // whoever launched it — the same reason the parent ↔ child bypass exists.
    if (a.id === senderLauncherId || a.launchedByAgentId === agentId) {
      result.push(a);
      continue;
    }
    try {
      const aRoot = await resolveRepoRoot(a.cwd);
      if (aRoot === senderRepoRoot) result.push(a);
    } catch {
      // agent cwd not in a git repo — skip
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Extracted handler functions
// ---------------------------------------------------------------------------

async function handleUpsertEvent(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  event: { type: string; message: string; metadata?: Record<string, unknown> }
): Promise<void> {
  if (!isAgentLatestEventType(event.type)) {
    throw new Error(
      `type must be one of: ${AGENT_LATEST_EVENT_TYPES.join(", ")}.`
    );
  }
  const agent = await deps.agentManager.upsertLatestEvent(agentId, {
    type: event.type,
    message: event.message.trim(),
    metadata: event.metadata,
  });
  deps.publishUiEvent({
    type: "agent.upsert",
    agent: deps.withStreamFlag(agent),
  });
}

async function handleSendNotify(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  input: NotifyInput
): Promise<NotifyResult> {
  const agent = await deps.agentManager.getAgent(agentId);
  if (!agent) throw new Error("Agent not found.");
  return deps.slackNotifier.sendNotification(agent, input);
}

type PinInput = {
  id?: string;
  label: string;
  value?: string;
  type?: string;
  caption?: string;
  group?: string;
  icon?: string;
  variant?: string;
  confirm?: boolean;
  disabled?: boolean;
};

/**
 * Narrow one pin spec to a storable shape.
 *
 * Shared by the single and batch write paths so a pin the batch tool accepts
 * is exactly a pin `dispatch_pin` would have accepted — a batch must not
 * become a way to smuggle in a shape the single-pin validator rejects.
 *
 * An omitted `type` stays omitted rather than defaulting: the write layer
 * inherits the stored pin's type, so relabelling a shortcut cannot silently
 * demote it to a plain string and strip its icon. Validation of the value
 * happens there too, once the effective type is known.
 */
function toValidatedPin(pin: PinInput): PinSpec {
  if (pin.type !== undefined && !isPinType(pin.type)) {
    throw new Error(`Invalid pin type: ${pin.type}`);
  }
  // Only a spec carrying both can be checked here; anything relying on an
  // inherited type or value is validated in `pin-write` once merged.
  if (pin.type !== undefined && pin.value !== undefined) {
    validatePinValue(pin.type, pin.value);
  }

  // Captions and grouping are generic; button styling, confirmation, and the
  // disabled state only mean anything for shortcut pins — silently dropping
  // those elsewhere keeps stored pins honest. With no type given we cannot
  // tell yet, so they ride along and `mergePin` strips them if the resolved
  // type turns out not to be shortcut.
  if (pin.caption !== undefined) {
    validatePinCaption(pin.caption);
  }
  const isShortcut = pin.type === "shortcut";
  if (isShortcut) {
    validatePinShortcutFields(pin);
  }
  const keepShortcutFields = pin.type === undefined || isShortcut;

  return {
    ...(pin.id !== undefined ? { id: pin.id } : {}),
    label: pin.label,
    ...(pin.value !== undefined ? { value: pin.value } : {}),
    ...(pin.type !== undefined ? { type: pin.type } : {}),
    ...(pin.caption !== undefined ? { caption: pin.caption } : {}),
    ...(pin.group !== undefined ? { group: pin.group } : {}),
    ...(keepShortcutFields && pin.icon !== undefined ? { icon: pin.icon } : {}),
    ...(keepShortcutFields && pin.variant !== undefined
      ? { variant: pin.variant as PinShortcutVariant }
      : {}),
    ...(keepShortcutFields && pin.confirm !== undefined
      ? { confirm: pin.confirm }
      : {}),
    ...(keepShortcutFields && pin.disabled !== undefined
      ? { disabled: pin.disabled }
      : {}),
  };
}

async function handleUpsertPin(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  pin: PinInput
): Promise<{ pin: PinListing; created: boolean }> {
  const result = await deps.agentManager.upsertPin(
    agentId,
    toValidatedPin(pin)
  );
  deps.publishUiEvent({
    type: "agent.upsert",
    agent: deps.withStreamFlag(result.agent),
  });
  return { pin: toPinListing(result.pin), created: result.created };
}

async function handleUpsertPins(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  input: {
    pins: PinInput[];
    mode?: "merge" | "replace";
    group?: string;
  }
): Promise<PinSummary[]> {
  // Validate the whole batch before opening the transaction: a bad entry at
  // position 19 should fail the call outright rather than leave the first
  // eighteen applied. Replace mode files entries under the scoping group
  // itself, so nothing needs stamping here.
  const specs = input.pins.map(toValidatedPin);

  const { agent } = await deps.agentManager.upsertPins(agentId, specs, {
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.group !== undefined ? { group: input.group } : {}),
  });
  deps.publishUiEvent({
    type: "agent.upsert",
    agent: deps.withStreamFlag(agent),
  });
  // A thin projection, not the full listing: the point of the echo is to show
  // what the batch produced and in what order, and 50 pins' worth of values
  // (2000 chars each) would dwarf that. dispatch_list_pins serves full state.
  return (agent.pins ?? []).map(toPinSummary);
}

async function handleDeletePin(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  input: { id?: string; ids?: string[]; group?: string }
): Promise<void> {
  const targets = [input.id, input.ids, input.group].filter(
    (target) => target !== undefined
  );
  if (targets.length !== 1) {
    throw new Error("Pass exactly one of id, ids, or group.");
  }

  const agent = input.group
    ? await deps.agentManager.deletePinsByGroup(agentId, input.group)
    : await deps.agentManager.deletePinsByIds(
        agentId,
        input.ids ?? [input.id!]
      );
  deps.publishUiEvent({
    type: "agent.upsert",
    agent: deps.withStreamFlag(agent),
  });
}

async function handleDeletePinByLabel(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  label: string
): Promise<void> {
  const agent = await deps.agentManager.deletePinByLabel(agentId, label);
  deps.publishUiEvent({
    type: "agent.upsert",
    agent: deps.withStreamFlag(agent),
  });
}

type ReadableOwner = {
  id: string;
  name: string;
  mediaDir: string | null;
  pins: AgentPin[];
};

/**
 * The agent whose pins or media a read tool should return: the caller itself,
 * or — when `ownerAgentId` is given — its parent or one of its direct children
 * (see `isFamily`). Anything else is "not found", the way surfaces answer a
 * non-child owner: the tool neither confirms nor denies the agent exists.
 *
 * Reads the table directly rather than through `agentManager.getAgent`, which
 * filters out archived rows. Media outlives an archive, and a parent that has
 * already archived a finished child still needs that child's screenshots to
 * write its report — so a family read works on an archived owner too.
 */
async function resolveReadableOwner(
  deps: CreateMcpHandlersDeps,
  requesterId: string,
  ownerAgentId: string | undefined
): Promise<ReadableOwner> {
  const ownerId = ownerAgentId ?? requesterId;
  const result = await deps.pool.query<{
    id: string;
    name: string;
    media_dir: string | null;
    pins: AgentPin[] | null;
    parent_agent_id: string | null;
  }>(
    `SELECT id, name, media_dir, COALESCE(pins, '[]'::jsonb) AS pins, parent_agent_id
     FROM agents WHERE id = ANY($1::text[])`,
    [Array.from(new Set([requesterId, ownerId]))]
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const requester = byId.get(requesterId);
  const owner = byId.get(ownerId);
  if (
    !requester ||
    !owner ||
    !isFamily(
      {
        id: requester.id,
        name: requester.name,
        parentAgentId: requester.parent_agent_id,
      },
      { id: owner.id, name: owner.name, parentAgentId: owner.parent_agent_id }
    )
  ) {
    throw new Error("Agent not found.");
  }
  return {
    id: owner.id,
    name: owner.name,
    mediaDir: owner.media_dir,
    pins: owner.pins ?? [],
  };
}

async function handleListPins(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  opts: { ownerAgentId?: string } = {}
): Promise<PinListing[]> {
  const owner = await resolveReadableOwner(deps, agentId, opts.ownerAgentId);
  // Decorations are listed too, so an agent can see what a pin already has
  // (its group, caption, icon) before deciding what to change.
  return owner.pins.map(toPinListing);
}

async function handleRenameSession(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  name: string
): Promise<{ id: string; name: string }> {
  const agent = await deps.agentManager.renameAgent(agentId, name);
  deps.publishUiEvent({
    type: "agent.upsert",
    agent: deps.withStreamFlag(agent),
  });
  return { id: agent.id, name: agent.name };
}

async function handleJobComplete(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  report: unknown
): Promise<{ runId: string; status: string }> {
  const run = await deps.jobService.completeRunForAgent(agentId, report);
  return { runId: run.id, status: run.status };
}

async function handleJobFailed(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  report: unknown
): Promise<{ runId: string; status: string }> {
  const run = await deps.jobService.failRunForAgent(agentId, report);
  return { runId: run.id, status: run.status };
}

async function handleJobNeedsInput(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  question: string
): Promise<{ runId: string; status: string }> {
  const run = await deps.jobService.markNeedsInputForAgent(agentId, question);
  return { runId: run.id, status: run.status };
}

async function handleJobLog(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  input: {
    task: string;
    message: string;
    level: "debug" | "info" | "warn" | "error";
  }
): Promise<{ runId: string; status: string }> {
  const run = await deps.jobService.logForAgent(agentId, input);
  return { runId: run.id, status: run.status };
}

async function handleLaunchAgent(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  input: {
    name: string;
    prompt: string;
    type?: string;
    model?: string;
    useWorktree?: boolean;
    createNewBranch?: boolean;
    baseBranch?: string;
    worktreeBranch?: string;
    fullAccess?: boolean;
    templateId?: string;
    templateArgs?: Record<string, string>;
    cwd?: string;
    child?: boolean;
  }
): Promise<{ agentId: string; name: string; note?: string }> {
  const parent = await deps.agentManager.getAgent(agentId);
  if (!parent) throw new Error("Parent agent not found.");
  const child = input.child !== false;
  // Depth cap: the sidebar renders a child as a row inside its parent's card,
  // and that row has nowhere to render children of its own — a grandchild would
  // simply stop being visible. So a child may only launch outside the lineage.
  if (child && parent.parentAgentId) {
    throw new AgentError(
      "This agent was itself launched as a child agent, and child agents cannot launch further children " +
        "(the UI only renders one level of sub agents). Pass child: false to launch an independent, " +
        "top-level agent instead.",
      409
    );
  }
  // An archive stops the parent moments from now and sweeps its children with
  // it — so a child launched after the archive was claimed would be torn down
  // the instant it started, or miss the cascade and be orphaned. True whoever
  // claimed that archive; the window is simply widest when the parent archived
  // itself and is still alive to make this very call.
  if (parent.status === "archiving") {
    throw new AgentError(
      "This agent is being archived; it cannot launch new agents.",
      409
    );
  }

  const agentType = input.type ?? parent.type ?? "claude";
  if (
    !CLI_AGENT_TYPES.includes(agentType as (typeof CLI_AGENT_TYPES)[number])
  ) {
    throw new Error(
      `Unsupported agent type "${agentType}". Must be one of: ${CLI_AGENT_TYPES.join(", ")}.`
    );
  }

  const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
  if (
    !enabledAgentTypes.includes(agentType as (typeof CLI_AGENT_TYPES)[number])
  ) {
    throw new Error(`${agentType} agents are disabled in settings.`);
  }

  // A templateId means "launch this the way the template says to". Its prompt
  // is rendered the same way the web UI's launch form renders it, and its
  // worktree config fills in whatever the caller left unset; anything passed
  // explicitly at the call site still wins.
  const template = input.templateId
    ? await deps.templateService.getTemplate(input.templateId)
    : null;
  if (input.templateId && !template) {
    throw new Error(`Template ${input.templateId} not found.`);
  }

  const fromTemplate = templateWorktreeConfig(template);

  const parentCwd = parent.worktreePath ?? parent.cwd;
  const useWorktree = input.useWorktree ?? fromTemplate.useWorktree;
  // Templates have no createNewBranch column, so the decision keys off where
  // the worktree came from: a template-supplied one follows the template's
  // branch policy and gets a fresh branch, matching how
  // TemplateService.launchTemplate leaves the field to the agent manager's
  // default. An explicit useWorktree with no template keeps the old default of
  // false so existing callers don't change behaviour.
  const worktreeFromTemplate = fromTemplate.useWorktree;
  const createNewBranch = input.createNewBranch ?? worktreeFromTemplate;
  const baseBranch = input.baseBranch ?? fromTemplate.baseBranch;
  const worktreeBranch = input.worktreeBranch ?? fromTemplate.worktreeBranch;
  const fullAccess = parent.fullAccess && input.fullAccess !== false;

  // Placement is an instance-wide setting the web UI already honours; without
  // this the MCP path silently forced "sibling".
  const worktreeLocation = await getWorktreeLocation(deps.pool);

  const cliSessionId = agentType === "claude" ? randomUUID() : undefined;
  const model = validateAgentModel(
    agentType as (typeof CLI_AGENT_TYPES)[number],
    input.model
  );

  // Launching a template is a request for the template's own instructions —
  // without this the caller's short prompt was the agent's entire prompt and
  // every one of the template's instructions was silently dropped.
  let prompt = input.prompt;
  let unfilled: string[] = [];
  let unknownArgs: string[] = [];
  if (template?.prompt) {
    const rendered = renderTemplatePromptFromFreeText(
      { ...template, prompt: template.prompt },
      input.prompt,
      input.templateArgs
    );
    prompt = rendered.prompt;
    unfilled = rendered.unfilled;
    unknownArgs = rendered.unknownArgs;
  }

  const agent = await deps.agentManager.createAgent({
    name: input.name,
    type: agentType as (typeof CLI_AGENT_TYPES)[number],
    cwd: input.cwd ?? parentCwd,
    fullAccess,
    model,
    useWorktree,
    createNewBranch,
    baseBranch,
    worktreeBranch,
    worktreeLocation,
    ...(child ? { parentAgentId: agentId } : {}),
    launchedByAgentId: agentId,
    cliSessionId,
    initialPrompt: buildLaunchedAgentInitialPrompt(agentId, prompt, child),
    // The feed shows the prompt as the launcher wrote it, not the rendered
    // template instructions or the launch header.
    launchContext: { prompt: input.prompt },
    templateId: input.templateId,
  });

  deps.publishUiEvent({
    type: "agent.upsert",
    agent: deps.withStreamFlag(agent),
  });

  // Empty args and misspelled keys are the quiet failure modes of this path, so
  // say so rather than letting the caller assume the template rendered in full.
  const notes: string[] = [];
  if (unknownArgs.length > 0) {
    notes.push(
      `Unrecognized templateArgs, nothing used them: ${unknownArgs.join(", ")}. get_template lists the template's promptArgs.`
    );
  }
  if (unfilled.length > 0) {
    notes.push(
      `Template args left empty: ${unfilled.join(", ")}. Pass templateArgs to fill them.`
    );
  }
  const note = notes.length > 0 ? notes.join(" ") : undefined;
  return { agentId: agent.id, name: agent.name, ...(note ? { note } : {}) };
}

/**
 * Grace period after the response is on the wire before teardown begins,
 * covering the gap between the kernel accepting the bytes and the agent
 * process reading them. Only matters when an agent archives itself — it is the
 * one waiting on that response.
 */
const ARCHIVE_RESPONSE_SETTLE_MS = 750;

/** Backstop, so a transport that never ends the stream can't stall an archive. */
const ARCHIVE_RESPONSE_TIMEOUT_MS = 5_000;

async function handleArchiveAgent(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  input: {
    agentId: string;
    cleanupWorktree?: WorktreeCleanupMode;
    whenResponseFinished?: () => Promise<void>;
  }
): Promise<{ agentId: string; name: string; archiving: true }> {
  const target = await deps.agentManager.getAgent(input.agentId);
  if (!target) throw new AgentError("Agent not found.", 404);
  // launchedByAgentId rather than parentAgentId alone: a `child: false` launch
  // has no parent, but the launcher still owns the session it created.
  if (
    target.id !== agentId &&
    target.parentAgentId !== agentId &&
    target.launchedByAgentId !== agentId
  ) {
    throw new AgentError(
      "You can only archive yourself or an agent you launched via dispatch_launch_agent or dispatch_launch_persona.",
      403
    );
  }

  // A job agent leaves by reporting its outcome, not by being archived: the
  // run is auto-archived once it reaches a terminal state. Archiving around
  // that reports the run as crashed and pages whoever the job notifies. Only
  // agent-initiated archives are blocked — the UI and the job runner still need
  // to be able to archive a job agent that has genuinely gone wrong.
  const activeRun = await deps.jobService.getActiveRunForAgent(target.id);
  if (activeRun) {
    throw new AgentError(
      `Agent "${target.name}" has an active job run (${activeRun.id}). ` +
        "A job agent ends its run by reporting the outcome — job_complete, job_failed, or job_needs_input — " +
        "and is archived automatically once the run reaches a terminal state.",
      409
    );
  }

  // Teardown runs in the background rather than being awaited: when the target
  // is the caller, awaiting it would mean killing the session that is waiting
  // for this response. Holding teardown until the response is written costs a
  // child archive nothing, so both targets take the same path.
  const archiving = await deps.beginBackgroundArchive(
    target.id,
    input.cleanupWorktree ?? "auto",
    {
      startAfter: async () => {
        const delay = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        if (input.whenResponseFinished) {
          await Promise.race([
            input.whenResponseFinished(),
            delay(ARCHIVE_RESPONSE_TIMEOUT_MS),
          ]);
        }
        await delay(ARCHIVE_RESPONSE_SETTLE_MS);
      },
    }
  );

  return { agentId: target.id, name: archiving.name, archiving: true };
}

async function handleShareMedia(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  opts: {
    filePath: string;
    description: string;
    source?: string;
    name?: string;
    update?: string;
  }
): Promise<{
  fileName: string;
  url: string;
  sizeBytes: number;
  source: string;
  description: string;
}> {
  const agent = await deps.agentManager.getAgent(agentId);
  if (!agent) throw new Error("Agent not found.");

  if (!isMediaFile(opts.filePath)) {
    throw new Error(
      "Unsupported file type. Use images (png/jpg/gif/webp), video (mp4), documents (pdf), or text files (txt/md/json/yaml/ts/py/etc)."
    );
  }

  const isText = isTextFile(opts.filePath);
  const validSources = ["screenshot", "stream", "simulator", "text"];
  const source = isText
    ? "text"
    : opts.source && validSources.includes(opts.source)
      ? opts.source
      : "screenshot";

  const buffer = await readFile(opts.filePath);
  const mediaDir = resolveMediaDir(agentId, agent.mediaDir, deps.mediaRoot);
  await mkdir(mediaDir, { recursive: true });

  if (opts.update) {
    const existing = await deps.pool.query<{ file_name: string }>(
      `SELECT file_name FROM media WHERE agent_id = $1 AND file_name = $2 FOR UPDATE`,
      [agentId, opts.update]
    );
    if (existing.rows.length === 0) {
      throw new Error(
        "No media file found with the given fileName for this agent."
      );
    }

    const fileName = existing.rows[0].file_name;
    const filePath = path.join(mediaDir, fileName);
    const resolvedMediaDir = path.resolve(mediaDir);
    if (!path.resolve(filePath).startsWith(resolvedMediaDir + path.sep)) {
      throw new Error("Invalid media file path.");
    }

    await writeFile(filePath, buffer);
    await deps.pool.query(
      `UPDATE media SET size_bytes = $1, description = $2, updated_at = NOW()
       WHERE agent_id = $3 AND file_name = $4`,
      [buffer.length, opts.description, agentId, fileName]
    );

    deps.publishUiEvent({ type: "media.changed", agentId });
    return {
      fileName,
      url: `/api/v1/agents/${agentId}/media/${encodeURIComponent(fileName)}`,
      sizeBytes: buffer.length,
      source,
      description: opts.description,
    };
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-")
    .replace("Z", "");
  const baseName = opts.name ?? path.basename(opts.filePath);
  const ext0 = path.extname(baseName).toLowerCase();
  const fallbackExt =
    ext0 === ".mp4" ? ".mp4" : isText ? ext0 || ".txt" : ".png";
  const safeName =
    baseName.replace(/ /g, "-").replace(/[^A-Za-z0-9._-]/g, "") ||
    `shared-${timestamp}${fallbackExt}`;
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  const fileName = `${base}-${timestamp}${ext}`;

  await writeFile(path.join(mediaDir, fileName), buffer);
  await deps.pool.query(
    `INSERT INTO media (agent_id, file_name, source, size_bytes, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [agentId, fileName, source, buffer.length, opts.description]
  );

  deps.publishUiEvent({ type: "media.changed", agentId });
  return {
    fileName,
    url: `/api/v1/agents/${agentId}/media/${encodeURIComponent(fileName)}`,
    sizeBytes: buffer.length,
    source,
    description: opts.description,
  };
}

async function handleSendMessage(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  input: { target: string; message: string; senderRepoRoot: string | null }
): Promise<{
  delivered: boolean;
  targetAgentId: string;
  targetAgentName: string;
}> {
  const sender = await deps.agentManager.getAgent(agentId);
  if (!sender) throw new Error("Sender agent not found.");

  const senderRepoRoot = input.senderRepoRoot;
  const crossRepo = await isCrossRepoMessagingEnabled(deps.pool);

  const everyAgent = await deps.agentManager.listAgents();
  const allAgents = await addressableAgents(
    everyAgent,
    agentId,
    senderRepoRoot,
    crossRepo
  );

  const isAgentId = input.target.startsWith("agt_");

  let target: (typeof allAgents)[number] | undefined;
  if (isAgentId) {
    target = allAgents.find((a) => a.id === input.target);
  } else {
    const lowerTarget = input.target.toLowerCase();
    const matches = allAgents.filter(
      (a) =>
        a.status === "running" && a.name.toLowerCase().includes(lowerTarget)
    );
    if (matches.length === 1) {
      target = matches[0];
    } else if (matches.length > 1) {
      const list = matches.map((a) => `  ${a.id} "${a.name}"`).join("\n");
      throw new Error(
        `Multiple agents match "${input.target}". Use the agent ID:\n${list}`
      );
    }
  }

  if (!target) {
    const running = allAgents
      .filter((a) => a.status === "running")
      .map((a) => `  ${a.id} "${a.name}"`)
      .join("\n");
    throw new Error(
      `No agent found matching "${input.target}".${running ? ` Running agents:\n${running}` : " No other agents are running."}`
    );
  }

  if (target.status !== "running") {
    throw new Error(
      `Agent "${target.name}" (${target.id}) is ${target.status}, not running.`
    );
  }

  // Provenance: without this the recipient sees only a sender name, so a
  // message from a grandchild is indistinguishable from one from a direct
  // child. Resolved against every agent so an unaddressable intermediate still
  // appears in the chain rather than collapsing two levels into one.
  const lineage = createLineageIndex(everyAgent);
  const senderRelation = relationTo(lineage, target.id, agentId);
  const chain = delegationChain(lineage, agentId, target.id);

  const envelope = JSON.stringify({
    from: sender.name,
    senderId: agentId,
    senderRelation,
    ...(chain.length > 1
      ? { delegationChain: chain.map((node) => `${node.name} (${node.id})`) }
      : {}),
    message: input.message,
    replyTarget: agentId,
  });
  // The prose line only fires when it tells the recipient something the sender
  // name alone does not: that the sender is further down its tree than a direct
  // child, or that the sender belongs to a tree the recipient is not part of.
  // A direct child's chain is just [child, you], so it stays silent.
  const recipientInChain = chain.some((node) => node.id === target.id);
  const provenanceLine =
    senderRelation === "descendant"
      ? `\nProvenance: ${sanitizeAgentNameForPrompt(sender.name)} is not your direct child — delegation chain: ${formatDelegationChain(chain, target.id)}.`
      : !recipientInChain && chain.length > 1
        ? `\nProvenance: ${formatDelegationChain(chain, target.id)}.`
        : "";
  const prompt = `--- DISPATCH MESSAGE ---\n${envelope}\n--- END MESSAGE ---${provenanceLine}\nOptional reply channel: If a response is necessary, use dispatch_send_message with the replyTarget above. Do not acknowledge routine status updates or completion messages unless a reply is explicitly requested.`;

  // Enqueue first: a persistence failure must never block delivery. The
  // handler returns once the prompt is queued — awaiting gated delivery can
  // exceed MCP client timeouts (~60s), and a timed-out sender retrying would
  // inject the message twice. Session validation happens before this resolves.
  let enqueued: Awaited<ReturnType<EnqueueAgentPrompt>> | null = null;
  let deliveryError: unknown = null;
  try {
    enqueued = await deps.enqueueAgentPrompt(target.id, prompt);
  } catch (err) {
    deliveryError = err;
    deps.appLog.error(
      { err, senderId: agentId, targetId: target.id },
      "dispatch_send_message: tmux delivery failed"
    );
  }
  // Attach the outcome handler at once so a fast rejection can never surface
  // as an unhandled rejection while the insert below is still in flight.
  const outcome: Promise<boolean> | null = enqueued
    ? enqueued.delivery.then(
        () => true,
        (err: unknown) => {
          deps.appLog.warn(
            { err, senderId: agentId, targetId: target.id },
            "dispatch_send_message: pane delivery failed — agent may have exited"
          );
          return false;
        }
      )
    : null;

  // Record the message (including failed enqueues) so it is viewable. A row
  // that was queued starts as delivered = null and settles below; the UI
  // renders null as "Sending". Persistence must never block delivery, so a
  // failed insert is swallowed and logged. Only announce message.created
  // when the row actually landed, otherwise the UI would refetch and find
  // nothing.
  const recipientRepoRoot = await resolveRepoRoot(target.cwd).catch(() => null);
  const messageStore = new MessageStore(deps.pool);
  const persisted = await messageStore
    .insertMessage({
      senderAgentId: agentId,
      recipientAgentId: target.id,
      senderName: sender.name,
      recipientName: target.name,
      content: input.message,
      delivered: enqueued ? null : false,
      senderRepoRoot,
      recipientRepoRoot,
    })
    .catch((err) => {
      deps.appLog.error(
        { err, senderId: agentId, targetId: target.id },
        "dispatch_send_message: failed to persist message"
      );
      return null;
    });

  const announce = () =>
    deps.publishUiEvent({
      type: "message.created",
      senderAgentId: agentId,
      recipientAgentId: target.id,
    });
  if (persisted) announce();

  if (persisted && outcome) {
    // Settle the row once the pane write completes and announce the pair
    // again so both sides' panels refetch the final state.
    void outcome
      .then(async (delivered) => {
        await messageStore.setDelivered(persisted.id, delivered);
        announce();
      })
      .catch((err: unknown) => {
        deps.appLog.error(
          { err, senderId: agentId, targetId: target.id },
          "dispatch_send_message: failed to record delivery outcome"
        );
      });
  }

  if (!enqueued) {
    throw deliveryError instanceof Error
      ? deliveryError
      : new Error(`Failed to deliver message to "${target.name}".`);
  }

  deps.appLog.info(
    { senderId: agentId, targetId: target.id, held: enqueued.held },
    "dispatch_send_message: queued for delivery"
  );
  return {
    delivered: true,
    targetAgentId: target.id,
    targetAgentName: target.name,
  };
}

async function handleListAgentsForAgent(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  senderRepoRoot: string | null
): Promise<
  Array<{
    id: string;
    name: string;
    status: string;
    latestEvent: { type: string; message: string } | null;
    parentAgentId: string | null;
    parentName: string | null;
    launchedByAgentId?: string;
    launchedByName?: string;
    relation: AgentRelation;
  }>
> {
  const crossRepo = await isCrossRepoMessagingEnabled(deps.pool);

  const allAgents = await deps.agentManager.listAgents();
  const agents = await addressableAgents(
    allAgents,
    agentId,
    senderRepoRoot,
    crossRepo
  );
  // Two different scopes, deliberately.
  //
  // `relation` is computed against every agent, because a grandchild must not
  // flatten into a child just because the intermediate sits in another repo —
  // and a relation names nobody.
  //
  // `parentAgentId`/`parentName` identify a specific agent, so they are
  // resolved against the addressable set only. Naming the out-of-repo parent of
  // a visible agent would hand the caller an identity it is not allowed to
  // address; an unaddressable parent is reported as null instead.
  const lineage = createLineageIndex(allAgents);
  // Self is excluded from the addressable set but is obviously not a secret
  // from itself, so the caller's own children still name their parent.
  const visibleNamesById = new Map(agents.map((a) => [a.id, a.name]));
  const self = lineage.get(agentId);
  if (self) visibleNamesById.set(self.id, self.name);

  const result: Array<{
    id: string;
    name: string;
    status: string;
    latestEvent: { type: string; message: string } | null;
    parentAgentId: string | null;
    parentName: string | null;
    launchedByAgentId?: string;
    launchedByName?: string;
    relation: AgentRelation;
  }> = [];
  for (const a of agents) {
    const rawParentId = a.parentAgentId ?? null;
    const parentName = rawParentId
      ? (visibleNamesById.get(rawParentId) ?? null)
      : null;
    const visibleParentId = parentName === null ? null : rawParentId;
    // Only reported when it says something parentAgentId does not: for a child
    // the launcher *is* the parent, and repeating it is noise in every row.
    const rawLauncherId = a.launchedByAgentId ?? null;
    const launcherName =
      rawLauncherId && rawLauncherId !== rawParentId
        ? (visibleNamesById.get(rawLauncherId) ?? null)
        : null;
    result.push({
      id: a.id,
      name: a.name,
      status: a.status,
      latestEvent: a.latestEvent
        ? { type: a.latestEvent.type, message: a.latestEvent.message }
        : null,
      parentAgentId: visibleParentId,
      parentName,
      ...(launcherName && rawLauncherId
        ? { launchedByAgentId: rawLauncherId, launchedByName: launcherName }
        : {}),
      relation: relationTo(lineage, agentId, a.id),
    });
  }
  return result;
}

async function handleListMedia(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  opts: { source?: string; ownerAgentId?: string }
): Promise<ListedMediaItem[]> {
  const owner = await resolveReadableOwner(deps, agentId, opts.ownerAgentId);

  // Files stay in the owner's directory; a family read hands back the owner's
  // path and nothing is copied. Agents read media by path, never over HTTP.
  const mediaDir = resolveMediaDir(owner.id, owner.mediaDir, deps.mediaRoot);
  const whereClause = opts.source
    ? `WHERE agent_id = $1 AND source = $2`
    : `WHERE agent_id = $1`;
  const params: (string | number)[] = opts.source
    ? [owner.id, opts.source]
    : [owner.id];

  const result = await deps.pool.query<{
    file_name: string;
    source: string;
    description: string | null;
    size_bytes: number;
    created_at: Date;
  }>(
    `SELECT file_name, source, description, size_bytes, created_at
     FROM media ${whereClause}
     ORDER BY created_at DESC LIMIT 100`,
    params
  );

  return result.rows.map((row) => ({
    ownerAgentId: owner.id,
    fileName: row.file_name,
    filePath: path.join(mediaDir, row.file_name),
    source: row.source,
    description: row.description ?? null,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at.toISOString(),
  }));
}

async function handleDeleteMedia(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  fileName: string
): Promise<void> {
  const agent = await deps.agentManager.getAgent(agentId);
  if (!agent) throw new Error("Agent not found.");

  const result = await deps.pool.query<{ file_name: string }>(
    "SELECT file_name FROM media WHERE agent_id = $1 AND file_name = $2",
    [agentId, fileName]
  );
  if (result.rows.length === 0) {
    throw new Error(
      "No media file found with the given fileName for this agent."
    );
  }

  const storedFileName = result.rows[0].file_name;
  const mediaDir = resolveMediaDir(agentId, agent.mediaDir, deps.mediaRoot);
  const filePath = path.join(mediaDir, storedFileName);
  const resolvedMediaDir = path.resolve(mediaDir);
  if (!path.resolve(filePath).startsWith(resolvedMediaDir + path.sep)) {
    throw new Error("Invalid media file path.");
  }

  try {
    await unlink(filePath);
  } catch (error: unknown) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
  }

  await deps.pool.query(
    "DELETE FROM media WHERE agent_id = $1 AND file_name = $2",
    [agentId, storedFileName]
  );
  deps.publishUiEvent({ type: "media.changed", agentId });
}

// ---------------------------------------------------------------------------
// Thin delegation layer
// ---------------------------------------------------------------------------

export function createMcpHandlers(deps: CreateMcpHandlersDeps) {
  const reviewHandlers = createReviewHandlers({
    pool: deps.pool,
    agentManager: deps.agentManager,
    publishUiEvent: deps.publishUiEvent,
    withStreamFlag: deps.withStreamFlag,
    sendAgentPrompt: deps.sendAgentPrompt,
    appLog: deps.appLog,
  });

  const whiteboardHandlers = createWhiteboardHandlers({
    pool: deps.pool,
    mediaRoot: deps.mediaRoot,
    agentManager: deps.agentManager,
    publishUiEvent: deps.publishUiEvent,
  });

  return {
    ...reviewHandlers,
    ...whiteboardHandlers,

    listPersonalities: async () => {
      const [personalities, activeId] = await Promise.all([
        listPersonalities(deps.pool),
        getActivePersonalityId(deps.pool),
      ]);
      return { personalities, activeId };
    },

    createPersonality: async (input: { name: string; prompt: string }) => {
      try {
        return await createPersonality(deps.pool, input);
      } catch (error) {
        return normalizePersonalityDuplicateName(error);
      }
    },

    updatePersonality: (
      id: string,
      input: { name?: string; prompt?: string }
    ) =>
      updatePersonality(deps.pool, id, input)
        .catch(normalizePersonalityDuplicateName)
        .then((personality) => {
          if (!personality) throw new Error("Personality not found.");
          return personality;
        }),

    deletePersonality: (id: string) =>
      deletePersonality(deps.pool, id).then((deleted) => {
        if (!deleted) throw new Error("Personality not found.");
      }),

    setActivePersonality: async (id: string) => {
      if (!(await activatePersonality(deps.pool, id))) {
        throw new Error("Personality not found.");
      }
    },

    clearActivePersonality: () => setActivePersonalityId(deps.pool, null),

    upsertEvent: (
      agentId: string,
      event: {
        type: string;
        message: string;
        metadata?: Record<string, unknown>;
      }
    ) => handleUpsertEvent(deps, agentId, event),

    sendNotify: (agentId: string, input: NotifyInput) =>
      handleSendNotify(deps, agentId, input),

    upsertPin: (agentId: string, pin: PinInput) =>
      handleUpsertPin(deps, agentId, pin),

    upsertPins: (
      agentId: string,
      input: { pins: PinInput[]; mode?: "merge" | "replace"; group?: string }
    ) => handleUpsertPins(deps, agentId, input),

    deletePin: (
      agentId: string,
      input: { id?: string; ids?: string[]; group?: string }
    ) => handleDeletePin(deps, agentId, input),

    deletePinByLabel: (agentId: string, label: string) =>
      handleDeletePinByLabel(deps, agentId, label),

    listPins: (agentId: string, opts?: { ownerAgentId?: string }) =>
      handleListPins(deps, agentId, opts),

    renameSession: (agentId: string, name: string) =>
      handleRenameSession(deps, agentId, name),

    jobComplete: (agentId: string, report: unknown) =>
      handleJobComplete(deps, agentId, report),

    jobFailed: (agentId: string, report: unknown) =>
      handleJobFailed(deps, agentId, report),

    jobNeedsInput: (agentId: string, question: string) =>
      handleJobNeedsInput(deps, agentId, question),

    jobLog: (
      agentId: string,
      input: {
        task: string;
        message: string;
        level: "debug" | "info" | "warn" | "error";
      }
    ) => handleJobLog(deps, agentId, input),

    launchAgent: (
      agentId: string,
      input: {
        name: string;
        prompt: string;
        type?: string;
        model?: string;
        useWorktree?: boolean;
        createNewBranch?: boolean;
        baseBranch?: string;
        worktreeBranch?: string;
        fullAccess?: boolean;
        templateId?: string;
        templateArgs?: Record<string, string>;
        cwd?: string;
        child?: boolean;
      }
    ) => handleLaunchAgent(deps, agentId, input),

    archiveAgent: (
      agentId: string,
      input: {
        agentId: string;
        cleanupWorktree?: WorktreeCleanupMode;
        whenResponseFinished?: () => Promise<void>;
      }
    ) => handleArchiveAgent(deps, agentId, input),

    shareMedia: (
      agentId: string,
      opts: {
        filePath: string;
        description: string;
        source?: string;
        name?: string;
        update?: string;
      }
    ) => handleShareMedia(deps, agentId, opts),

    sendMessage: (
      agentId: string,
      input: { target: string; message: string; senderRepoRoot: string | null }
    ) => handleSendMessage(deps, agentId, input),

    listAgentsForAgent: (agentId: string, senderRepoRoot: string | null) =>
      handleListAgentsForAgent(deps, agentId, senderRepoRoot),

    listMedia: (
      agentId: string,
      opts: { source?: string; ownerAgentId?: string }
    ) => handleListMedia(deps, agentId, opts),

    deleteMedia: (agentId: string, fileName: string) =>
      handleDeleteMedia(deps, agentId, fileName),
  };
}
