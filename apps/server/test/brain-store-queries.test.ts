import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";

import { BrainStore } from "../src/brain/store.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let pool: Pool;
let store: BrainStore;

const REPO = "/repo/query-test";
const REPO_B = "/repo/query-other";
const AGENT_A = "agt_query_a";
const AGENT_B = "agt_query_b";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new BrainStore(pool);

  await store.storeObject(REPO, AGENT_A, {
    collection: "config",
    name: "settings",
    value: { theme: "dark" },
  });
  await store.storeObject(REPO, AGENT_B, {
    collection: "config",
    name: "flags",
    value: { beta: true },
  });
  await store.storeObject(REPO, AGENT_A, {
    collection: "state",
    name: "cursor",
    value: { pos: 42 },
  });

  await store.pushListItems(REPO, AGENT_A, {
    collection: "state",
    name: "backlog",
    items: [{ id: "a" }, { id: "b" }, { id: "c" }],
  });
  await store.pushListItems(REPO, AGENT_B, {
    collection: "config",
    name: "queue",
    items: [{ x: 1 }],
  });

  await store.appendEvent(REPO, AGENT_A, {
    collection: "reviews",
    kind: "assessment",
    value: { score: 0.8 },
    subject: "ux",
    tags: ["noise"],
  });
  await store.appendEvent(REPO, AGENT_A, {
    collection: "reviews",
    kind: "decision",
    value: { action: "approve" },
  });
  await store.appendEvent(REPO, AGENT_B, {
    collection: "config",
    kind: "change",
    value: { key: "flags" },
  });

  await store.storeObject(REPO_B, AGENT_A, {
    collection: "config",
    name: "other-repo-obj",
    value: { isolated: true },
  });
});

afterAll(async () => {
  await teardownTestDb();
});

describe("BrainStore.listProjects", () => {
  it("returns projects with counts", async () => {
    const projects = await store.listProjects();
    const project = projects.find((p) => p.repoRoot === REPO);
    expect(project).toBeDefined();
    expect(project!.objectCount).toBe(3);
    expect(project!.listCount).toBe(2);
    expect(project!.eventCount).toBe(3);
  });

  it("includes all repos with brain data", async () => {
    const projects = await store.listProjects();
    const roots = projects.map((p) => p.repoRoot);
    expect(roots).toContain(REPO);
    expect(roots).toContain(REPO_B);
  });
});

describe("BrainStore.listCollections", () => {
  it("returns collection summaries for a repo", async () => {
    const collections = await store.listCollections(REPO);
    expect(collections.length).toBeGreaterThanOrEqual(3);

    const config = collections.find((c) => c.collection === "config");
    expect(config).toBeDefined();
    expect(config!.objectCount).toBe(2);
    expect(config!.listCount).toBe(1);
    expect(config!.eventCount).toBe(1);

    const state = collections.find((c) => c.collection === "state");
    expect(state).toBeDefined();
    expect(state!.objectCount).toBe(1);
    expect(state!.listCount).toBe(1);
    expect(state!.eventCount).toBe(0);

    const reviews = collections.find((c) => c.collection === "reviews");
    expect(reviews).toBeDefined();
    expect(reviews!.objectCount).toBe(0);
    expect(reviews!.listCount).toBe(0);
    expect(reviews!.eventCount).toBe(2);
  });

  it("isolates by repo", async () => {
    const collections = await store.listCollections(REPO_B);
    expect(collections).toHaveLength(1);
    expect(collections[0].collection).toBe("config");
    expect(collections[0].objectCount).toBe(1);
  });
});

describe("BrainStore.listLists", () => {
  it("returns lists with item counts", async () => {
    const lists = await store.listLists(REPO);
    expect(lists).toHaveLength(2);

    const backlog = lists.find((l) => l.name === "backlog");
    expect(backlog).toBeDefined();
    expect(backlog!.itemCount).toBe(3);
    expect(backlog!.collection).toBe("state");

    const queue = lists.find((l) => l.name === "queue");
    expect(queue).toBeDefined();
    expect(queue!.itemCount).toBe(1);
  });

  it("filters by collection", async () => {
    const lists = await store.listLists(REPO, { collection: "state" });
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe("backlog");
  });

  it("respects limit", async () => {
    const lists = await store.listLists(REPO, { limit: 1 });
    expect(lists).toHaveLength(1);
  });
});

describe("BrainStore.getAgentBrainActivity", () => {
  it("returns objects, lists, and events for a specific agent", async () => {
    const activity = await store.getAgentBrainActivity(REPO, AGENT_A);

    expect(activity.objects.length).toBe(2);
    expect(activity.objects.map((o) => o.name).sort()).toEqual([
      "cursor",
      "settings",
    ]);

    expect(activity.lists.length).toBe(1);
    expect(activity.lists[0].name).toBe("backlog");
    expect((activity.lists[0] as { itemCount: number }).itemCount).toBe(3);

    expect(activity.events.length).toBe(2);
    expect(activity.events.map((e) => e.kind).sort()).toEqual([
      "assessment",
      "decision",
    ]);
  });

  it("isolates by agent", async () => {
    const activity = await store.getAgentBrainActivity(REPO, AGENT_B);

    expect(activity.objects.length).toBe(1);
    expect(activity.objects[0].name).toBe("flags");

    expect(activity.lists.length).toBe(1);
    expect(activity.lists[0].name).toBe("queue");

    expect(activity.events.length).toBe(1);
    expect(activity.events[0].kind).toBe("change");
  });

  it("returns empty for unknown agent", async () => {
    const activity = await store.getAgentBrainActivity(REPO, "agt_unknown");
    expect(activity.objects).toHaveLength(0);
    expect(activity.lists).toHaveLength(0);
    expect(activity.events).toHaveLength(0);
  });

  it("respects limit", async () => {
    const activity = await store.getAgentBrainActivity(REPO, AGENT_A, 1);
    expect(activity.objects.length).toBeLessThanOrEqual(1);
    expect(activity.lists.length).toBeLessThanOrEqual(1);
    expect(activity.events.length).toBeLessThanOrEqual(1);
  });
});
