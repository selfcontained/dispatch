import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";
import { BrainStore } from "../src/brain/store.js";

const REPO_ROOT = "/tmp/brain-route-test";

const ctx = useInjectApp();

async function authedInject(
  method: string,
  url: string
): Promise<ReturnType<typeof ctx.app.inject>> {
  const cookie = await ctx.sessionCookie();
  return ctx.app.inject({
    method: method as "GET",
    url,
    headers: { cookie },
  });
}

let brainStore: BrainStore;

beforeEach(async () => {
  brainStore = new BrainStore(ctx.pool);
  await ctx.pool.query("DELETE FROM brain_events");
  await ctx.pool.query("DELETE FROM brain_list_items");
  await ctx.pool.query("DELETE FROM brain_lists");
  await ctx.pool.query("DELETE FROM brain_objects");
});

describe("GET /api/v1/brain/projects", () => {
  it("returns empty array with no data", async () => {
    const res = await authedInject("GET", "/api/v1/brain/projects");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns project summaries after seeding data", async () => {
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "col-a",
      name: "obj-1",
      value: { x: 1 },
    });
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "col-a",
      kind: "run",
      value: { done: true },
    });

    const res = await authedInject("GET", "/api/v1/brain/projects");
    expect(res.statusCode).toBe(200);
    const projects = res.json();
    expect(projects).toHaveLength(1);
    expect(projects[0].repoRoot).toBe(REPO_ROOT);
    expect(projects[0].objectCount).toBe(1);
    expect(projects[0].eventCount).toBe(1);
  });
});

describe("DELETE /api/v1/brain/projects", () => {
  it("deletes every collection and entry type for one project", async () => {
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "one",
      name: "object",
      value: {},
    });
    await brainStore.pushListItems(REPO_ROOT, "agt_test", {
      collection: "two",
      name: "list",
      items: [{ value: 1 }],
    });
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "two",
      kind: "event",
      value: {},
    });

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/projects?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ objects: 1, lists: 1, events: 1 });
    expect(await brainStore.listProjects()).toEqual([]);
  });
});

describe("GET /api/v1/brain/collections", () => {
  it("returns 400 without repoRoot", async () => {
    const res = await authedInject("GET", "/api/v1/brain/collections");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("repoRoot");
  });

  it("returns empty array for unknown repoRoot", async () => {
    const res = await authedInject(
      "GET",
      `/api/v1/brain/collections?repoRoot=/tmp/nonexistent`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns collection summaries", async () => {
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "metrics",
      name: "cpu",
      value: { avg: 42 },
    });
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "metrics",
      name: "mem",
      value: { avg: 80 },
    });
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "config",
      name: "app",
      value: { debug: true },
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/collections?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    const collections = res.json();
    expect(collections).toHaveLength(2);
    const metrics = collections.find(
      (c: { collection: string }) => c.collection === "metrics"
    );
    expect(metrics.objectCount).toBe(2);
  });
});

describe("GET /api/v1/brain/objects", () => {
  it("returns 400 without repoRoot", async () => {
    const res = await authedInject("GET", "/api/v1/brain/objects");
    expect(res.statusCode).toBe(400);
  });

  it("returns empty array when no objects exist", async () => {
    const res = await authedInject(
      "GET",
      `/api/v1/brain/objects?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns all objects for a repoRoot", async () => {
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "data",
      name: "alpha",
      value: { v: 1 },
    });
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "data",
      name: "beta",
      value: { v: 2 },
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/objects?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });

  it("filters by collection", async () => {
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "keep",
      name: "a",
      value: {},
    });
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "skip",
      name: "b",
      value: {},
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/objects?repoRoot=${encodeURIComponent(REPO_ROOT)}&collection=keep`
    );
    expect(res.statusCode).toBe(200);
    const objects = res.json();
    expect(objects).toHaveLength(1);
    expect(objects[0].collection).toBe("keep");
  });

  it("filters by prefix", async () => {
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "data",
      name: "state-v1",
      value: {},
    });
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "data",
      name: "config-v1",
      value: {},
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/objects?repoRoot=${encodeURIComponent(REPO_ROOT)}&prefix=state`
    );
    expect(res.statusCode).toBe(200);
    const objects = res.json();
    expect(objects).toHaveLength(1);
    expect(objects[0].name).toBe("state-v1");
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await brainStore.storeObject(REPO_ROOT, "agt_test", {
        collection: "data",
        name: `item-${i}`,
        value: { i },
      });
    }

    const res = await authedInject(
      "GET",
      `/api/v1/brain/objects?repoRoot=${encodeURIComponent(REPO_ROOT)}&limit=2`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });
});

describe("GET /api/v1/brain/objects/:collection/:name", () => {
  it("returns 400 without repoRoot", async () => {
    const res = await authedInject("GET", "/api/v1/brain/objects/col/obj");
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for nonexistent object", async () => {
    const res = await authedInject(
      "GET",
      `/api/v1/brain/objects/missing/obj?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns an existing object", async () => {
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "test-col",
      name: "test-obj",
      value: { hello: "world" },
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/objects/test-col/test-obj?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    const obj = res.json();
    expect(obj.collection).toBe("test-col");
    expect(obj.name).toBe("test-obj");
    expect(obj.value).toEqual({ hello: "world" });
    expect(obj.revision).toBe(1);
  });
});

describe("DELETE /api/v1/brain/objects/:collection/:name", () => {
  it("deletes an object scoped to the requested repo", async () => {
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "config",
      name: "removable",
      value: {},
    });

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/objects/config/removable?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(
      await brainStore.getObject(REPO_ROOT, "config", "removable")
    ).toBeNull();
  });
});

describe("DELETE /api/v1/brain/collections/:collection", () => {
  it("deletes all entry types in a collection only", async () => {
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "purge",
      name: "object",
      value: {},
    });
    await brainStore.pushListItems(REPO_ROOT, "agt_test", {
      collection: "purge",
      name: "list",
      items: [{ value: 1 }],
    });
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "purge",
      kind: "event",
      value: {},
    });
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "keep",
      name: "object",
      value: {},
    });

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/collections/purge?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ objects: 1, lists: 1, events: 1 });
    expect(
      await brainStore.listObjects(REPO_ROOT, { collection: "purge" })
    ).toEqual([]);
    expect(
      await brainStore.getObject(REPO_ROOT, "keep", "object")
    ).not.toBeNull();
  });
});

describe("DELETE /api/v1/brain/:entryType (bulk by type)", () => {
  const OTHER_REPO = "/tmp/brain-route-test-other";

  async function seedBothCollections(repoRoot: string): Promise<void> {
    for (const collection of ["alpha", "beta"]) {
      await brainStore.storeObject(repoRoot, "agt_test", {
        collection,
        name: "object",
        value: {},
      });
      await brainStore.pushListItems(repoRoot, "agt_test", {
        collection,
        name: "list",
        items: [{ value: 1 }],
      });
      await brainStore.appendEvent(repoRoot, "agt_test", {
        collection,
        kind: "event",
        value: {},
      });
    }
  }

  it("returns 400 without repoRoot", async () => {
    const res = await authedInject(
      "DELETE",
      "/api/v1/brain/events?collection=alpha"
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("repoRoot");
  });

  it("returns 400 when neither collection nor allCollections is given", async () => {
    await seedBothCollections(REPO_ROOT);

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("collection is required");
    expect(await brainStore.queryEvents(REPO_ROOT)).toHaveLength(2);
  });

  it("returns 400 when both collection and allCollections are given", async () => {
    await seedBothCollections(REPO_ROOT);

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}&collection=alpha&allCollections=true`
    );
    expect(res.statusCode).toBe(400);
    expect(await brainStore.queryEvents(REPO_ROOT)).toHaveLength(2);
  });

  it("returns 400 for a blank collection instead of widening the delete", async () => {
    await seedBothCollections(REPO_ROOT);

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}&collection=%20%20`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("blank");
    expect(await brainStore.queryEvents(REPO_ROOT)).toHaveLength(2);
  });

  it("returns 400 when a query key is repeated into an array", async () => {
    await seedBothCollections(REPO_ROOT);

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}&collection=alpha&collection=beta`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("single value");
    expect(await brainStore.queryEvents(REPO_ROOT)).toHaveLength(2);
  });

  it("returns 400 when allCollections is repeated", async () => {
    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/lists?repoRoot=${encodeURIComponent(REPO_ROOT)}&allCollections=true&allCollections=true`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("single value");
  });

  it("rejects every malformed selector with a 4xx, never a 500", async () => {
    const malformed = [
      "",
      "&collection=%20",
      "&collection=a&collection=b",
      "&collection=a&allCollections=true",
      "&allCollections=1",
      "&allCollections=true&allCollections=false",
    ];
    for (const suffix of malformed) {
      const res = await authedInject(
        "DELETE",
        `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}${suffix}`
      );
      expect(res.statusCode, `selector "${suffix}"`).toBe(400);
    }
  });

  it("deletes one entry type in one collection, leaving the rest", async () => {
    await seedBothCollections(REPO_ROOT);

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}&collection=alpha`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 1 });

    expect(
      await brainStore.queryEvents(REPO_ROOT, { collection: "alpha" })
    ).toEqual([]);
    expect(
      await brainStore.queryEvents(REPO_ROOT, { collection: "beta" })
    ).toHaveLength(1);
    // Sibling types in the same collection survive.
    expect(
      await brainStore.getObject(REPO_ROOT, "alpha", "object")
    ).not.toBeNull();
    expect(await brainStore.getList(REPO_ROOT, "alpha", "list")).not.toBeNull();
  });

  it("deletes one entry type across every collection with allCollections", async () => {
    await seedBothCollections(REPO_ROOT);

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/objects?repoRoot=${encodeURIComponent(REPO_ROOT)}&allCollections=true`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });

    expect(await brainStore.listObjects(REPO_ROOT)).toEqual([]);
    expect(await brainStore.listLists(REPO_ROOT)).toHaveLength(2);
    expect(await brainStore.queryEvents(REPO_ROOT)).toHaveLength(2);
  });

  it("takes list items with the lists it deletes", async () => {
    await seedBothCollections(REPO_ROOT);

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/lists?repoRoot=${encodeURIComponent(REPO_ROOT)}&collection=alpha`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 1 });

    const items = await brainStore.getListItems(REPO_ROOT, {
      collection: "alpha",
      name: "list",
    });
    expect(items.totalCount).toBe(0);
    const remaining = await ctx.pool.query(
      "SELECT 1 FROM brain_list_items WHERE repo_root = $1 AND collection = $2",
      [REPO_ROOT, "alpha"]
    );
    expect(remaining.rowCount).toBe(0);
  });

  it("never crosses into another repo, even with allCollections", async () => {
    await seedBothCollections(REPO_ROOT);
    await seedBothCollections(OTHER_REPO);

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}&allCollections=true`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });
    expect(await brainStore.queryEvents(OTHER_REPO)).toHaveLength(2);
  });

  it("reports zero when the scope is already empty", async () => {
    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/objects?repoRoot=${encodeURIComponent(REPO_ROOT)}&collection=missing`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 0 });
  });
});

describe("DELETE /api/v1/brain/collections/:collection blank guard", () => {
  it("answers 400, not 500, for a blank collection path segment", async () => {
    await brainStore.storeObject(REPO_ROOT, "agt_test", {
      collection: "keep",
      name: "object",
      value: {},
    });

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/collections/%20?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("blank");
    expect(
      await brainStore.getObject(REPO_ROOT, "keep", "object")
    ).not.toBeNull();
  });
});

describe("GET /api/v1/brain/lists", () => {
  it("returns 400 without repoRoot", async () => {
    const res = await authedInject("GET", "/api/v1/brain/lists");
    expect(res.statusCode).toBe(400);
  });

  it("returns empty when no lists exist", async () => {
    const res = await authedInject(
      "GET",
      `/api/v1/brain/lists?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns list metadata after pushing items", async () => {
    await brainStore.pushListItems(REPO_ROOT, "agt_test", {
      collection: "logs",
      name: "errors",
      items: [{ msg: "oops" }],
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/lists?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    const lists = res.json();
    expect(lists).toHaveLength(1);
    expect(lists[0].collection).toBe("logs");
    expect(lists[0].name).toBe("errors");
  });

  it("filters by collection", async () => {
    await brainStore.pushListItems(REPO_ROOT, "agt_test", {
      collection: "col-a",
      name: "list-1",
      items: [{ x: 1 }],
    });
    await brainStore.pushListItems(REPO_ROOT, "agt_test", {
      collection: "col-b",
      name: "list-2",
      items: [{ x: 2 }],
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/lists?repoRoot=${encodeURIComponent(REPO_ROOT)}&collection=col-a`
    );
    expect(res.statusCode).toBe(200);
    const lists = res.json();
    expect(lists).toHaveLength(1);
    expect(lists[0].collection).toBe("col-a");
  });
});

describe("GET /api/v1/brain/lists/:collection/:name", () => {
  it("returns 400 without repoRoot", async () => {
    const res = await authedInject("GET", "/api/v1/brain/lists/col/name");
    expect(res.statusCode).toBe(400);
  });

  it("returns empty result for nonexistent list", async () => {
    const res = await authedInject(
      "GET",
      `/api/v1/brain/lists/missing/list?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.totalCount).toBe(0);
  });

  it("returns list items in default order", async () => {
    await brainStore.pushListItems(REPO_ROOT, "agt_test", {
      collection: "queue",
      name: "tasks",
      items: [{ task: "first" }, { task: "second" }, { task: "third" }],
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/lists/queue/tasks?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(3);
    expect(body.totalCount).toBe(3);
    expect(body.revision).toBeGreaterThan(0);
  });

  it("respects limit, offset, and order parameters", async () => {
    await brainStore.pushListItems(REPO_ROOT, "agt_test", {
      collection: "queue",
      name: "paginated",
      items: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }],
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/lists/queue/paginated?repoRoot=${encodeURIComponent(REPO_ROOT)}&limit=2&offset=1&order=asc`
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].value).toEqual({ i: 1 });
    expect(body.items[1].value).toEqual({ i: 2 });
    expect(body.totalCount).toBe(5);
  });
});

describe("DELETE /api/v1/brain/lists/:collection/:name", () => {
  it("deletes a list and its items", async () => {
    await brainStore.pushListItems(REPO_ROOT, "agt_test", {
      collection: "queue",
      name: "removable",
      items: [{ task: "clean" }],
    });

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/lists/queue/removable?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(
      await brainStore.getList(REPO_ROOT, "queue", "removable")
    ).toBeNull();
  });
});

describe("GET /api/v1/brain/events", () => {
  it("returns 400 without repoRoot", async () => {
    const res = await authedInject("GET", "/api/v1/brain/events");
    expect(res.statusCode).toBe(400);
  });

  it("returns empty array when no events exist", async () => {
    const res = await authedInject(
      "GET",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns events after seeding", async () => {
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "ci",
      kind: "build",
      value: { status: "pass" },
      subject: "main",
    });
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "ci",
      kind: "deploy",
      value: { env: "staging" },
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });

  it("filters by collection and kind", async () => {
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "ci",
      kind: "build",
      value: { n: 1 },
    });
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "ci",
      kind: "deploy",
      value: { n: 2 },
    });
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "other",
      kind: "build",
      value: { n: 3 },
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}&collection=ci&kind=build`
    );
    expect(res.statusCode).toBe(200);
    const events = res.json();
    expect(events).toHaveLength(1);
    expect(events[0].value).toEqual({ n: 1 });
  });

  it("filters by subject", async () => {
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "ci",
      kind: "build",
      value: {},
      subject: "feature-branch",
    });
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "ci",
      kind: "build",
      value: {},
      subject: "main",
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}&subject=main`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("filters by tags", async () => {
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "ci",
      kind: "build",
      value: {},
      tags: ["fast", "green"],
    });
    await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "ci",
      kind: "build",
      value: {},
      tags: ["slow"],
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}&tags=fast`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await brainStore.appendEvent(REPO_ROOT, "agt_test", {
        collection: "ci",
        kind: "build",
        value: { i },
      });
    }

    const res = await authedInject(
      "GET",
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}&limit=2`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });
});

describe("DELETE /api/v1/brain/events/:id", () => {
  it("deletes an event scoped to the requested repo", async () => {
    const event = await brainStore.appendEvent(REPO_ROOT, "agt_test", {
      collection: "ci",
      kind: "removable",
      value: {},
    });

    const res = await authedInject(
      "DELETE",
      `/api/v1/brain/events/${event.id}?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(await brainStore.queryEvents(REPO_ROOT)).toEqual([]);
  });
});

describe("GET /api/v1/brain/agent-activity/:agentId", () => {
  it("returns 400 without repoRoot", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/brain/agent-activity/agt_test"
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns empty activity for unknown agent", async () => {
    const res = await authedInject(
      "GET",
      `/api/v1/brain/agent-activity/agt_unknown?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.objects).toEqual([]);
    expect(body.lists).toEqual([]);
    expect(body.events).toEqual([]);
  });

  it("returns objects, lists, and events for a specific agent", async () => {
    await brainStore.storeObject(REPO_ROOT, "agt_active", {
      collection: "data",
      name: "state",
      value: { foo: "bar" },
    });
    await brainStore.pushListItems(REPO_ROOT, "agt_active", {
      collection: "data",
      name: "log",
      items: [{ msg: "hello" }],
    });
    await brainStore.appendEvent(REPO_ROOT, "agt_active", {
      collection: "data",
      kind: "run",
      value: { done: true },
    });

    // Seed data from a different agent to verify filtering
    await brainStore.storeObject(REPO_ROOT, "agt_other", {
      collection: "data",
      name: "other-state",
      value: {},
    });

    const res = await authedInject(
      "GET",
      `/api/v1/brain/agent-activity/agt_active?repoRoot=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.objects).toHaveLength(1);
    expect(body.objects[0].name).toBe("state");
    expect(body.lists).toHaveLength(1);
    expect(body.lists[0].name).toBe("log");
    expect(body.events).toHaveLength(1);
    expect(body.events[0].kind).toBe("run");
  });
});
