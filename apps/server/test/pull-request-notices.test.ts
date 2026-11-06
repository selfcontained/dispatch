import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { StreamService, type StreamAgent } from "../src/chat/service.js";
import { setupTestDb, runTestMigrations, teardownTestDb } from "./db/setup.js";

let pool: Pool;
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(`INSERT INTO agents (id, name, cwd, status, parent_agent_id) VALUES
    ('parent', 'Parent', '/tmp', 'running', NULL),
    ('child', 'Child', '/tmp', 'running', 'parent'),
    ('archived', 'Archived', '/tmp', 'archived', NULL)`);
});
afterAll(() => teardownTestDb());
describe("PR observation delivery", () => {
  it("persists in a child's home and addresses only that child; archived owners remain inert", async () => {
    const injected: Array<{ id: string; text: string }> = [];
    const service = new StreamService({
      pool,
      filesRoot: "/tmp",
      publishUiEvent: () => {},
      getAgent: async (id) =>
        ({
          id,
          name: id,
          filesDir: null,
          status: id === "archived" ? "archived" : "running",
        }) as StreamAgent,
      delivery: {
        access: async (id) =>
          id === "archived"
            ? { mode: "inert", message: "Archived" }
            : { mode: "live" },
        inject: async (id, text) => {
          injected.push({ id, text });
        },
        held: () => false,
        activeTurn: () => false,
      },
    });
    const previous = {
      url: "https://github.com/a/b/pull/1",
      title: "PR 1",
      status: "Open" as const,
    };
    const current = { ...previous, status: "Merged" as const };
    const block = await service.pullRequestTransition(
      "child",
      previous,
      current
    );
    await service.waitForInFlightDeliveries(1000);
    expect(block.streamId).toBe("parent");
    expect(block.threadId).toBeTruthy();
    expect(block.toAgentId).toBe("child");
    expect(block.attachments).toEqual([
      { type: "pr", url: current.url, title: current.title },
    ]);
    expect((await service.store.getById(block.id))?.text).toContain(
      "Dispatch system:"
    );
    expect(injected).toHaveLength(1);
    expect(injected[0].id).toBe("child");
    expect(injected[0].text).toContain("Open → Merged");
    const archived = await service.pullRequestTransition(
      "archived",
      previous,
      current
    );
    expect(archived.delivered).toBe(false);
    expect(injected).toHaveLength(1);
    expect(
      (await pool.query("SELECT status FROM agents WHERE id = 'archived'"))
        .rows[0].status
    ).toBe("archived");
  });
});
