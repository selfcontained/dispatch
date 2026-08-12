import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrainObject, BrainEvent } from "../src/brain/store.js";
import {
  BrainNotFoundError,
  BrainListNotFoundError,
  BrainListItemNotFoundError,
  BrainRevisionConflictError,
  BrainValidationError,
  BrainLimitExceededError,
} from "../src/brain/store.js";
import { registerBrainTools } from "../src/shared/mcp/brain-tools.js";

type RegisteredCall = {
  name: string;
  config: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function createMockServer() {
  const tools: RegisteredCall[] = [];
  return {
    registerTool: vi.fn(
      (
        name: string,
        config: Record<string, unknown>,
        handler: (args: Record<string, unknown>) => Promise<unknown>
      ) => {
        tools.push({ name, config, handler });
      }
    ),
    tools,
  };
}

const REPO_ROOT = "/home/user/project";
const AGENT_ID = "agt_brain_test";

function makeBrainObject(overrides: Partial<BrainObject> = {}): BrainObject {
  return {
    collection: "test-col",
    name: "test-obj",
    value: { hello: "world" },
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdByAgentId: AGENT_ID,
    updatedByAgentId: AGENT_ID,
    ...overrides,
  };
}

function makeBrainEvent(overrides: Partial<BrainEvent> = {}): BrainEvent {
  return {
    id: "evt_123",
    collection: "test-col",
    kind: "observation",
    subject: null,
    tags: [],
    value: { note: "something happened" },
    createdAt: "2026-01-01T00:00:00.000Z",
    agentId: AGENT_ID,
    ...overrides,
  };
}

function createMockStore() {
  return {
    getObject: vi.fn(),
    storeObject: vi.fn(),
    listObjects: vi.fn(),
    deleteObject: vi.fn(),
    getListItems: vi.fn(),
    pushListItems: vi.fn(),
    removeListItem: vi.fn(),
    setListItem: vi.fn(),
    deleteList: vi.fn(),
    appendEvent: vi.fn(),
    queryEvents: vi.fn(),
    deleteEvents: vi.fn(),
  };
}

const ALL_BRAIN_TOOLS = new Set([
  "brain_get_object",
  "brain_store_object",
  "brain_list_push",
  "brain_list_remove",
  "brain_list_get",
  "brain_list_set",
  "brain_list_delete",
  "brain_list_objects",
  "brain_delete_object",
  "brain_append_event",
  "brain_delete_events",
  "brain_query_events",
]);

function findHandler(
  server: ReturnType<typeof createMockServer>,
  name: string
) {
  const tool = server.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler;
}

describe("registerBrainTools", () => {
  let server: ReturnType<typeof createMockServer>;
  let store: ReturnType<typeof createMockStore>;
  let publishBrainChanged: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    server = createMockServer();
    store = createMockStore();
    publishBrainChanged = vi.fn();
  });

  function registerAll() {
    registerBrainTools(server as never, ALL_BRAIN_TOOLS, {
      repoRoot: REPO_ROOT,
      agentId: AGENT_ID,
      store: store as never,
      publishBrainChanged,
    });
  }

  // ── Conditional registration ────────────────────────────────────

  describe("conditional registration", () => {
    it("registers all 12 tools when all are allowed", () => {
      registerAll();
      const names = server.tools.map((t) => t.name);
      expect(names).toEqual([
        "brain_get_object",
        "brain_store_object",
        "brain_list_push",
        "brain_list_remove",
        "brain_list_get",
        "brain_list_set",
        "brain_list_delete",
        "brain_list_objects",
        "brain_delete_object",
        "brain_append_event",
        "brain_delete_events",
        "brain_query_events",
      ]);
    });

    it("registers nothing when allowed set is empty", () => {
      registerBrainTools(server as never, new Set(), {
        repoRoot: REPO_ROOT,
        agentId: AGENT_ID,
        store: store as never,
      });
      expect(server.tools).toHaveLength(0);
    });

    it("registers only the tools in the allowed set", () => {
      registerBrainTools(
        server as never,
        new Set(["brain_get_object", "brain_append_event"]),
        { repoRoot: REPO_ROOT, agentId: AGENT_ID, store: store as never }
      );
      const names = server.tools.map((t) => t.name);
      expect(names).toEqual(["brain_get_object", "brain_append_event"]);
    });
  });

  // ── brain_get_object ───────────────────────────────────────────

  describe("brain_get_object", () => {
    it("returns the object with structuredContent on success", async () => {
      const obj = makeBrainObject();
      store.getObject.mockResolvedValue(obj);
      registerAll();

      const handler = findHandler(server, "brain_get_object");
      const result = (await handler({
        collection: "test-col",
        name: "test-obj",
      })) as { content: unknown[]; structuredContent: unknown; isError?: true };

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(obj);
      expect(store.getObject).toHaveBeenCalledWith(
        REPO_ROOT,
        "test-col",
        "test-obj"
      );
    });

    it("returns an error when object is not found", async () => {
      store.getObject.mockResolvedValue(null);
      registerAll();

      const handler = findHandler(server, "brain_get_object");
      const result = (await handler({
        collection: "col",
        name: "missing",
      })) as { isError?: true; structuredContent: { error: { code: string } } };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("not_found");
    });

    it("returns an error when store throws", async () => {
      store.getObject.mockRejectedValue(new Error("DB down"));
      registerAll();

      const handler = findHandler(server, "brain_get_object");
      const result = (await handler({
        collection: "col",
        name: "obj",
      })) as { isError?: true; content: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("DB down");
    });

    it("does not call publishBrainChanged", async () => {
      store.getObject.mockResolvedValue(makeBrainObject());
      registerAll();

      await findHandler(
        server,
        "brain_get_object"
      )({
        collection: "c",
        name: "n",
      });
      expect(publishBrainChanged).not.toHaveBeenCalled();
    });
  });

  // ── brain_store_object ─────────────────────────────────────────

  describe("brain_store_object", () => {
    it("creates an object and calls publishBrainChanged", async () => {
      const obj = makeBrainObject();
      store.storeObject.mockResolvedValue(obj);
      registerAll();

      const handler = findHandler(server, "brain_store_object");
      const result = (await handler({
        collection: "test-col",
        name: "test-obj",
        value: { hello: "world" },
      })) as { structuredContent: unknown; isError?: true };

      expect(result.isError).toBeUndefined();
      // A write acknowledges what changed; it does not echo the stored value.
      expect(result.structuredContent).toEqual({
        collection: obj.collection,
        name: obj.name,
        revision: obj.revision,
        updatedAt: obj.updatedAt,
      });
      expect(publishBrainChanged).toHaveBeenCalledOnce();
      expect(store.storeObject).toHaveBeenCalledWith(REPO_ROOT, AGENT_ID, {
        collection: "test-col",
        name: "test-obj",
        value: { hello: "world" },
        expectedRevision: undefined,
      });
    });

    it("passes expectedRevision when provided", async () => {
      store.storeObject.mockResolvedValue(makeBrainObject({ revision: 2 }));
      registerAll();

      await findHandler(
        server,
        "brain_store_object"
      )({
        collection: "c",
        name: "n",
        value: { x: 1 },
        expectedRevision: 1,
      });

      expect(store.storeObject).toHaveBeenCalledWith(REPO_ROOT, AGENT_ID, {
        collection: "c",
        name: "n",
        value: { x: 1 },
        expectedRevision: 1,
      });
    });

    it("returns revision_conflict error with current object", async () => {
      const current = makeBrainObject({ revision: 5 });
      store.storeObject.mockRejectedValue(
        new BrainRevisionConflictError(current)
      );
      registerAll();

      const result = (await findHandler(
        server,
        "brain_store_object"
      )({
        collection: "c",
        name: "n",
        value: {},
        expectedRevision: 3,
      })) as {
        isError: true;
        structuredContent: {
          error: {
            code: string;
            current: { revision: number; value: unknown };
          };
        };
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("revision_conflict");
      expect(result.structuredContent.error.current.revision).toBe(5);
      expect(result.structuredContent.error.current.value).toEqual({
        hello: "world",
      });
    });

    it("returns validation_error when blind overwrite attempted", async () => {
      store.storeObject.mockRejectedValue(
        new BrainValidationError("already exists at revision 1")
      );
      registerAll();

      const result = (await findHandler(
        server,
        "brain_store_object"
      )({
        collection: "c",
        name: "n",
        value: {},
      })) as {
        isError: true;
        structuredContent: { error: { code: string } };
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("validation_error");
    });
  });

  // ── brain_list_objects ─────────────────────────────────────────

  describe("brain_list_objects", () => {
    it("truncates long strings in listed values but keeps short ones intact", async () => {
      const details = "x".repeat(1000);
      store.listObjects.mockResolvedValue([
        makeBrainObject({
          value: { title: "An idea", details, tags: ["a", "b"] },
        }),
      ]);
      registerAll();

      const result = (await findHandler(server, "brain_list_objects")({})) as {
        structuredContent: {
          objects: Array<{ value: { title: string; details: string } }>;
        };
      };

      const listed = result.structuredContent.objects[0]!.value;
      expect(listed.title).toBe("An idea");
      expect(listed.details).toBe(`${"x".repeat(400)}…[+600 chars]`);
    });

    it("leaves values alone when nothing exceeds the cap", async () => {
      const value = { title: "Short", status: "idea" };
      store.listObjects.mockResolvedValue([makeBrainObject({ value })]);
      registerAll();

      const result = (await findHandler(server, "brain_list_objects")({})) as {
        structuredContent: { objects: Array<{ value: unknown }> };
      };

      expect(result.structuredContent.objects[0]!.value).toEqual(value);
    });
  });

  // ── brain_list_push ────────────────────────────────────────────

  describe("brain_list_push", () => {
    it("pushes items and calls publishBrainChanged", async () => {
      const pushResult = { totalCount: 2, revision: 3 };
      store.pushListItems.mockResolvedValue(pushResult);
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_push"
      )({
        collection: "col",
        name: "mylist",
        items: [{ a: 1 }, { b: 2 }],
      })) as { structuredContent: unknown; isError?: true };

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(pushResult);
      expect(publishBrainChanged).toHaveBeenCalledOnce();
      expect(store.pushListItems).toHaveBeenCalledWith(REPO_ROOT, AGENT_ID, {
        collection: "col",
        name: "mylist",
        items: [{ a: 1 }, { b: 2 }],
        maxItems: undefined,
        expectedRevision: undefined,
      });
    });

    it("passes maxItems and expectedRevision when provided", async () => {
      store.pushListItems.mockResolvedValue({ totalCount: 1, revision: 2 });
      registerAll();

      await findHandler(
        server,
        "brain_list_push"
      )({
        collection: "c",
        name: "l",
        items: [{ x: 1 }],
        maxItems: 50,
        expectedRevision: 1,
      });

      expect(store.pushListItems).toHaveBeenCalledWith(REPO_ROOT, AGENT_ID, {
        collection: "c",
        name: "l",
        items: [{ x: 1 }],
        maxItems: 50,
        expectedRevision: 1,
      });
    });

    it("returns limit_exceeded error", async () => {
      store.pushListItems.mockRejectedValue(
        new BrainLimitExceededError("Too many items")
      );
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_push"
      )({
        collection: "c",
        name: "l",
        items: [{ x: 1 }],
      })) as {
        isError: true;
        structuredContent: { error: { code: string } };
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("limit_exceeded");
    });
  });

  // ── brain_list_remove ──────────────────────────────────────────

  describe("brain_list_remove", () => {
    it("removes by index and calls publishBrainChanged", async () => {
      const removeResult = { totalCount: 4, revision: 7 };
      store.removeListItem.mockResolvedValue(removeResult);
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_remove"
      )({
        collection: "c",
        name: "l",
        index: 2,
      })) as { structuredContent: unknown; isError?: true };

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(removeResult);
      expect(publishBrainChanged).toHaveBeenCalledOnce();
      expect(store.removeListItem).toHaveBeenCalledWith(REPO_ROOT, AGENT_ID, {
        collection: "c",
        name: "l",
        index: 2,
        where: undefined,
        expectedRevision: undefined,
      });
    });

    it("removes by where clause", async () => {
      store.removeListItem.mockResolvedValue({ totalCount: 3, revision: 8 });
      registerAll();

      await findHandler(
        server,
        "brain_list_remove"
      )({
        collection: "c",
        name: "l",
        where: { field: "id", equals: "abc" },
      });

      expect(store.removeListItem).toHaveBeenCalledWith(REPO_ROOT, AGENT_ID, {
        collection: "c",
        name: "l",
        index: undefined,
        where: { field: "id", equals: "abc" },
        expectedRevision: undefined,
      });
    });

    it("returns not_found error for missing item", async () => {
      store.removeListItem.mockRejectedValue(
        new BrainListItemNotFoundError("c", "l", { index: 99 })
      );
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_remove"
      )({
        collection: "c",
        name: "l",
        index: 99,
      })) as {
        isError: true;
        structuredContent: { error: { code: string } };
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("not_found");
    });

    it("returns not_found error for missing list", async () => {
      store.removeListItem.mockRejectedValue(
        new BrainListNotFoundError("c", "missing")
      );
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_remove"
      )({
        collection: "c",
        name: "missing",
        index: 0,
      })) as {
        isError: true;
        structuredContent: { error: { code: string } };
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("not_found");
    });
  });

  // ── brain_list_get ─────────────────────────────────────────────

  describe("brain_list_get", () => {
    it("returns items with structuredContent", async () => {
      const listResult = {
        items: [{ index: 0, value: { x: 1 } }],
        totalCount: 1,
        revision: 2,
      };
      store.getListItems.mockResolvedValue(listResult);
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_get"
      )({
        collection: "c",
        name: "l",
      })) as { structuredContent: unknown; isError?: true };

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(listResult);
      expect(store.getListItems).toHaveBeenCalledWith(REPO_ROOT, {
        collection: "c",
        name: "l",
        limit: undefined,
        offset: undefined,
        order: undefined,
      });
    });

    it("passes pagination and order parameters", async () => {
      store.getListItems.mockResolvedValue({
        items: [],
        totalCount: 0,
        revision: 1,
      });
      registerAll();

      await findHandler(
        server,
        "brain_list_get"
      )({
        collection: "c",
        name: "l",
        limit: 10,
        offset: 5,
        order: "desc",
      });

      expect(store.getListItems).toHaveBeenCalledWith(REPO_ROOT, {
        collection: "c",
        name: "l",
        limit: 10,
        offset: 5,
        order: "desc",
      });
    });

    it("does not call publishBrainChanged", async () => {
      store.getListItems.mockResolvedValue({
        items: [],
        totalCount: 0,
        revision: 1,
      });
      registerAll();

      await findHandler(
        server,
        "brain_list_get"
      )({
        collection: "c",
        name: "l",
      });
      expect(publishBrainChanged).not.toHaveBeenCalled();
    });
  });

  // ── brain_list_set ─────────────────────────────────────────────

  describe("brain_list_set", () => {
    it("replaces an item and calls publishBrainChanged", async () => {
      const setResult = { totalCount: 3, revision: 5 };
      store.setListItem.mockResolvedValue(setResult);
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_set"
      )({
        collection: "c",
        name: "l",
        index: 1,
        value: { updated: true },
        expectedRevision: 4,
      })) as { structuredContent: unknown; isError?: true };

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(setResult);
      expect(publishBrainChanged).toHaveBeenCalledOnce();
      expect(store.setListItem).toHaveBeenCalledWith(REPO_ROOT, AGENT_ID, {
        collection: "c",
        name: "l",
        index: 1,
        value: { updated: true },
        expectedRevision: 4,
      });
    });

    it("returns revision_conflict error for list", async () => {
      const currentList = {
        collection: "c",
        name: "l",
        revision: 6,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        createdByAgentId: AGENT_ID,
        updatedByAgentId: AGENT_ID,
      };
      store.setListItem.mockRejectedValue(
        new BrainRevisionConflictError(currentList)
      );
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_set"
      )({
        collection: "c",
        name: "l",
        index: 0,
        value: {},
        expectedRevision: 3,
      })) as {
        isError: true;
        structuredContent: {
          error: { code: string; current: { revision: number } };
        };
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("revision_conflict");
      expect(result.structuredContent.error.current.revision).toBe(6);
    });
  });

  // ── brain_list_delete ──────────────────────────────────────────

  describe("brain_list_delete", () => {
    it("returns deleted: true and calls publishBrainChanged", async () => {
      store.deleteList.mockResolvedValue(true);
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_delete"
      )({
        collection: "c",
        name: "l",
      })) as {
        content: Array<{ text: string }>;
        structuredContent: { deleted: boolean };
      };

      expect(result.structuredContent.deleted).toBe(true);
      expect(result.content[0].text).toContain("Deleted list");
      expect(publishBrainChanged).toHaveBeenCalledOnce();
    });

    it("returns deleted: false and does not call publishBrainChanged", async () => {
      store.deleteList.mockResolvedValue(false);
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_delete"
      )({
        collection: "c",
        name: "missing",
      })) as {
        content: Array<{ text: string }>;
        structuredContent: { deleted: boolean };
      };

      expect(result.structuredContent.deleted).toBe(false);
      expect(result.content[0].text).toContain("not found");
      expect(publishBrainChanged).not.toHaveBeenCalled();
    });
  });

  // ── brain_list_objects ─────────────────────────────────────────

  describe("brain_list_objects", () => {
    it("returns objects with filter params", async () => {
      const objects = [makeBrainObject()];
      store.listObjects.mockResolvedValue(objects);
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_objects"
      )({
        collection: "test-col",
        namePrefix: "state",
        limit: 10,
      })) as { structuredContent: { objects: unknown[] }; isError?: true };

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.objects).toEqual(objects);
      expect(store.listObjects).toHaveBeenCalledWith(REPO_ROOT, {
        collection: "test-col",
        namePrefix: "state",
        updatedAfter: undefined,
        limit: 10,
      });
    });

    it("does not call publishBrainChanged", async () => {
      store.listObjects.mockResolvedValue([]);
      registerAll();

      await findHandler(server, "brain_list_objects")({});
      expect(publishBrainChanged).not.toHaveBeenCalled();
    });
  });

  // ── brain_delete_object ────────────────────────────────────────

  describe("brain_delete_object", () => {
    it("returns deleted: true and calls publishBrainChanged", async () => {
      store.deleteObject.mockResolvedValue(true);
      registerAll();

      const result = (await findHandler(
        server,
        "brain_delete_object"
      )({
        collection: "c",
        name: "obj",
      })) as {
        content: Array<{ text: string }>;
        structuredContent: { deleted: boolean };
      };

      expect(result.structuredContent.deleted).toBe(true);
      expect(result.content[0].text).toContain('Deleted "c/obj"');
      expect(publishBrainChanged).toHaveBeenCalledOnce();
    });

    it("returns deleted: false and does not call publishBrainChanged", async () => {
      store.deleteObject.mockResolvedValue(false);
      registerAll();

      const result = (await findHandler(
        server,
        "brain_delete_object"
      )({
        collection: "c",
        name: "missing",
      })) as {
        content: Array<{ text: string }>;
        structuredContent: { deleted: boolean };
      };

      expect(result.structuredContent.deleted).toBe(false);
      expect(result.content[0].text).toContain("not found");
      expect(publishBrainChanged).not.toHaveBeenCalled();
    });
  });

  // ── brain_append_event ─────────────────────────────────────────

  describe("brain_append_event", () => {
    it("appends an event and calls publishBrainChanged", async () => {
      const event = makeBrainEvent();
      store.appendEvent.mockResolvedValue(event);
      registerAll();

      const result = (await findHandler(
        server,
        "brain_append_event"
      )({
        collection: "test-col",
        kind: "observation",
        value: { note: "something happened" },
      })) as { structuredContent: unknown; isError?: true };

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(event);
      expect(publishBrainChanged).toHaveBeenCalledOnce();
      expect(store.appendEvent).toHaveBeenCalledWith(REPO_ROOT, AGENT_ID, {
        collection: "test-col",
        kind: "observation",
        value: { note: "something happened" },
        subject: undefined,
        tags: undefined,
      });
    });

    it("passes subject and tags when provided", async () => {
      store.appendEvent.mockResolvedValue(
        makeBrainEvent({ subject: "file.ts", tags: ["review"] })
      );
      registerAll();

      await findHandler(
        server,
        "brain_append_event"
      )({
        collection: "c",
        kind: "assessment",
        value: { rating: "good" },
        subject: "file.ts",
        tags: ["review"],
      });

      expect(store.appendEvent).toHaveBeenCalledWith(REPO_ROOT, AGENT_ID, {
        collection: "c",
        kind: "assessment",
        value: { rating: "good" },
        subject: "file.ts",
        tags: ["review"],
      });
    });

    it("returns error when store throws", async () => {
      store.appendEvent.mockRejectedValue(
        new BrainValidationError("Invalid event")
      );
      registerAll();

      const result = (await findHandler(
        server,
        "brain_append_event"
      )({
        collection: "c",
        kind: "k",
        value: {},
      })) as {
        isError: true;
        structuredContent: { error: { code: string } };
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("validation_error");
    });
  });

  // ── brain_delete_events ────────────────────────────────────────

  describe("brain_delete_events", () => {
    it("deletes by ids and publishes the change", async () => {
      store.deleteEvents.mockResolvedValue({ deleted: 2, matched: 2 });
      registerAll();

      const result = (await findHandler(
        server,
        "brain_delete_events"
      )({
        ids: ["11111111-1111-4111-8111-111111111111"],
      })) as {
        structuredContent: { deleted: number };
        content: Array<{ text: string }>;
        isError?: true;
      };

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ deleted: 2, matched: 2 });
      expect(result.content[0].text).toBe("Deleted 2 events.");
      expect(publishBrainChanged).toHaveBeenCalledTimes(1);
      expect(store.deleteEvents).toHaveBeenCalledWith(REPO_ROOT, {
        ids: ["11111111-1111-4111-8111-111111111111"],
        dryRun: undefined,
        collection: undefined,
        kind: undefined,
        subject: undefined,
        tags: undefined,
        since: undefined,
        until: undefined,
      });
    });

    it("passes all filter parameters", async () => {
      store.deleteEvents.mockResolvedValue({ deleted: 1, matched: 1 });
      registerAll();

      const result = (await findHandler(
        server,
        "brain_delete_events"
      )({
        collection: "c",
        kind: "run",
        subject: "test-enforcer",
        tags: ["ci"],
        since: "2026-01-01T00:00:00Z",
        until: "2026-12-31T00:00:00Z",
      })) as { content: Array<{ text: string }> };

      expect(result.content[0].text).toBe("Deleted 1 event.");
      expect(store.deleteEvents).toHaveBeenCalledWith(REPO_ROOT, {
        ids: undefined,
        dryRun: undefined,
        collection: "c",
        kind: "run",
        subject: "test-enforcer",
        tags: ["ci"],
        since: "2026-01-01T00:00:00Z",
        until: "2026-12-31T00:00:00Z",
      });
    });

    it("does not publish when nothing matched", async () => {
      store.deleteEvents.mockResolvedValue({ deleted: 0, matched: 0 });
      registerAll();

      const result = (await findHandler(
        server,
        "brain_delete_events"
      )({
        collection: "c",
        kind: "run",
      })) as { content: Array<{ text: string }> };

      expect(result.content[0].text).toBe("Deleted 0 events.");
      expect(publishBrainChanged).not.toHaveBeenCalled();
    });

    it("reports the match count on a dry run without publishing", async () => {
      store.deleteEvents.mockResolvedValue({ deleted: 0, matched: 412 });
      registerAll();

      const result = (await findHandler(
        server,
        "brain_delete_events"
      )({
        collection: "c",
        dryRun: true,
      })) as {
        structuredContent: { deleted: number; matched: number };
        content: Array<{ text: string }>;
      };

      expect(result.content[0].text).toBe(
        "Dry run: 412 event(s) match. Nothing was deleted."
      );
      expect(result.structuredContent).toEqual({ deleted: 0, matched: 412 });
      expect(publishBrainChanged).not.toHaveBeenCalled();
      expect(store.deleteEvents).toHaveBeenCalledWith(
        REPO_ROOT,
        expect.objectContaining({ dryRun: true, collection: "c" })
      );
    });

    it("surfaces limit errors from the store", async () => {
      store.deleteEvents.mockRejectedValue(
        new BrainLimitExceededError("Event delete accepts at most 200 ids")
      );
      registerAll();

      const result = (await findHandler(
        server,
        "brain_delete_events"
      )({
        ids: ["11111111-1111-4111-8111-111111111111"],
      })) as {
        isError: true;
        structuredContent: { error: { code: string } };
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("limit_exceeded");
    });

    it("surfaces validation errors from the store", async () => {
      store.deleteEvents.mockRejectedValue(
        new BrainValidationError("Provide either ids or at least one filter")
      );
      registerAll();

      const result = (await findHandler(server, "brain_delete_events")({})) as {
        isError: true;
        structuredContent: { error: { code: string } };
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("validation_error");
      expect(publishBrainChanged).not.toHaveBeenCalled();
    });
  });

  // ── brain_query_events ─────────────────────────────────────────

  describe("brain_query_events", () => {
    it("returns events with filter params", async () => {
      const events = [makeBrainEvent()];
      store.queryEvents.mockResolvedValue(events);
      registerAll();

      const result = (await findHandler(
        server,
        "brain_query_events"
      )({
        collection: "test-col",
        kind: "observation",
        limit: 5,
        order: "asc",
      })) as { structuredContent: { events: unknown[] }; isError?: true };

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.events).toEqual(events);
      expect(store.queryEvents).toHaveBeenCalledWith(REPO_ROOT, {
        collection: "test-col",
        kind: "observation",
        subject: undefined,
        tags: undefined,
        since: undefined,
        until: undefined,
        limit: 5,
        order: "asc",
      });
    });

    it("passes all filter parameters", async () => {
      store.queryEvents.mockResolvedValue([]);
      registerAll();

      await findHandler(
        server,
        "brain_query_events"
      )({
        collection: "c",
        kind: "run",
        subject: "test-enforcer",
        tags: ["ci"],
        since: "2026-01-01T00:00:00Z",
        until: "2026-12-31T00:00:00Z",
        limit: 100,
        order: "desc",
      });

      expect(store.queryEvents).toHaveBeenCalledWith(REPO_ROOT, {
        collection: "c",
        kind: "run",
        subject: "test-enforcer",
        tags: ["ci"],
        since: "2026-01-01T00:00:00Z",
        until: "2026-12-31T00:00:00Z",
        limit: 100,
        order: "desc",
      });
    });

    it("does not call publishBrainChanged", async () => {
      store.queryEvents.mockResolvedValue([]);
      registerAll();

      await findHandler(server, "brain_query_events")({});
      expect(publishBrainChanged).not.toHaveBeenCalled();
    });
  });

  // ── toBrainError coverage ──────────────────────────────────────

  describe("error handling", () => {
    it("BrainRevisionConflictError for list omits value from current", async () => {
      const currentList = {
        collection: "c",
        name: "l",
        revision: 10,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        createdByAgentId: AGENT_ID,
        updatedByAgentId: AGENT_ID,
      };
      store.pushListItems.mockRejectedValue(
        new BrainRevisionConflictError(currentList)
      );
      registerAll();

      const result = (await findHandler(
        server,
        "brain_list_push"
      )({
        collection: "c",
        name: "l",
        items: [{ x: 1 }],
        expectedRevision: 8,
      })) as {
        isError: true;
        structuredContent: {
          error: { code: string; current: Record<string, unknown> };
        };
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("revision_conflict");
      expect(result.structuredContent.error.current.revision).toBe(10);
      expect(result.structuredContent.error.current).not.toHaveProperty(
        "value"
      );
    });

    it("generic Error falls through to toToolError", async () => {
      store.getObject.mockRejectedValue(new TypeError("unexpected null"));
      registerAll();

      const result = (await findHandler(
        server,
        "brain_get_object"
      )({
        collection: "c",
        name: "n",
      })) as { isError: true; content: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("unexpected null");
    });

    it("non-Error value falls through to toToolError", async () => {
      store.deleteObject.mockRejectedValue("string error");
      registerAll();

      const result = (await findHandler(
        server,
        "brain_delete_object"
      )({
        collection: "c",
        name: "n",
      })) as { isError: true; content: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("string error");
    });
  });

  // ── publishBrainChanged optional ───────────────────────────────

  describe("publishBrainChanged optional", () => {
    it("works when publishBrainChanged is not provided", async () => {
      store.storeObject.mockResolvedValue(makeBrainObject());
      registerBrainTools(server as never, new Set(["brain_store_object"]), {
        repoRoot: REPO_ROOT,
        agentId: AGENT_ID,
        store: store as never,
      });

      const result = (await findHandler(
        server,
        "brain_store_object"
      )({
        collection: "c",
        name: "n",
        value: {},
      })) as { isError?: true };

      expect(result.isError).toBeUndefined();
    });
  });
});
