import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AgentManager, AgentRecord } from "../agents/manager.js";
import type { PinSpec } from "../agents/pin-write.js";
import { AgentError } from "../agents/errors.js";
import type { WorktreeCleanupMode } from "../agents/types.js";
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
import { resolveRepoRoot } from "../shared/git/git-context.js";
import { isMediaFile, isTextFile, resolveMediaDir } from "../shared/media.js";
import type { PublishUiEvent, SendAgentPrompt } from "./mcp-handler-types.js";
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

function buildChildAgentInitialPrompt(
  parentAgentId: string,
  prompt: string
): string {
  return [
    `You were launched by Dispatch agent "${parentAgentId}" via dispatch_launch_agent.`,
    "Use that parent agent ID when coordinating back with dispatch_send_message.",
    "",
    prompt,
  ].join("\n");
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
  appLog: FastifyBaseLogger;
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
 * coordinate with their parent regardless of working directory. This is the
 * single definition of that visibility boundary — both message delivery and
 * agent listing consult it, so they can never disagree about who is reachable.
 */
async function addressableAgents<
  T extends { id: string; cwd: string; parentAgentId?: string | null },
>(
  all: T[],
  agentId: string,
  senderRepoRoot: string | null,
  crossRepo: boolean
): Promise<T[]> {
  const sender = all.find((a) => a.id === agentId);
  const senderParentId = sender?.parentAgentId ?? null;

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

async function handleListPins(
  deps: CreateMcpHandlersDeps,
  agentId: string
): Promise<PinListing[]> {
  const agent = await deps.agentManager.getAgent(agentId);
  if (!agent) throw new Error("Agent not found.");
  // Decorations are listed too, so an agent can see what a pin already has
  // (its group, caption, icon) before deciding what to change.
  return (agent.pins ?? []).map(toPinListing);
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
  }
): Promise<{ agentId: string; name: string; note?: string }> {
  const parent = await deps.agentManager.getAgent(agentId);
  if (!parent) throw new Error("Parent agent not found.");

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
    parentAgentId: agentId,
    cliSessionId,
    initialPrompt: buildChildAgentInitialPrompt(agentId, prompt),
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

async function handleArchiveAgent(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  input: { agentId: string; cleanupWorktree?: WorktreeCleanupMode }
): Promise<{ agentId: string; name: string; archived: true }> {
  const target = await deps.agentManager.getAgent(input.agentId);
  if (!target) throw new AgentError("Agent not found.", 404);
  if (target.parentAgentId !== agentId) {
    throw new AgentError(
      "You can only archive agents you launched via dispatch_launch_agent or dispatch_launch_persona.",
      403
    );
  }

  const targetName = target.name;
  const archiving = await deps.agentManager.beginArchive(
    target.id,
    input.cleanupWorktree ?? "auto"
  );
  deps.publishUiEvent({
    type: "agent.upsert",
    agent: deps.withStreamFlag(archiving),
  });

  let archiveError: unknown;
  await deps.agentManager.executeArchive(target.id, {
    onPhaseChange: (updated) => {
      deps.publishUiEvent({
        type: "agent.upsert",
        agent: deps.withStreamFlag(updated),
      });
    },
    onComplete: (deletedIds) => {
      for (const deletedId of deletedIds) {
        deps.publishUiEvent({ type: "agent.deleted", agentId: deletedId });
      }
    },
    onError: (error) => {
      archiveError = error;
    },
  });

  if (archiveError !== undefined) {
    throw archiveError instanceof Error
      ? archiveError
      : new Error(errorMessage(archiveError));
  }

  return { agentId: target.id, name: targetName, archived: true };
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

  const allAgents = await addressableAgents(
    await deps.agentManager.listAgents(),
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

  const envelope = JSON.stringify({
    from: sender.name,
    senderId: agentId,
    message: input.message,
    replyTarget: agentId,
  });
  const prompt = `--- DISPATCH MESSAGE ---\n${envelope}\n--- END MESSAGE ---\nOptional reply channel: If a response is necessary, use dispatch_send_message with the replyTarget above. Do not acknowledge routine status updates or completion messages unless a reply is explicitly requested.`;

  // Deliver first: a persistence failure must never block delivery.
  let delivered = false;
  let deliveryError: unknown = null;
  try {
    await deps.sendAgentPrompt(target.id, prompt, {
      swallowFailure: false,
      // Enqueue-and-return: awaiting gated delivery can exceed MCP client
      // timeouts (~60s), and a timed-out sender retrying would inject the
      // message twice. Session validation still happens before this resolves.
      awaitDelivery: false,
    });
    delivered = true;
  } catch (err) {
    deliveryError = err;
    deps.appLog.error(
      { err, senderId: agentId, targetId: target.id },
      "dispatch_send_message: tmux delivery failed"
    );
  }

  // Record the message (including failed deliveries) so it is viewable.
  // Persistence must never block delivery, so a failed insert is swallowed
  // and logged. Only announce message.created when the row actually landed,
  // otherwise the UI would refetch and find nothing.
  const recipientRepoRoot = await resolveRepoRoot(target.cwd).catch(() => null);
  const messageStore = new MessageStore(deps.pool);
  const persisted = await messageStore
    .insertMessage({
      senderAgentId: agentId,
      recipientAgentId: target.id,
      senderName: sender.name,
      recipientName: target.name,
      content: input.message,
      delivered,
      senderRepoRoot,
      recipientRepoRoot,
    })
    .then(() => true)
    .catch((err) => {
      deps.appLog.error(
        { err, senderId: agentId, targetId: target.id },
        "dispatch_send_message: failed to persist message"
      );
      return false;
    });

  if (persisted) {
    deps.publishUiEvent({
      type: "message.created",
      senderAgentId: agentId,
      recipientAgentId: target.id,
    });
  }

  if (!delivered) {
    throw deliveryError instanceof Error
      ? deliveryError
      : new Error(`Failed to deliver message to "${target.name}".`);
  }

  deps.appLog.info(
    { senderId: agentId, targetId: target.id },
    "dispatch_send_message: delivered"
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
  }>
> {
  const crossRepo = await isCrossRepoMessagingEnabled(deps.pool);

  const agents = await addressableAgents(
    await deps.agentManager.listAgents(),
    agentId,
    senderRepoRoot,
    crossRepo
  );
  const result: Array<{
    id: string;
    name: string;
    status: string;
    latestEvent: { type: string; message: string } | null;
  }> = [];
  for (const a of agents) {
    result.push({
      id: a.id,
      name: a.name,
      status: a.status,
      latestEvent: a.latestEvent
        ? { type: a.latestEvent.type, message: a.latestEvent.message }
        : null,
    });
  }
  return result;
}

async function handleListMedia(
  deps: CreateMcpHandlersDeps,
  agentId: string,
  opts: { source?: string }
): Promise<
  Array<{
    fileName: string;
    filePath: string;
    source: string;
    description: string | null;
    sizeBytes: number;
    createdAt: string;
  }>
> {
  const agent = await deps.agentManager.getAgent(agentId);
  if (!agent) throw new Error("Agent not found.");

  const mediaDir = resolveMediaDir(agentId, agent.mediaDir, deps.mediaRoot);
  const whereClause = opts.source
    ? `WHERE agent_id = $1 AND source = $2`
    : `WHERE agent_id = $1`;
  const params: (string | number)[] = opts.source
    ? [agentId, opts.source]
    : [agentId];

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

    listPins: (agentId: string) => handleListPins(deps, agentId),

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
      }
    ) => handleLaunchAgent(deps, agentId, input),

    archiveAgent: (
      agentId: string,
      input: { agentId: string; cleanupWorktree?: WorktreeCleanupMode }
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

    listMedia: (agentId: string, opts: { source?: string }) =>
      handleListMedia(deps, agentId, opts),

    deleteMedia: (agentId: string, fileName: string) =>
      handleDeleteMedia(deps, agentId, fileName),
  };
}
