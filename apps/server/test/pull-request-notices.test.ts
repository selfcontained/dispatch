import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mapPullRequestChecks } from "../src/agents/pull-request-reader.js";
import { AgentError } from "../src/agents/errors.js";
import { PullRequestRefresher } from "../src/agents/pull-request-refresher.js";
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
    ('archived', 'Archived', '/tmp', 'archived', NULL),
    ('stopped', 'Stopped', '/tmp', 'stopped', NULL)`);
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
          status:
            id === "archived"
              ? "archived"
              : id === "stopped"
                ? "stopped"
                : "running",
        }) as StreamAgent,
      delivery: {
        access: async (id) => {
          if (id === "archived" || id === "stopped")
            throw new AgentError("Agent is not running.", 409);
          return { mode: "live" };
        },
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
    expect(block.author).toEqual({ kind: "system" });
    expect((await service.store.getById(block.id))?.author).toEqual({
      kind: "system",
    });
    expect(block.streamId).toBe("child");
    expect(block.threadId).toBeNull();
    expect(block.toAgentId).toBe("child");
    expect(block.attachments).toEqual([
      { type: "pr", url: current.url, title: current.title },
    ]);
    expect((await service.store.getById(block.id))?.text).toContain(
      "[#1 · PR 1](<https://github.com/a/b/pull/1>)"
    );
    expect(injected).toHaveLength(1);
    expect(injected[0].id).toBe("child");
    expect(injected[0].text).toContain("Open → Merged");
    expect(injected[0].text).toContain("from: Dispatch system");
    expect(injected[0].text).toContain("not user approval or instruction");
    for (const input of [
      { data: {} },
      { text: "rewritten" },
      { attachments: [] },
    ]) {
      await expect(service.update("child", block.id, input)).rejects.toThrow(
        "written by Dispatch"
      );
    }
    expect((await service.store.getById(block.id))?.data).toEqual(block.data);
    expect((await service.store.getById(block.id))?.text).toEqual(block.text);
    const explicit = await service.post("child", {
      text: "My PR",
      attachments: block.attachments,
    });
    const refresher = new PullRequestRefresher({
      pool,
      listAgentIds: async () => ["child"],
      publish: () => {},
      warn: () => {},
      read: async () => current,
    });
    await refresher.refresh();
    expect(refresher.get("child")).toHaveLength(1);
    await service.update("child", explicit.id, { attachments: [] });
    await refresher.refresh();
    expect(refresher.get("child")).toEqual([]);
    // Durable dismissals leave authored blocks and generated provenance intact.
    await service.update("child", explicit.id, {
      attachments: block.attachments,
    });
    await service.post("parent", {
      text: "Shared PR",
      attachments: block.attachments,
    });
    await refresher.dismiss(
      "child",
      "https://github.com/A/B/pull/001#discussion"
    );
    await service.post("child", {
      text: "Reposted PR",
      attachments: block.attachments,
    });
    const restarted = new PullRequestRefresher({
      pool,
      listAgentIds: async () => ["child", "parent"],
      publish: () => {},
      warn: () => {},
      read: async () => current,
    });
    await restarted.refresh();
    expect(restarted.get("child")).toEqual([]);
    expect(restarted.get("parent")).toHaveLength(1);
    expect((await service.store.getById(explicit.id))?.attachments).toEqual(
      block.attachments
    );
    expect((await service.store.getById(block.id))?.data).toEqual(block.data);
    await restarted.stop();
    await refresher.stop();
    // Pause actual StreamService preparation; cancellation is rechecked after
    // access resolves and before any persisted observation or runtime delivery.
    let resumeAccess!: () => void;
    let enteredAccess!: () => void;
    const accessEntered = new Promise<void>((resolve) => {
      enteredAccess = resolve;
    });
    const accessPaused = new Promise<void>((resolve) => {
      resumeAccess = resolve;
    });
    const accessSpy = vi
      .spyOn(service as any, "canDeliver")
      .mockImplementation(async () => {
        enteredAccess();
        await accessPaused;
        return true;
      });
    const beforeNotices = await pool.query(
      "SELECT id FROM blocks WHERE data ? 'pullRequestTransition'"
    );
    let active = true;
    const pendingNotice = service.pullRequestTransition(
      "child",
      previous,
      current,
      async (write) => (active ? write() : undefined)
    );
    await accessEntered;
    active = false;
    resumeAccess();
    expect(await pendingNotice).toBeUndefined();
    accessSpy.mockRestore();
    expect(
      (
        await pool.query(
          "SELECT id FROM blocks WHERE data ? 'pullRequestTransition'"
        )
      ).rows
    ).toEqual(beforeNotices.rows);
    expect(injected).toHaveLength(1);
    const checksCurrent = {
      ...previous,
      ci: mapPullRequestChecks("head", [
        {
          __typename: "CheckRun",
          name: "test",
          status: "COMPLETED",
          conclusion: "FAILURE",
        },
      ]),
    };
    for (const id of ["stopped", "archived", "child"]) {
      const notice = await service.pullRequestChecksChanged(
        id,
        previous,
        checksCurrent,
        async (write) => write()
      );
      expect(notice?.text).toContain("— Failing");
      expect(notice?.toAgentId).toBe(id);
      expect(notice?.author).toEqual({ kind: "system" });
      if (id === "child") {
        expect(notice?.streamId).toBe("child");
        expect(notice?.threadId).toBeNull();
      } else expect(notice?.delivered).toBe(false);
    }
    await service.waitForInFlightDeliveries(1000);
    expect(injected).toHaveLength(2);
    const stopped = await service.pullRequestTransition(
      "stopped",
      previous,
      current
    );
    expect(stopped.delivered).toBe(false);
    const archived = await service.pullRequestTransition(
      "archived",
      previous,
      current
    );
    expect(archived.delivered).toBe(false);
    expect(injected).toHaveLength(2);
    expect(
      (await pool.query("SELECT status FROM agents WHERE id = 'archived'"))
        .rows[0].status
    ).toBe("archived");
  });
});
