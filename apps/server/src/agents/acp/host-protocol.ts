import {
  parseSessionCommand,
  type HostWelcome,
  type JournalEntry as RunnerJournalEntry,
  type RemoteLaunch,
  type SessionCommand,
  type SessionReply,
} from "@dispatch/runner-protocol";
import type { BackgroundSnapshot } from "@dispatch/shared";
import type { AgentMcpInventoryResponse } from "@dispatch/shared";
import type { AgentPermissionRequest } from "@dispatch/shared";
import { isPromptSource, type PromptSource } from "./prompt-source.js";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { BuildIdentity } from "../build-identity.js";
import type { DriverEvent } from "./driver.js";
import type {
  AvailableCommand,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type { EngineBins } from "./engine-spec.js";

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

/**
 * Every file the host, or whoever launches it, writes into an agent's state
 * directory. A runner unlinks each of them before a launch, so name a new
 * file here and write it through `hostFile`.
 */
export const HOST_FILES = {
  launch: "launch.json",
  socket: "host.sock",
  pid: "host.pid",
  journal: "journal.jsonl",
  journalId: "journal.id",
  session: "session.json",
  log: "host.log",
  receipts: "prompt-receipts.jsonl",
  turnActive: "turn-active",
  serviceMcpCa: "service-mcp-ca.pem",
  nodeCa: "node-ca.pem",
  codexCa: "codex-ca.pem",
  curlCa: "curl-ca.pem",
  instructions: "dispatch-instructions.md",
  personaContext: "persona-context.md",
} as const;

export function hostFile(
  stateDir: string,
  name: keyof typeof HOST_FILES
): string {
  return path.join(stateDir, HOST_FILES[name]);
}

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
  | SessionCommand<PromptSource>
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
  const message = parseSessionCommand(value);
  if (message?.type !== "prompt" && message?.type !== "steer") return message;
  // Keep validating the legacy Dispatch source shape. Other services can
  // omit it or use their own metadata with a host that understands it.
  const { source, ...command } = message;
  if (source === undefined) return command;
  return isPromptSource(source) ? { ...command, source } : null;
}

type DispatchWelcome = HostWelcome & {
  hostBuild?: BuildIdentity;
  promptReceiptSupported?: true;
  quiesceSupported?: true;
  /** Answers `hello {replayComplete}` with `replay_complete`. Hosts from
   * origin/main and v1.7.28 lack it. */
  replayCompleteSupported?: true;
  hostInstanceId?: string;
  /** The open turn, if one is running. */
  turn: { seq: number; startedAt: string; source?: PromptSource } | null;
  /** Current ACP commands, including skills; refreshed on each reconnect. */
  commands: AvailableCommand[];
  /** The session's config options as they stand; absent from older hosts. */
  configOptions?: SessionConfigOption[];
  permissions?: AgentPermissionRequest[];
};

export type HostMessage =
  | SessionReply<DriverEvent, DispatchWelcome>
  | {
      type: "prompt_receipt_result";
      id: string;
      journalId: string;
      state: PromptReceiptState;
    }
  | { type: "quiesce_result"; id: string; state: "idle" | "busy" }
  | { type: "quiesce_shutdown_result"; id: string; accepted: boolean }
  /** A set_config took; the engine's options after it. */
  | { type: "config_set"; id: string; options: SessionConfigOption[] }
  | { type: "permissions"; requests: AgentPermissionRequest[] }
  | {
      type: "mcp_inventory_result";
      id: string;
      result: AgentMcpInventoryResponse;
    }
  | { type: "background_work_result"; id: string; result: BackgroundSnapshot };

/**
 * Split a byte stream into newline-delimited JSON messages. Returns a
 * function that takes each chunk and yields the complete messages in it;
 * a partial trailing line waits for the next chunk.
 */
export function ndjsonDecoder<T>(
  onMalformed?: () => void
): (chunk: Buffer | string) => T[] {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const out: T[] = [];
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // Keep parsing subsequent lines after a malformed message.
        onMalformed?.();
      }
    }
    return out;
  };
}

export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
