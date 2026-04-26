import { test, expect, request as pwRequest } from "@playwright/test";
import { writeFile, unlink } from "node:fs/promises";

const STORE_PATH =
  process.env.DISPATCH_ASSISTED_UPDATE_STORE_PATH ??
  "/tmp/dispatch-assisted-e2e-fallback.json";

const partiallyCompletedState = {
  tag: "v0.19.0",
  fromTag: "v0.18.1",
  metadata: {
    mode: "required",
    title: "Bun runtime migration",
    summary: "Resumability test fixture.",
    requiredChecks: ["service_entrypoint", "version_converged"],
  },
  requiredChecks: ["service_entrypoint", "version_converged"],
  phase: "apply",
  token: "fixture-token-resume",
  agentId: "agt_resume000000",
  startedAt: "2026-04-26T05:00:00.000Z",
  updatedAt: "2026-04-26T05:00:30.000Z",
  completedAt: null,
  error: null,
  checks: [],
  notes: {
    inspect: "fresh install, server-dir present",
    prepare: "snapshotted current install",
  },
};

test.describe("Release assisted-update resumability", () => {
  test.afterEach(async () => {
    await unlink(STORE_PATH).catch(() => {});
  });

  test("GET /assisted/state surfaces the persisted record after a crash", async () => {
    // Simulate the agent crashing mid-run by writing the state file
    // directly without going through the launch endpoint.
    await writeFile(
      STORE_PATH,
      JSON.stringify(partiallyCompletedState, null, 2),
      "utf-8"
    );

    const ctx = await pwRequest.newContext({
      baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? "3001"}`,
    });
    const res = await ctx.get("/api/v1/release/update/assisted/state");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      state: typeof partiallyCompletedState;
    };
    expect(body.state.phase).toBe("apply");
    expect(body.state.tag).toBe("v0.19.0");
    expect(body.state.notes.prepare).toBe("snapshotted current install");
    await ctx.dispose();
  });

  test("DELETE /assisted/state clears the file (operator-initiated cleanup)", async () => {
    await writeFile(
      STORE_PATH,
      JSON.stringify(partiallyCompletedState, null, 2),
      "utf-8"
    );

    const ctx = await pwRequest.newContext({
      baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? "3001"}`,
    });
    const del = await ctx.delete("/api/v1/release/update/assisted/state");
    expect(del.status()).toBe(200);

    const after = await ctx.get("/api/v1/release/update/assisted/state");
    expect(after.status()).toBe(200);
    const body = (await after.json()) as { state: unknown };
    expect(body.state).toBeNull();
    await ctx.dispose();
  });

  test("returns null when no assisted update has ever run", async () => {
    // afterEach already removed the file from prior tests.
    const ctx = await pwRequest.newContext({
      baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? "3001"}`,
    });
    const res = await ctx.get("/api/v1/release/update/assisted/state");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { state: unknown };
    expect(body.state).toBeNull();
    await ctx.dispose();
  });
});
