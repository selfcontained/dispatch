/*
 * The `session.attach` channel: what a caller sends a session host and what
 * the host answers, typed from the host protocol (`session.ts`) and its
 * extensions. Engine (ACP) payloads are `json`; prompt `source` is caller
 * metadata, also `json`.
 */
import { journalEntryFields, permissionRequest } from "./events.js";
import { runnerPath } from "./opaque.js";
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

const id = { id: string };

export const clientMessage = union(
  /** The last contiguous position the caller holds of the named journal. */
  object({
    type: literal("hello"),
    fromSeq: integer,
    journalId: optional(nullable(string)),
    /** Asks for `replay_complete` after the replay; older hosts ignore it. */
    replayComplete: optional(boolean),
  }),
  object({
    type: literal("prompt"),
    ...id,
    text: string,
    journalId: optional(string),
    source: optional(json),
    images: optional(array(object({ path: runnerPath, mimeType: string }))),
  }),
  object({
    type: literal("steer"),
    ...id,
    text: string,
    source: optional(json),
  }),
  object({ type: literal("cancel") }),
  object({ type: literal("interrupt"), ...id, turnSeq: integer }),
  object({
    type: literal("answer_permission"),
    ...id,
    requestId: string,
    optionId: nullable(string),
  }),
  /** Set one of the session's ACP config options. */
  object({
    type: literal("set_config"),
    ...id,
    configId: string,
    value: string,
  }),
  /** `idleOnly`: ignored while a turn is open. */
  object({
    type: literal("shutdown"),
    force: optional(boolean),
    idleOnly: optional(boolean),
  }),
  /** Shut down under a held quiesce lease; never with `force`. */
  object({ type: literal("shutdown"), quiesceId: string }),
  object({ type: literal("mcp_inventory"), ...id, sessionId: string }),
  object({ type: literal("background_work"), ...id, sessionId: string }),
  object({ type: literal("ping") }),
  object({ type: literal("prompt_receipt"), ...id, journalId: string }),
  object({ type: literal("quiesce", "release_quiesce"), ...id })
);

const mcpInventory = object({
  status: literal("ok", "offline", "unsupported", "timeout", "unavailable"),
  inventory: nullable(
    object({
      version: literal(1),
      servers: array(
        object({
          name: string,
          state: string,
          toolsState: literal("known", "unknown", "error"),
          tools: nullable(
            array(object({ name: string, description: optional(string) }))
          ),
        })
      ),
    })
  ),
});

const backgroundWork = object({
  status: literal("supported", "unsupported", "offline", "unavailable"),
  items: array(
    object({
      id: string,
      name: string,
      kind: literal("shell", "monitor"),
      state: literal("running", "paused"),
    })
  ),
});

export const hostWelcome = object({
  type: literal("welcome"),
  engine: string,
  sessionId: string,
  resumed: boolean,
  running: boolean,
  journalSeq: integer,
  journalId: optional(string),
  steeringSupported: optional(boolean),
  interruptSupported: optional(boolean),
  mcpInventorySupported: optional(boolean),
  backgroundWorkSupported: optional(boolean),
  promptReceiptSupported: optional(literal(true)),
  quiesceSupported: optional(literal(true)),
  /** The host answers `hello {replayComplete}` with `replay_complete`. */
  replayCompleteSupported: optional(literal(true)),
  hostInstanceId: optional(string),
  hostBuild: optional(object({ version: string, revision: nullable(string) })),
  /** The open turn, if one is running. */
  turn: optional(
    nullable(
      object({ seq: integer, startedAt: string, source: optional(json) })
    )
  ),
  /** The session's ACP commands; refreshed on each attach. */
  commands: optional(array(json)),
  /** The session's ACP config options as they stand. */
  configOptions: optional(array(json)),
  permissions: optional(array(permissionRequest)),
});

export const hostMessage = union(
  hostWelcome,
  object({ type: literal("event"), ...journalEntryFields }),
  /** Sent after the replay when `hello` asked for it. */
  object({ type: literal("replay_complete") }),
  object({ type: literal("prompt_accepted"), ...id }),
  /** An engine-initiated turn is open and the host did not submit this prompt. */
  object({ type: literal("prompt_deferred"), ...id }),
  object({ type: literal("interrupt_result"), ...id }),
  object({
    type: literal("steer_result"),
    ...id,
    outcome: literal("injected", "promptRequired"),
  }),
  object({ type: literal("error"), id: optional(string), message: string }),
  object({ type: literal("permission_answered"), ...id }),
  object({ type: literal("pong") }),
  object({
    type: literal("prompt_receipt_result"),
    ...id,
    journalId: string,
    state: literal("accepted", "claimed", "unclaimed", "rotated"),
  }),
  object({
    type: literal("quiesce_result"),
    ...id,
    state: literal("idle", "busy"),
  }),
  object({
    type: literal("quiesce_shutdown_result"),
    ...id,
    accepted: boolean,
  }),
  /** A set_config took; the engine's ACP options after it. */
  object({ type: literal("config_set"), ...id, options: array(json) }),
  /** Live snapshot; never journaled. */
  object({ type: literal("permissions"), requests: array(permissionRequest) }),
  object({
    type: literal("mcp_inventory_result"),
    ...id,
    result: mcpInventory,
  }),
  object({
    type: literal("background_work_result"),
    ...id,
    result: backgroundWork,
  })
);
