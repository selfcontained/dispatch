import type { RunnerEngine } from "./execution.js";
import { isNullableString, isRecord, isSequence } from "./validation.js";

/** The last contiguous position durably received in the named host journal. */
export type ReplayHello = {
  type: "hello";
  fromSeq: number;
  journalId?: string | null;
  replayComplete?: boolean;
};

export type HostWelcome = {
  type: "welcome";
  agentId: string;
  engine: RunnerEngine;
  sessionId: string;
  resumed: boolean;
  running: boolean;
  journalSeq: number;
  journalId?: string;
  steeringSupported?: boolean;
  interruptSupported?: boolean;
  mcpInventorySupported?: boolean;
  backgroundWorkSupported?: boolean;
};

export type JournalEntry<Event> = {
  seq: number;
  at: string;
  event: Event;
  /** Absent on entries written by older hosts. */
  journalId?: string;
};

export type HostEvent<Event = unknown> = {
  type: "event";
} & JournalEntry<Event>;
export type ReplayComplete = { type: "replay_complete" };

export type HostPrompt<Source = unknown, Image = unknown> = {
  type: "prompt";
  id: string;
  text: string;
  journalId?: string;
  /** Opaque application metadata. The wire decoder preserves it as supplied. */
  source?: Source;
  images?: Image[];
};

export type PromptReceipt =
  | { type: "prompt_accepted"; id: string }
  /** An engine-initiated turn is open and the host did not submit this prompt. */
  | { type: "prompt_deferred"; id: string };

/** Path to a prompt attachment on the execution machine. */
export type PromptImage = { path: string; mimeType: string };

export type SessionCommand<Source = unknown> =
  | ReplayHello
  | HostPrompt<Source, PromptImage>
  | { type: "steer"; id: string; text: string; source?: Source }
  | { type: "cancel" }
  | { type: "interrupt"; id: string; turnSeq: number }
  | {
      type: "answer_permission";
      id: string;
      requestId: string;
      optionId: string | null;
    }
  /** Set one of the session's config options (model, effort, mode). */
  | { type: "set_config"; id: string; configId: string; value: string }
  /** `idleOnly`: ignored while a turn is open. */
  | { type: "shutdown"; force?: boolean; idleOnly?: boolean }
  | { type: "mcp_inventory"; id: string; sessionId: string }
  | { type: "background_work"; id: string; sessionId: string }
  | { type: "ping" };

/** Replies without application-specific payload schemas. */
export type SessionReply<
  Event = unknown,
  Welcome extends HostWelcome = HostWelcome,
> =
  | Welcome
  | HostEvent<Event>
  | ReplayComplete
  | PromptReceipt
  | { type: "interrupt_result"; id: string }
  | { type: "steer_result"; id: string; outcome: "injected" | "promptRequired" }
  | { type: "error"; id?: string; message: string }
  | { type: "permission_answered"; id: string }
  | { type: "pong" };

function isPromptImage(value: unknown): value is PromptImage {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.mimeType === "string"
  );
}

function isPromptInput(value: Record<string, unknown>): boolean {
  return typeof value.id === "string" && typeof value.text === "string";
}

export function sessionCommandId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === "string" ? value.id : undefined;
}

function isSessionCommand(value: unknown): value is SessionCommand {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "hello":
      return (
        isSequence(value.fromSeq) &&
        (value.journalId === undefined || isNullableString(value.journalId)) &&
        (value.replayComplete === undefined ||
          typeof value.replayComplete === "boolean")
      );
    case "prompt":
      return (
        isPromptInput(value) &&
        (value.journalId === undefined ||
          typeof value.journalId === "string") &&
        (value.images === undefined ||
          (Array.isArray(value.images) && value.images.every(isPromptImage)))
      );
    case "steer":
      return isPromptInput(value);
    case "interrupt":
      return typeof value.id === "string" && isSequence(value.turnSeq);
    case "answer_permission":
      return (
        typeof value.id === "string" &&
        typeof value.requestId === "string" &&
        isNullableString(value.optionId)
      );
    case "set_config":
      return (
        typeof value.id === "string" &&
        typeof value.configId === "string" &&
        typeof value.value === "string"
      );
    case "shutdown":
      return (
        (value.force === undefined || typeof value.force === "boolean") &&
        (value.idleOnly === undefined || typeof value.idleOnly === "boolean")
      );
    case "mcp_inventory":
    case "background_work":
      return (
        typeof value.id === "string" && typeof value.sessionId === "string"
      );
    case "cancel":
    case "ping":
      return true;
    default:
      return false;
  }
}

export function parseSessionCommand(value: unknown): SessionCommand | null {
  return isSessionCommand(value) ? value : null;
}
