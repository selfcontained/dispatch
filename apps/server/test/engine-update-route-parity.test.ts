import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerSystemRoutes } from "../src/routes/system.js";

const mocks = vi.hoisted(() => ({
  statuses: vi.fn(),
  versions: vi.fn(async (rows) => rows),
  updates: vi.fn(async (rows) => rows),
}));
vi.mock("../src/agents/engine-availability.js", async (original) => ({
  ...(await original<typeof import("../src/agents/engine-availability.js")>()),
  engineStatuses: mocks.statuses,
  withEngineVersions: mocks.versions,
}));
vi.mock("../src/agents/engine-updates.js", async (original) => ({
  ...(await original<typeof import("../src/agents/engine-updates.js")>()),
  withEngineUpdates: mocks.updates,
}));

// Origin/main 6ab845b2 system.ts:173–219. No database or host CLI runs.
describe("main engine update HTTP parity", () => {
  async function fixture() {
    const app = Fastify();
    const operation = {
      id: "fixture-update",
      engineId: "codex",
      status: "running",
      phase: "starting",
      message: "Starting verified installation update.",
      output: "",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      retryBlocked: true,
    };
    const read = vi.fn(async () => ({ codex: operation }));
    const start = vi.fn(async () => operation);
    const bins = { claude: "/fixture/claude", codex: "/fixture/codex" };
    mocks.statuses.mockResolvedValue([
      { id: "claude", update: { reason: "manual" } },
      { id: "codex", update: { canUpdate: true } },
    ]);
    await registerSystemRoutes(app, {
      appLog: app.log,
      engineBins: bins,
      engineUpdates: { read, start },
      localEngines: { readModelCatalog: () => ({ models: [], defaults: {} }) },
      canManageEngineUpdates: async () => true,
    } as unknown as Parameters<typeof registerSystemRoutes>[1]);
    return { app, operation, read, start, bins };
  }
  it("keeps canManage/engines and nested operation values", async () => {
    const { app, operation } = await fixture();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/system/engines",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        canManage: true,
        engines: [
          { id: "claude", update: { reason: "manual", operation: null } },
          { id: "codex", update: { canUpdate: true, operation } },
        ],
      });
    } finally {
      await app.close();
    }
  });
  it("returns 202 with only the durable operation envelope", async () => {
    const { app, operation, start, bins } = await fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/system/engines/codex/update",
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ operation });
      expect(start).toHaveBeenCalledExactlyOnceWith("codex", bins);
    } finally {
      await app.close();
    }
  });
  it.each([
    { engine: "unsupported", payload: undefined },
    { engine: "codex", payload: {} },
  ])(
    "rejects invalid request %j without starting",
    async ({ engine, payload }) => {
      const { app, start } = await fixture();
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/system/engines/${engine}/update`,
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: "Provide only a supported engine ID in the URL.",
        });
        expect(start).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );
  it.each([new Error("Fixture ownership reason."), "unknown failure"])(
    "keeps conflict errors for %j",
    async (error) => {
      const { app, start } = await fixture();
      start.mockRejectedValue(error);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/system/engines/codex/update",
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          error: error instanceof Error ? error.message : "Update unavailable.",
        });
      } finally {
        await app.close();
      }
    }
  );
});
