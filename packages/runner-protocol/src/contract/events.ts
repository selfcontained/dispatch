/*
 * What a session host reports and journals, typed from the host's
 * `DriverEvent` and `JournalEntry`. The channel is the session, so no event
 * names its session. Engine (ACP) payloads pass through as `json`; prompt
 * `source` is caller metadata, also `json`.
 */
import {
  array,
  boolean,
  integer,
  json,
  literal,
  nullable,
  object,
  optional,
  string,
  union,
} from "./schema.js";

/** A live engine request for permission, held by the host until answered or cancelled. */
export const permissionRequest = object({
  id: string,
  toolCallId: string,
  title: string,
  /** Plain-text preview of the requested operation. */
  details: string,
  createdAt: string,
  options: array(
    object({
      optionId: string,
      name: string,
      kind: literal(
        "allow_once",
        "allow_always",
        "reject_once",
        "reject_always"
      ),
    })
  ),
});

const receipt = { receiptId: string, source: optional(json), at: string };

export const hostEvent = union(
  /** Input accepted into the open turn, journaled before its settlement. */
  object({
    type: literal("steered"),
    text: string,
    source: optional(json),
    receiptId: optional(string),
    at: optional(string),
  }),
  object({ type: literal("prompt_delivered"), ...receipt }),
  object({ type: literal("steering_picked_up"), ...receipt }),
  /** Live snapshot sent with seq 0; never journaled or replayed. */
  object({ type: literal("permissions"), requests: array(permissionRequest) }),
  /** One ACP session update, as the engine sent it. */
  object({ type: literal("update"), update: json }),
  /** The engine's ACP config options, whole. */
  object({
    type: literal("config"),
    options: array(json),
    /** Absent from older hosts. */
    catalogSource: optional(literal("engine", "override")),
  }),
  object({
    type: literal("turn"),
    state: literal("started"),
    text: string,
    source: optional(json),
    model: optional(string),
    sessionId: optional(string),
  }),
  object({
    type: literal("turn"),
    state: literal("settled"),
    /** ACP stop reason. */
    stopReason: optional(string),
    /** Cumulative ACP session usage. */
    usage: optional(json),
    error: optional(string),
    errorKind: optional(string),
  }),
  object({
    type: literal("exit"),
    code: nullable(integer),
    signal: nullable(string),
    stderrTail: string,
    /** True when the host was asked to stop; false for a crash. */
    expected: boolean,
  })
);

/** One journal line: an event and its position in the host's stream. */
export const journalEntryFields = {
  seq: integer,
  at: string,
  event: hostEvent,
  /** Absent on entries written by older hosts. */
  journalId: optional(string),
};
export const journalEntry = object(journalEntryFields);
