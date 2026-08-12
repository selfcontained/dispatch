import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { BrainStore } from "../../brain/store.js";
import {
  BrainNotFoundError,
  BrainListNotFoundError,
  BrainListItemNotFoundError,
  BrainRevisionConflictError,
  BrainValidationError,
  BrainLimitExceededError,
  MAX_LIST_ITEMS_PER_PUSH,
  MAX_EVENT_IDS_PER_DELETE,
  ISO_INSTANT_HINT,
  isIsoInstant,
  toEventDeleteSelector,
} from "../../brain/store.js";
import { jsonText, LIST_STRING_MAX, truncateLongStrings } from "./response.js";
import { toToolError } from "./tool-error.js";

type BrainToolContext = {
  repoRoot: string;
  agentId: string;
  store: BrainStore;
  publishBrainChanged?: () => void;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
  structuredContent?: Record<string, unknown>;
};

function toStructuredContent(obj: object): Record<string, unknown> {
  return obj as Record<string, unknown>;
}

function toBrainError(error: unknown): ToolResult {
  if (error instanceof BrainRevisionConflictError) {
    return {
      content: [{ type: "text", text: error.message }],
      isError: true,
      structuredContent: toStructuredContent({
        error: {
          code: error.code,
          message: error.message,
          current: {
            collection: error.current.collection,
            name: error.current.name,
            revision: error.current.revision,
            ...("value" in error.current ? { value: error.current.value } : {}),
          },
        },
      }),
    };
  }
  if (
    error instanceof BrainNotFoundError ||
    error instanceof BrainListNotFoundError ||
    error instanceof BrainListItemNotFoundError ||
    error instanceof BrainValidationError ||
    error instanceof BrainLimitExceededError
  ) {
    return {
      content: [{ type: "text", text: error.message }],
      isError: true,
      structuredContent: toStructuredContent({
        error: { code: error.code, message: error.message },
      }),
    };
  }
  return toToolError(error);
}

const collectionSchema = z.string().min(1).max(255);
const nameSchema = z.string().min(1).max(255);
const kindSchema = z.string().min(1).max(255);
const subjectSchema = z.string().min(1).max(255);
const tagSchema = z.string().min(1).max(255);
const tagsSchema = z.array(tagSchema).max(50);
const jsonObjectSchema = z.record(z.string(), z.unknown());
// Bare strings like "now" or "epoch" are valid timestamptz literals to Postgres,
// so the destructive path only accepts explicit instants. The rule itself lives
// in the store — refine against it rather than restating it here, or the two
// definitions drift. `.refine` is the enforcement; `.meta` only advertises the
// shape to clients reading the published schema, since a refine is opaque to
// JSON Schema generation. Don't "tidy" this back into z.iso.datetime() — that
// would reintroduce a second, subtly different rule.
const eventTimestampSchema = z
  .string()
  .refine(isIsoInstant, { message: `Timestamp ${ISO_INSTANT_HINT}.` })
  .meta({ format: "date-time" });
const listOrderSchema = z.enum(["asc", "desc"]);

/**
 * A write confirms what changed, not what was written — the caller already has
 * the value it just sent, and echoing a multi-KB object back doubles the cost of
 * a one-field update. brain_get_object is there for callers that want to
 * re-read what landed.
 */
function toWriteAck(obj: {
  collection: string;
  name: string;
  revision: number;
  updatedAt: string;
}): { collection: string; name: string; revision: number; updatedAt: string } {
  return {
    collection: obj.collection,
    name: obj.name,
    revision: obj.revision,
    updatedAt: obj.updatedAt,
  };
}

export function registerBrainTools(
  server: McpServer,
  allowed: Set<string>,
  ctx: BrainToolContext
): void {
  const { repoRoot, agentId, store, publishBrainChanged } = ctx;

  // ── brain_get_object ──────────────────────────────────────────────
  if (allowed.has("brain_get_object")) {
    server.registerTool(
      "brain_get_object",
      {
        description:
          "Get a single object from the shared brain by collection and name. " +
          "Returns the object with its current value and revision, or an error if not found.",
        inputSchema: {
          collection: collectionSchema.describe(
            "The collection the object belongs to."
          ),
          name: nameSchema.describe(
            "The unique name of the object within the collection."
          ),
        },
      },
      async (args) => {
        try {
          const obj = await store.getObject(
            repoRoot,
            args.collection,
            args.name
          );
          if (!obj) {
            return toBrainError(
              new BrainNotFoundError(args.collection, args.name)
            );
          }
          return {
            content: [{ type: "text", text: jsonText(obj) }],
            structuredContent: toStructuredContent(obj),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_store_object ────────────────────────────────────────────
  if (allowed.has("brain_store_object")) {
    server.registerTool(
      "brain_store_object",
      {
        description:
          "Create or update an object in the shared brain. " +
          "To create: omit expectedRevision. " +
          "To update: pass expectedRevision matching the current revision (optimistic concurrency). " +
          "Blind overwrites of existing objects are rejected — you must read first. " +
          "Returns a confirmation of what changed (name, new revision, timestamp), not the stored value — " +
          "re-read with brain_get_object if you need it.",
        inputSchema: {
          collection: collectionSchema.describe(
            "The collection the object belongs to."
          ),
          name: nameSchema.describe(
            "The unique name of the object within the collection."
          ),
          value: z
            .record(z.string(), z.unknown())
            .describe("The JSON value to store."),
          expectedRevision: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "The revision you expect the object to be at. Required for updates. " +
                "Omit when creating a new object."
            ),
        },
      },
      async (args) => {
        try {
          const obj = await store.storeObject(repoRoot, agentId, {
            collection: args.collection,
            name: args.name,
            value: args.value,
            expectedRevision: args.expectedRevision,
          });
          publishBrainChanged?.();
          const ack = toWriteAck(obj);
          return {
            content: [{ type: "text", text: jsonText(ack) }],
            structuredContent: toStructuredContent(ack),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_list_push ──────────────────────────────────────────────
  if (allowed.has("brain_list_push")) {
    server.registerTool(
      "brain_list_push",
      {
        description:
          "Push one or more items to a shared brain list. " +
          "Optionally cap the list size with maxItems so the oldest items roll off automatically.",
        inputSchema: {
          collection: collectionSchema.describe(
            "The collection the list belongs to."
          ),
          name: nameSchema.describe(
            "The unique name of the list within the collection."
          ),
          items: z
            .array(jsonObjectSchema)
            .min(1)
            .max(MAX_LIST_ITEMS_PER_PUSH)
            .describe("One or more JSON objects to append."),
          maxItems: z
            .number()
            .int()
            .positive()
            .max(200)
            .optional()
            .describe(
              "If set, trim oldest items after the push so the list stays within this size."
            ),
          expectedRevision: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Optional optimistic concurrency check for coordinated multi-step updates."
            ),
        },
      },
      async (args) => {
        try {
          const result = await store.pushListItems(repoRoot, agentId, {
            collection: args.collection,
            name: args.name,
            items: args.items,
            maxItems: args.maxItems,
            expectedRevision: args.expectedRevision,
          });
          publishBrainChanged?.();
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: toStructuredContent(result),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_list_remove ────────────────────────────────────────────
  if (allowed.has("brain_list_remove")) {
    server.registerTool(
      "brain_list_remove",
      {
        description:
          "Remove a single item from a shared brain list by index or by matching a field value.",
        inputSchema: {
          collection: collectionSchema.describe(
            "The collection the list belongs to."
          ),
          name: nameSchema.describe(
            "The unique name of the list within the collection."
          ),
          index: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Remove the item at this 0-based position."),
          where: z
            .object({
              field: z.string().min(1).max(255),
              equals: z.string(),
            })
            .optional()
            .describe(
              "Remove the first item whose top-level field matches this string value."
            ),
          expectedRevision: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Optional optimistic concurrency check for coordinated multi-step updates."
            ),
        },
      },
      async (args) => {
        try {
          const result = await store.removeListItem(repoRoot, agentId, {
            collection: args.collection,
            name: args.name,
            index: args.index,
            where: args.where,
            expectedRevision: args.expectedRevision,
          });
          publishBrainChanged?.();
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: toStructuredContent(result),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_list_get ───────────────────────────────────────────────
  if (allowed.has("brain_list_get")) {
    server.registerTool(
      "brain_list_get",
      {
        description:
          "Read items from a shared brain list. Returns the selected items, total count, and current revision. " +
          `Strings longer than ${LIST_STRING_MAX} characters are truncated (marked with the number dropped) — ` +
          "call brain_get_list_item for one item in full.",
        inputSchema: {
          collection: collectionSchema.describe(
            "The collection the list belongs to."
          ),
          name: nameSchema.describe(
            "The unique name of the list within the collection."
          ),
          limit: z
            .number()
            .int()
            .positive()
            .max(200)
            .optional()
            .describe("Max items to return (default 50, max 200)."),
          offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Skip this many items from the start of the list."),
          order: listOrderSchema
            .optional()
            .describe("Return oldest-first ('asc') or newest-first ('desc')."),
        },
      },
      async (args) => {
        try {
          const raw = await store.getListItems(repoRoot, {
            collection: args.collection,
            name: args.name,
            limit: args.limit,
            offset: args.offset,
            order: args.order,
          });
          const result = truncateLongStrings(raw, LIST_STRING_MAX);
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: toStructuredContent(result),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_get_list_item ──────────────────────────────────────────
  if (allowed.has("brain_get_list_item")) {
    server.registerTool(
      "brain_get_list_item",
      {
        description:
          "Get one item from a shared brain list by index, with its value untruncated. " +
          "brain_list_get reports the indexes. An index is a position, not an id — removing an " +
          "item shifts the ones after it — so pass the revision brain_list_get returned as " +
          "expectedRevision to be told the list moved instead of reading a different item.",
        inputSchema: {
          collection: collectionSchema.describe(
            "The collection the list belongs to."
          ),
          name: nameSchema.describe(
            "The unique name of the list within the collection."
          ),
          index: z
            .number()
            .int()
            .min(0)
            .describe("The 0-based index reported by brain_list_get."),
          expectedRevision: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "The revision brain_list_get returned. Fails with a conflict if the list changed since."
            ),
        },
      },
      async (args) => {
        try {
          const item = await store.getListItem(repoRoot, {
            collection: args.collection,
            name: args.name,
            index: args.index,
            expectedRevision: args.expectedRevision,
          });
          if (!item) {
            return toToolError(
              new Error(
                `No item at index ${args.index} in "${args.collection}/${args.name}".`
              )
            );
          }
          return {
            content: [{ type: "text", text: jsonText(item) }],
            structuredContent: toStructuredContent(item),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_list_set ───────────────────────────────────────────────
  if (allowed.has("brain_list_set")) {
    server.registerTool(
      "brain_list_set",
      {
        description:
          "Replace a single item at a specific index in a shared brain list without rewriting the rest.",
        inputSchema: {
          collection: collectionSchema.describe(
            "The collection the list belongs to."
          ),
          name: nameSchema.describe(
            "The unique name of the list within the collection."
          ),
          index: z
            .number()
            .int()
            .min(0)
            .describe("The 0-based index to replace."),
          value: jsonObjectSchema.describe(
            "The JSON object to store at that index."
          ),
          expectedRevision: z
            .number()
            .int()
            .positive()
            .describe(
              "Required optimistic concurrency check. Pass the revision returned by brain_list_get."
            ),
        },
      },
      async (args) => {
        try {
          const result = await store.setListItem(repoRoot, agentId, {
            collection: args.collection,
            name: args.name,
            index: args.index,
            value: args.value,
            expectedRevision: args.expectedRevision,
          });
          publishBrainChanged?.();
          // Confirm the position and new revision, not the item just sent.
          const ack = {
            index: args.index,
            length: result.length,
            revision: result.revision,
          };
          return {
            content: [{ type: "text", text: jsonText(ack) }],
            structuredContent: toStructuredContent(ack),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_list_delete ────────────────────────────────────────────
  if (allowed.has("brain_list_delete")) {
    server.registerTool(
      "brain_list_delete",
      {
        description:
          "Delete a shared brain list by collection and name. Deletes all items in the list as well.",
        inputSchema: {
          collection: collectionSchema.describe(
            "The collection the list belongs to."
          ),
          name: nameSchema.describe(
            "The unique name of the list within the collection."
          ),
        },
      },
      async (args) => {
        try {
          const deleted = await store.deleteList(
            repoRoot,
            args.collection,
            args.name
          );
          if (deleted) publishBrainChanged?.();
          const result = { deleted };
          return {
            content: [
              {
                type: "text",
                text: deleted
                  ? `Deleted list "${args.collection}/${args.name}".`
                  : `List "${args.collection}/${args.name}" not found.`,
              },
            ],
            structuredContent: toStructuredContent(result),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_list_objects ────────────────────────────────────────────
  if (allowed.has("brain_list_objects")) {
    server.registerTool(
      "brain_list_objects",
      {
        description:
          "List objects in the shared brain. Optionally filter by collection, name prefix, " +
          "or updated-after timestamp. Returns up to `limit` objects ordered by most recently updated. " +
          `Strings inside each object's value are truncated to ${LIST_STRING_MAX} characters (marked with the ` +
          "number of characters dropped) — call brain_get_object for an object's full value.",
        inputSchema: {
          collection: collectionSchema
            .optional()
            .describe("Filter to this collection."),
          namePrefix: nameSchema
            .optional()
            .describe("Filter to objects whose name starts with this prefix."),
          updatedAfter: z
            .string()
            .optional()
            .describe(
              "Only return objects updated after this ISO 8601 timestamp."
            ),
          limit: z
            .number()
            .int()
            .positive()
            .max(200)
            .optional()
            .describe("Max objects to return (default 50, max 200)."),
        },
      },
      async (args) => {
        try {
          const objects = await store.listObjects(repoRoot, {
            collection: args.collection,
            namePrefix: args.namePrefix,
            updatedAfter: args.updatedAfter,
            limit: args.limit,
          });
          const result = {
            objects: objects.map((obj) => ({
              ...obj,
              value: truncateLongStrings(obj.value, LIST_STRING_MAX),
            })),
          };
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: toStructuredContent(result),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_delete_object ───────────────────────────────────────────
  if (allowed.has("brain_delete_object")) {
    server.registerTool(
      "brain_delete_object",
      {
        description:
          "Delete an object from the shared brain by collection and name.",
        inputSchema: {
          collection: collectionSchema.describe(
            "The collection the object belongs to."
          ),
          name: nameSchema.describe(
            "The unique name of the object within the collection."
          ),
        },
      },
      async (args) => {
        try {
          const deleted = await store.deleteObject(
            repoRoot,
            args.collection,
            args.name
          );
          if (deleted) publishBrainChanged?.();
          const result = { deleted };
          return {
            content: [
              {
                type: "text",
                text: deleted
                  ? `Deleted "${args.collection}/${args.name}".`
                  : `Object "${args.collection}/${args.name}" not found.`,
              },
            ],
            structuredContent: toStructuredContent(result),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_append_event ────────────────────────────────────────────
  if (allowed.has("brain_append_event")) {
    server.registerTool(
      "brain_append_event",
      {
        description:
          "Append a structured event to the shared brain's event log. " +
          "Events are append-only — they cannot be edited, only pruned with brain_delete_events. " +
          "Use events to record history, " +
          "assessments, decisions, or any structured observation that other agents can query.",
        inputSchema: {
          collection: collectionSchema.describe(
            "The collection this event belongs to."
          ),
          kind: kindSchema.describe(
            "The event kind/type (e.g. 'assessment', 'decision', 'observation')."
          ),
          value: z
            .record(z.string(), z.unknown())
            .describe("The JSON payload of the event."),
          subject: subjectSchema
            .optional()
            .describe(
              "Optional subject identifier for filtering (e.g. a persona name, file path)."
            ),
          tags: tagsSchema
            .optional()
            .describe(
              "Optional tags for filtering (e.g. ['noise', 'prompt-change']). Max 50 tags."
            ),
        },
      },
      async (args) => {
        try {
          const event = await store.appendEvent(repoRoot, agentId, {
            collection: args.collection,
            kind: args.kind,
            value: args.value,
            subject: args.subject,
            tags: args.tags,
          });
          publishBrainChanged?.();
          // The value is the caller's own payload; brain_query_events reads it
          // back. What it cannot know is the id the append was assigned.
          const ack = {
            id: event.id,
            collection: event.collection,
            kind: event.kind,
            createdAt: event.createdAt,
          };
          return {
            content: [{ type: "text", text: jsonText(ack) }],
            structuredContent: toStructuredContent(ack),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_delete_events ───────────────────────────────────────────
  if (allowed.has("brain_delete_events")) {
    server.registerTool(
      "brain_delete_events",
      {
        description:
          "Delete events from the shared brain's event log. " +
          "Either pass explicit event ids (from brain_query_events), or pass a collection " +
          "with optional narrowing filters (kind, subject, tags, since, until) to delete every " +
          "matching event — not both. Filter deletes always require a collection: kinds and " +
          "subjects are reused across collections, so an unscoped delete would reach much " +
          "further than it reads. Run brain_query_events without a collection to see which " +
          "collections exist. " +
          "Deletion is permanent and there is no undo: run with dryRun first to see how many " +
          "events the same selector matches.",
        inputSchema: {
          dryRun: z
            .boolean()
            .optional()
            .describe(
              "Report how many events this selector matches without deleting anything."
            ),
          ids: z
            .array(z.uuid())
            .min(1)
            .max(MAX_EVENT_IDS_PER_DELETE)
            .optional()
            .describe(
              `Event ids to delete (max ${MAX_EVENT_IDS_PER_DELETE}). Cannot be combined with filters.`
            ),
          collection: collectionSchema
            .optional()
            .describe(
              "The collection to delete from. Required unless you pass ids."
            ),
          kind: kindSchema
            .optional()
            .describe("Narrow to events of this kind within the collection."),
          subject: subjectSchema
            .optional()
            .describe("Narrow to events with this subject."),
          tags: tagsSchema
            .optional()
            .describe("Narrow to events containing all of these tags."),
          since: eventTimestampSchema
            .optional()
            .describe(
              "Delete events created at or after this ISO 8601 timestamp (e.g. 2026-01-01T00:00:00Z)."
            ),
          until: eventTimestampSchema
            .optional()
            .describe(
              "Delete events created at or before this ISO 8601 timestamp (e.g. 2026-01-01T00:00:00Z)."
            ),
        },
      },
      async (args) => {
        try {
          const result = await store.deleteEvents(
            repoRoot,
            toEventDeleteSelector({
              ids: args.ids,
              dryRun: args.dryRun,
              collection: args.collection,
              kind: args.kind,
              subject: args.subject,
              tags: args.tags,
              since: args.since,
              until: args.until,
            })
          );
          if (result.deleted > 0) publishBrainChanged?.();
          return {
            content: [
              {
                type: "text",
                text: args.dryRun
                  ? `Dry run: ${result.matched} event(s) match. Nothing was deleted.`
                  : result.deleted === 1
                    ? "Deleted 1 event."
                    : `Deleted ${result.deleted} events.`,
              },
            ],
            structuredContent: toStructuredContent(result),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_get_event ───────────────────────────────────────────────
  if (allowed.has("brain_get_event")) {
    server.registerTool(
      "brain_get_event",
      {
        description:
          "Get a single event from the shared brain's event log by id, with its value untruncated. " +
          "brain_query_events reports the ids.",
        inputSchema: {
          id: z.uuid().describe("Event id from brain_query_events."),
        },
      },
      async (args) => {
        try {
          const event = await store.getEvent(repoRoot, args.id);
          if (!event) {
            return toToolError(new Error(`Event ${args.id} not found.`));
          }
          return {
            content: [{ type: "text", text: jsonText(event) }],
            structuredContent: toStructuredContent(event),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }

  // ── brain_query_events ────────────────────────────────────────────
  if (allowed.has("brain_query_events")) {
    server.registerTool(
      "brain_query_events",
      {
        description:
          "Query the shared brain's event log. Filter by collection, kind, subject, " +
          "tags, and time range. Returns up to `limit` events. " +
          `Strings inside each event's value are truncated to ${LIST_STRING_MAX} characters ` +
          "(marked with the number of characters dropped) — call brain_get_event for one event in full.",
        inputSchema: {
          collection: collectionSchema
            .optional()
            .describe("Filter to this collection."),
          kind: kindSchema
            .optional()
            .describe("Filter to events of this kind."),
          subject: subjectSchema
            .optional()
            .describe("Filter to events with this subject."),
          tags: tagsSchema
            .optional()
            .describe("Filter to events containing all of these tags."),
          since: z
            .string()
            .optional()
            .describe(
              "Only return events created at or after this ISO 8601 timestamp."
            ),
          until: z
            .string()
            .optional()
            .describe(
              "Only return events created at or before this ISO 8601 timestamp."
            ),
          limit: z
            .number()
            .int()
            .positive()
            .max(200)
            .optional()
            .describe("Max events to return (default 50, max 200)."),
          order: z
            .enum(["asc", "desc"])
            .optional()
            .describe("Sort order by creation time (default 'desc')."),
        },
      },
      async (args) => {
        try {
          const events = await store.queryEvents(repoRoot, {
            collection: args.collection,
            kind: args.kind,
            subject: args.subject,
            tags: args.tags,
            since: args.since,
            until: args.until,
            limit: args.limit,
            order: args.order,
          });
          const result = {
            events: events.map((event) => ({
              ...event,
              value: truncateLongStrings(event.value, LIST_STRING_MAX),
            })),
          };
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: toStructuredContent(result),
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }
}
