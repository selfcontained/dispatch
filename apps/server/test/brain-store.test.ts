import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";

import {
  BrainStore,
  BrainNotFoundError,
  BrainListNotFoundError,
  BrainListItemNotFoundError,
  BrainRevisionConflictError,
  BrainValidationError,
} from "../src/brain/store.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let pool: Pool;
let store: BrainStore;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new BrainStore(pool);
});

afterAll(async () => {
  await teardownTestDb();
});

const REPO = "/repo/test";
const REPO_B = "/repo/other";
const AGENT = "agt_test1";
const AGENT_B = "agt_test2";

// ── Objects ─────────────────────────────────────────────────────────

describe("BrainStore objects", () => {
  it("creates and gets an object", async () => {
    const obj = await store.storeObject(REPO, AGENT, {
      collection: "config",
      name: "settings",
      value: { theme: "dark" },
    });

    expect(obj.collection).toBe("config");
    expect(obj.name).toBe("settings");
    expect(obj.value).toEqual({ theme: "dark" });
    expect(obj.revision).toBe(1);
    expect(obj.createdByAgentId).toBe(AGENT);
    expect(obj.updatedByAgentId).toBe(AGENT);

    const fetched = await store.getObject(REPO, "config", "settings");
    expect(fetched).not.toBeNull();
    expect(fetched!.value).toEqual({ theme: "dark" });
    expect(fetched!.revision).toBe(1);
  });

  it("updates an object with correct expectedRevision", async () => {
    const updated = await store.storeObject(REPO, AGENT_B, {
      collection: "config",
      name: "settings",
      value: { theme: "light" },
      expectedRevision: 1,
    });

    expect(updated.revision).toBe(2);
    expect(updated.value).toEqual({ theme: "light" });
    expect(updated.createdByAgentId).toBe(AGENT);
    expect(updated.updatedByAgentId).toBe(AGENT_B);
  });

  it("rejects blind overwrite of existing object", async () => {
    await expect(
      store.storeObject(REPO, AGENT, {
        collection: "config",
        name: "settings",
        value: { theme: "blue" },
      })
    ).rejects.toThrow(BrainValidationError);
  });

  it("rejects stale expectedRevision", async () => {
    await expect(
      store.storeObject(REPO, AGENT, {
        collection: "config",
        name: "settings",
        value: { theme: "red" },
        expectedRevision: 1,
      })
    ).rejects.toThrow(BrainRevisionConflictError);
  });

  it("rejects expectedRevision on non-existent object", async () => {
    await expect(
      store.storeObject(REPO, AGENT, {
        collection: "config",
        name: "nonexistent",
        value: {},
        expectedRevision: 1,
      })
    ).rejects.toThrow(BrainNotFoundError);
  });

  it("lists objects with filters", async () => {
    await store.storeObject(REPO, AGENT, {
      collection: "config",
      name: "frontend-flags",
      value: { beta: true },
    });

    const all = await store.listObjects(REPO, { collection: "config" });
    expect(all.length).toBeGreaterThanOrEqual(2);

    const prefixed = await store.listObjects(REPO, {
      collection: "config",
      namePrefix: "front",
    });
    expect(prefixed).toHaveLength(1);
    expect(prefixed[0].name).toBe("frontend-flags");
  });

  it("respects limit", async () => {
    const limited = await store.listObjects(REPO, {
      collection: "config",
      limit: 1,
    });
    expect(limited).toHaveLength(1);
  });

  it("deletes an object", async () => {
    const deleted = await store.deleteObject(REPO, "config", "frontend-flags");
    expect(deleted).toBe(true);

    const fetched = await store.getObject(REPO, "config", "frontend-flags");
    expect(fetched).toBeNull();
  });

  it("returns false when deleting non-existent object", async () => {
    const deleted = await store.deleteObject(REPO, "config", "nope");
    expect(deleted).toBe(false);
  });

  it("isolates objects by repo", async () => {
    await store.storeObject(REPO_B, AGENT, {
      collection: "config",
      name: "settings",
      value: { isolated: true },
    });

    const fromA = await store.getObject(REPO, "config", "settings");
    const fromB = await store.getObject(REPO_B, "config", "settings");

    expect(fromA!.value).toEqual({ theme: "light" });
    expect(fromB!.value).toEqual({ isolated: true });
  });
});

// ── Events ──────────────────────────────────────────────────────────

describe("BrainStore events", () => {
  it("appends and queries events", async () => {
    const event = await store.appendEvent(REPO, AGENT, {
      collection: "reviews",
      kind: "assessment",
      value: { score: 0.8 },
      subject: "ux-review",
      tags: ["noise"],
    });

    expect(event.id).toBeDefined();
    expect(event.collection).toBe("reviews");
    expect(event.kind).toBe("assessment");
    expect(event.subject).toBe("ux-review");
    expect(event.tags).toEqual(["noise"]);
    expect(event.value).toEqual({ score: 0.8 });
    expect(event.agentId).toBe(AGENT);

    const results = await store.queryEvents(REPO, {
      collection: "reviews",
    });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(event.id);
  });

  it("queries by kind", async () => {
    await store.appendEvent(REPO, AGENT, {
      collection: "reviews",
      kind: "decision",
      value: { action: "approve" },
    });

    const assessments = await store.queryEvents(REPO, {
      collection: "reviews",
      kind: "assessment",
    });
    expect(assessments).toHaveLength(1);

    const decisions = await store.queryEvents(REPO, {
      collection: "reviews",
      kind: "decision",
    });
    expect(decisions).toHaveLength(1);
  });

  it("queries by subject", async () => {
    const results = await store.queryEvents(REPO, {
      collection: "reviews",
      subject: "ux-review",
    });
    expect(results).toHaveLength(1);
    expect(results[0].subject).toBe("ux-review");
  });

  it("queries by tags", async () => {
    await store.appendEvent(REPO, AGENT, {
      collection: "reviews",
      kind: "observation",
      value: { note: "tagged" },
      tags: ["noise", "prompt-change"],
    });

    const noiseEvents = await store.queryEvents(REPO, {
      collection: "reviews",
      tags: ["noise"],
    });
    expect(noiseEvents.length).toBeGreaterThanOrEqual(2);

    const multiTag = await store.queryEvents(REPO, {
      collection: "reviews",
      tags: ["noise", "prompt-change"],
    });
    expect(multiTag).toHaveLength(1);
  });

  it("queries by time range", async () => {
    const past = new Date(Date.now() - 60000).toISOString();
    const future = new Date(Date.now() + 60000).toISOString();

    const inRange = await store.queryEvents(REPO, {
      collection: "reviews",
      since: past,
      until: future,
    });
    expect(inRange.length).toBeGreaterThan(0);

    const outOfRange = await store.queryEvents(REPO, {
      collection: "reviews",
      since: future,
    });
    expect(outOfRange).toHaveLength(0);
  });

  it("orders ascending", async () => {
    const desc = await store.queryEvents(REPO, {
      collection: "reviews",
      order: "desc",
    });
    const asc = await store.queryEvents(REPO, {
      collection: "reviews",
      order: "asc",
    });

    expect(desc.length).toBe(asc.length);
    expect(desc[0].id).toBe(asc[asc.length - 1].id);
  });

  it("enforces default limit", async () => {
    for (let i = 0; i < 55; i++) {
      await store.appendEvent(REPO, AGENT, {
        collection: "bulk",
        kind: "tick",
        value: { i },
      });
    }

    const defaultResult = await store.queryEvents(REPO, {
      collection: "bulk",
    });
    expect(defaultResult).toHaveLength(50);
  });

  it("enforces max limit", async () => {
    const maxResult = await store.queryEvents(REPO, {
      collection: "bulk",
      limit: 999,
    });
    expect(maxResult.length).toBeLessThanOrEqual(200);
  });

  it("isolates events by repo", async () => {
    await store.appendEvent(REPO_B, AGENT, {
      collection: "reviews",
      kind: "isolated",
      value: { repo: "B" },
    });

    const repoA = await store.queryEvents(REPO, {
      collection: "reviews",
      kind: "isolated",
    });
    expect(repoA).toHaveLength(0);

    const repoB = await store.queryEvents(REPO_B, {
      collection: "reviews",
      kind: "isolated",
    });
    expect(repoB).toHaveLength(1);
  });
});

// ── Lists ───────────────────────────────────────────────────────────

describe("BrainStore lists", () => {
  it("pushes and gets list items", async () => {
    const pushed = await store.pushListItems(REPO, AGENT, {
      collection: "job-state",
      name: "backlog",
      items: [{ id: "a" }, { id: "b" }],
    });

    expect(pushed.length).toBe(2);
    expect(pushed.revision).toBe(1);

    const list = await store.getList(REPO, "job-state", "backlog");
    expect(list).not.toBeNull();
    expect(list!.revision).toBe(1);

    const fetched = await store.getListItems(REPO, {
      collection: "job-state",
      name: "backlog",
    });
    expect(fetched.totalCount).toBe(2);
    expect(fetched.revision).toBe(1);
    expect(fetched.items.map((item) => item.value)).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
  });

  it("supports pagination and descending order", async () => {
    const paged = await store.getListItems(REPO, {
      collection: "job-state",
      name: "backlog",
      order: "desc",
      limit: 1,
      offset: 0,
    });

    expect(paged.totalCount).toBe(2);
    expect(paged.items).toHaveLength(1);
    expect(paged.items[0].index).toBe(1);
    expect(paged.items[0].value).toEqual({ id: "b" });
  });

  it("trims from the front when maxItems is set", async () => {
    const pushed = await store.pushListItems(REPO, AGENT_B, {
      collection: "job-state",
      name: "backlog",
      items: [{ id: "c" }, { id: "d" }],
      maxItems: 3,
    });

    expect(pushed.length).toBe(3);

    const fetched = await store.getListItems(REPO, {
      collection: "job-state",
      name: "backlog",
    });
    expect(fetched.items.map((item) => item.value)).toEqual([
      { id: "b" },
      { id: "c" },
      { id: "d" },
    ]);
    expect(fetched.items.map((item) => item.index)).toEqual([0, 1, 2]);
  });

  it("removes by index and reindexes remaining items", async () => {
    const removed = await store.removeListItem(REPO, AGENT, {
      collection: "job-state",
      name: "backlog",
      index: 1,
    });

    expect(removed.removed).toEqual({ id: "c" });
    expect(removed.length).toBe(2);

    const fetched = await store.getListItems(REPO, {
      collection: "job-state",
      name: "backlog",
    });
    expect(fetched.items.map((item) => item.value)).toEqual([
      { id: "b" },
      { id: "d" },
    ]);
    expect(fetched.items.map((item) => item.index)).toEqual([0, 1]);
  });

  it("removes by field match", async () => {
    const removed = await store.removeListItem(REPO, AGENT, {
      collection: "job-state",
      name: "backlog",
      where: { field: "id", equals: "b" },
    });

    expect(removed.removed).toEqual({ id: "b" });

    const fetched = await store.getListItems(REPO, {
      collection: "job-state",
      name: "backlog",
    });
    expect(fetched.items.map((item) => item.value)).toEqual([{ id: "d" }]);
    expect(fetched.items[0].index).toBe(0);
  });

  it("sets a single list item", async () => {
    const list = await store.getList(REPO, "job-state", "backlog");
    expect(list).not.toBeNull();

    const updated = await store.setListItem(REPO, AGENT_B, {
      collection: "job-state",
      name: "backlog",
      index: 0,
      value: { id: "d", status: "fixed" },
      expectedRevision: list!.revision,
    });

    expect(updated.item.value).toEqual({ id: "d", status: "fixed" });

    const fetched = await store.getListItems(REPO, {
      collection: "job-state",
      name: "backlog",
    });
    expect(fetched.items[0].value).toEqual({ id: "d", status: "fixed" });
  });

  it("returns an empty result for a missing list", async () => {
    const missing = await store.getListItems(REPO, {
      collection: "job-state",
      name: "missing",
    });

    expect(missing).toEqual({ items: [], totalCount: 0, revision: 0 });
  });

  it("enforces list revision checks when provided", async () => {
    const list = await store.getList(REPO, "job-state", "backlog");
    expect(list).not.toBeNull();

    await expect(
      store.pushListItems(REPO, AGENT, {
        collection: "job-state",
        name: "backlog",
        items: [{ id: "e" }],
        expectedRevision: 1,
      })
    ).rejects.toThrow(BrainRevisionConflictError);

    const refreshed = await store.getList(REPO, "job-state", "backlog");
    expect(refreshed!.revision).toBeGreaterThan(1);
  });

  it("rejects expectedRevision on non-existent list", async () => {
    await expect(
      store.pushListItems(REPO, AGENT, {
        collection: "job-state",
        name: "missing",
        items: [{ id: "x" }],
        expectedRevision: 1,
      })
    ).rejects.toThrow(BrainListNotFoundError);
  });

  it("errors when removing or setting a missing item", async () => {
    await expect(
      store.removeListItem(REPO, AGENT, {
        collection: "job-state",
        name: "backlog",
        index: 8,
      })
    ).rejects.toThrow(BrainListItemNotFoundError);

    await expect(
      store.setListItem(REPO, AGENT, {
        collection: "job-state",
        name: "backlog",
        index: 8,
        value: { nope: true },
        expectedRevision: (await store.getList(REPO, "job-state", "backlog"))!
          .revision,
      })
    ).rejects.toThrow(BrainListItemNotFoundError);
  });

  it("requires expectedRevision for list item updates", async () => {
    await expect(
      store.setListItem(REPO, AGENT, {
        collection: "job-state",
        name: "backlog",
        index: 0,
        value: { nope: true },
      })
    ).rejects.toThrow(BrainValidationError);
  });

  it("deletes a list and its items", async () => {
    const deleted = await store.deleteList(REPO, "job-state", "backlog");
    expect(deleted).toBe(true);

    expect(await store.getList(REPO, "job-state", "backlog")).toBeNull();
    expect(
      await store.getListItems(REPO, {
        collection: "job-state",
        name: "backlog",
      })
    ).toEqual({ items: [], totalCount: 0, revision: 0 });
  });

  it("returns false when deleting a missing list", async () => {
    const deleted = await store.deleteList(REPO, "job-state", "backlog");
    expect(deleted).toBe(false);
  });

  it("isolates lists by repo", async () => {
    await store.pushListItems(REPO, AGENT, {
      collection: "job-state",
      name: "backlog",
      items: [{ id: "local" }],
    });
    await store.pushListItems(REPO_B, AGENT, {
      collection: "job-state",
      name: "backlog",
      items: [{ id: "other" }],
    });

    const fromA = await store.getListItems(REPO, {
      collection: "job-state",
      name: "backlog",
    });
    const fromB = await store.getListItems(REPO_B, {
      collection: "job-state",
      name: "backlog",
    });

    expect(fromA.items.map((item) => item.value)).toEqual([{ id: "local" }]);
    expect(fromB.items.map((item) => item.value)).toEqual([{ id: "other" }]);
  });
});
