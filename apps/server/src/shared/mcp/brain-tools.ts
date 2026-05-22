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
} from "../../brain/store.js";
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

function toBrainError(error: unknown): ToolResult {
  if (error instanceof BrainRevisionConflictError) {
    return {
      content: [{ type: "text", text: error.message }],
      isError: true,
      structuredContent: {
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
      } as Record<string, unknown>,
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
      structuredContent: {
        error: { code: error.code, message: error.message },
      } as Record<string, unknown>,
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
const listOrderSchema = z.enum(["asc", "desc"]);

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
            content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
            structuredContent: obj as unknown as Record<string, unknown>,
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
          "Blind overwrites of existing objects are rejected — you must read first.",
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
          return {
            content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
            structuredContent: obj as unknown as Record<string, unknown>,
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
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result as unknown as Record<string, unknown>,
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
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result as unknown as Record<string, unknown>,
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
          "Read items from a shared brain list. Returns the selected items, total count, and current revision.",
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
          const result = await store.getListItems(repoRoot, {
            collection: args.collection,
            name: args.name,
            limit: args.limit,
            offset: args.offset,
            order: args.order,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result as unknown as Record<string, unknown>,
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
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result as unknown as Record<string, unknown>,
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
            structuredContent: result as unknown as Record<string, unknown>,
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
          "or updated-after timestamp. Returns up to `limit` objects ordered by most recently updated.",
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
          const result = { objects };
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result as unknown as Record<string, unknown>,
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
            structuredContent: result as unknown as Record<string, unknown>,
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
          "Events are immutable and append-only. Use events to record history, " +
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
          return {
            content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
            structuredContent: event as unknown as Record<string, unknown>,
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
          "tags, and time range. Returns up to `limit` events.",
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
          const result = { events };
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (error) {
          return toBrainError(error);
        }
      }
    );
  }
}
