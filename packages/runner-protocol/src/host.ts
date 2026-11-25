/*
 * The host's own names for what it reports, taken from the session
 * contract rather than from any one caller's model. A caller with its own
 * types (Dispatch's `@dispatch/shared`) receives the same shapes.
 */
import type { PromptImage as WirePromptImage } from "./session.js";
import type {
  Infer,
  hostMessage,
  permissionRequest,
} from "./contract/index.js";

type ResultOf<T extends ContractHostMessage["type"]> = Extract<
  ContractHostMessage,
  { type: T; result: unknown }
>["result"];
type ContractHostMessage = Infer<typeof hostMessage>;

/** A live engine request for permission, held by the host until answered. */
export type PermissionRequest = Infer<typeof permissionRequest>;

/** A live snapshot of the engine's background work. */
export type BackgroundSnapshot = ResultOf<"background_work_result">;
export type BackgroundItem = BackgroundSnapshot["items"][number];

/** A v1 host names its agent in every inventory result. */
export type McpInventoryResult = ResultOf<"mcp_inventory_result"> & {
  agentId: string;
};
export type McpInventory = NonNullable<McpInventoryResult["inventory"]>;

/** An engine effort level, as the engine names it. */
export type Effort = string;

/** The `errorKind` a turn carries when the engine's sign-in has lapsed. */
export const AUTHENTICATION_REQUIRED = "authentication_required";

/**
 * A caller's metadata for a prompt: the host keeps it with the turn and
 * hands it back on the turn's events, and never reads it. A caller that
 * wants it typed augments this interface with `{ source: T }`.
 */
export interface CallerSourceRegistry {}
export type CallerSource = CallerSourceRegistry extends { source: infer S }
  ? S
  : unknown;

/** A prompt attachment. A runner name marks an input to stage before ACP submission. */
export type PromptImage = WirePromptImage & { runnerName?: string };

import type * as acp from "@agentclientprotocol/sdk";
export type DriverUpdate = acp.SessionUpdate;
export type DriverUsage = acp.Usage;

export type DriverEvent =
  /** Input accepted into the existing turn, journaled before its settlement. */
  | {
      type: "steered";
      agentId: string;
      text: string;
      source?: CallerSource;
      receiptId?: string;
      at?: string;
    }
  | {
      type: "prompt_delivered";
      agentId: string;
      receiptId: string;
      source?: CallerSource;
      at: string;
    }
  | {
      type: "steering_picked_up";
      agentId: string;
      receiptId: string;
      source?: CallerSource;
      at: string;
    }
  /** Live host snapshot, emitted by the runtime with seq 0; never replayed from the journal. */
  | { type: "permissions"; agentId: string; requests: PermissionRequest[] }
  | { type: "update"; agentId: string; update: DriverUpdate }
  /**
   * The engine's session config options, whole: once the session opens and
   * again whenever the engine changes them. The model option is where the
   * server learns which model is really running and which it could run.
   */
  | {
      type: "config";
      agentId: string;
      options: acp.SessionConfigOption[];
      /** Set by the host before journaling. Older hosts have unknown provenance. */
      catalogSource?: "engine" | "override";
    }
  | {
      type: "turn";
      agentId: string;
      state: "started";
      text: string;
      /**
       * What this prompt is, as the sender knew it. Dispatch puts the
       * block id in the envelope for the agent to quote back; this is the
       * same id for Dispatch's own use, so nothing has to read the
       * envelope back off the wire to find out what opened the turn.
       */
      source?: CallerSource;
      /** The model the engine runs this turn on, when it publishes one. */
      model?: string;
      /** The ACP session the turn runs in: its usage belongs to that session. */
      sessionId?: string;
    }
  | {
      type: "turn";
      agentId: string;
      state: "settled";
      stopReason?: acp.StopReason;
      /** Cumulative session usage reported with the prompt response. */
      usage?: DriverUsage;
      error?: string;
      /**
       * The adapter's category for a failed turn (`server_error`,
       * `overloaded`, `transport_lost`…), when it gave one.
       */
      errorKind?: string;
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

/** The engines the ACP runtime can drive. `agents.type` names one of these. */
export const ACP_ENGINE_IDS = ["claude", "codex", "opencode"] as const;
export type AcpEngineId = (typeof ACP_ENGINE_IDS)[number];

export function isAcpEngine(type: string): type is AcpEngineId {
  return (ACP_ENGINE_IDS as readonly string[]).includes(type);
}

export type EngineBins = {
  /** Absolute path to the host's `claude`, for `CLAUDE_CODE_EXECUTABLE`. */
  claudeBin: string;
  /** Absolute path to the host's `codex`, for `CODEX_PATH`. */
  codexBin: string | null;
  /** OpenCode provides its own native ACP command. */
  opencodeBin?: string | null;
  /**
   * Runs the adapter instead of this binary's own mode. Only the tests set
   * it, to stand a fake engine in place of a real one.
   */
  adapter?: { bin: string; args?: string[] };
};

import {
  parseSessionCommand,
  type HostWelcome,
  type JournalEntry as RunnerJournalEntry,
  type SessionCommand,
  type SessionReply,
} from "./session.js";
import type { RemoteLaunch } from "./execution.js";
/**
 * What the server writes into an agent's state directory before spawning
 * its host. Everything the host needs to run the engine is here, so the
 * host takes no arguments beyond the directory. Mode 0600: it carries the
 * MCP token and the system prompt.
 */
export type HostLaunch = RemoteLaunch & {
  cwd: string;
  /** A supervised runner samples the lifetime of active turns. */
  reportTurnActivity?: boolean;
  hostInstanceId?: string;
  bins: EngineBins;
  /** Environment the engine child gets on top of the host's own. */
  env: Record<string, string>;
  /** Directories prepended to the engine child's PATH. */
  pathPrefix: string[];
};

/** One journal line: an event with its position in the host's stream. */
export type JournalEntry = RunnerJournalEntry<DriverEvent>;

export type PromptReceiptState =
  | "accepted"
  | "claimed"
  | "unclaimed"
  | "rotated";

type PromptReceiptQuery = {
  type: "prompt_receipt";
  id: string;
  journalId: string;
};
export type ClientMessage =
  | SessionCommand<CallerSource>
  | PromptReceiptQuery
  | { type: "quiesce" | "release_quiesce"; id: string }
  | { type: "shutdown"; quiesceId: string };

function validRequestId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 128;
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "prompt_receipt"
  ) {
    if (
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("journalId" in value) ||
      typeof value.journalId !== "string" ||
      value.id.length === 0 ||
      value.id.length > 128 ||
      value.journalId.length === 0 ||
      value.journalId.length > 128
    )
      return null;
    return { type: "prompt_receipt", id: value.id, journalId: value.journalId };
  }
  if (value && typeof value === "object" && "type" in value) {
    if (value.type === "quiesce" || value.type === "release_quiesce") {
      return "id" in value && validRequestId(value.id)
        ? { type: value.type, id: value.id }
        : null;
    }
    if (value.type === "shutdown" && "quiesceId" in value) {
      return validRequestId(value.quiesceId) && !("force" in value)
        ? { type: "shutdown", quiesceId: value.quiesceId }
        : null;
    }
  }
  // A prompt's `source` is the caller's metadata: carried, never read.
  // The caller validates what comes back on the turn's events.
  return parseSessionCommand(value) as ClientMessage | null;
}

/** The build a host was started from. */
type HostBuild = { version: string; revision: string | null };

type Welcome = HostWelcome & {
  hostBuild?: HostBuild;
  promptReceiptSupported?: true;
  quiesceSupported?: true;
  /** Answers `hello {replayComplete}` with `replay_complete`. Hosts from
   * origin/main and v1.7.28 lack it. */
  replayCompleteSupported?: true;
  hostInstanceId?: string;
  /** The open turn, if one is running. */
  turn: { seq: number; startedAt: string; source?: CallerSource } | null;
  /** Current ACP commands, including skills; refreshed on each reconnect. */
  commands: acp.AvailableCommand[];
  /** The session's config options as they stand; absent from older hosts. */
  configOptions?: acp.SessionConfigOption[];
  permissions?: PermissionRequest[];
};

export type HostMessage =
  | SessionReply<DriverEvent, Welcome>
  | {
      type: "prompt_receipt_result";
      id: string;
      journalId: string;
      state: PromptReceiptState;
    }
  | { type: "quiesce_result"; id: string; state: "idle" | "busy" }
  | { type: "quiesce_shutdown_result"; id: string; accepted: boolean }
  /** A set_config took; the engine's options after it. */
  | { type: "config_set"; id: string; options: acp.SessionConfigOption[] }
  | { type: "permissions"; requests: PermissionRequest[] }
  | {
      type: "mcp_inventory_result";
      id: string;
      result: McpInventoryResult;
    }
  | { type: "background_work_result"; id: string; result: BackgroundSnapshot };

export type DriverLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
};
