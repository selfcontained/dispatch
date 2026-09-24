/**
 * Schema-validation tests for API routes that accept untyped JSON bodies.
 *
 * These were ported out of the Playwright e2e suite — they only assert
 * `400 + error message`, never touch the browser, and don't depend on
 * end-to-end behavior. Running them here saves ~3-5 s per test versus
 * the Playwright path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

const ctx = useInjectApp({ setupAuth: false });

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM agents");
});

describe("POST /api/v1/agents", () => {
  it("requires cwd as a string", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: { name: "missing-cwd" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/cwd/) });
  });

  it("rejects unknown type", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: { cwd: "/tmp", type: "invalid-type" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/type/) });
  });

  it("rejects an engine named as agentType instead of launching the default", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: { cwd: "/tmp", agentType: "codex", useWorktree: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("agentType"),
    });
    const agents = await ctx.pool.query("SELECT id FROM agents");
    expect(agents.rows).toHaveLength(0);
  });

  it("rejects non-string baseBranch", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: { cwd: "/tmp", baseBranch: 123, useWorktree: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("baseBranch"),
    });
  });

  it("rejects non-boolean useWorktree", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: { cwd: "/tmp", useWorktree: "not-a-boolean" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("useWorktree"),
    });
  });

  it("rejects oversized initialPrompt", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: {
        name: `unit-${Date.now()}`,
        cwd: "/tmp",
        useWorktree: false,
        initialPrompt: "x".repeat(16_001),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "initialPrompt must be at most 16000 characters when provided.",
    });
  });

  it("rejects multipart startup links that aren't valid http/https URLs", async () => {
    const boundary = "----dispatch-test-boundary";
    const parts = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="name"',
      "",
      `unit-${Date.now()}`,
      `--${boundary}`,
      'Content-Disposition: form-data; name="cwd"',
      "",
      "/tmp",
      `--${boundary}`,
      'Content-Disposition: form-data; name="useWorktree"',
      "",
      "false",
      `--${boundary}`,
      'Content-Disposition: form-data; name="startupLinks"',
      "",
      JSON.stringify(["github.com/selfcontained/dispatch"]),
      `--${boundary}--`,
      "",
    ];
    const body = parts.join("\r\n");

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error:
        "Startup link is not a valid URL: github.com/selfcontained/dispatch",
    });
  });
});

describe("POST /api/v1/agents/settings", () => {
  it("rejects an invalid worktree location", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      payload: { worktreeLocation: "invalid" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/notifications/settings", () => {
  it("rejects non-boolean webNotifyEnabled", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      payload: { webNotifyEnabled: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-array webNotifyEvents", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      payload: { webNotifyEvents: "done" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/notifications/ack", () => {
  it("rejects missing notificationId", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/ack",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-string notificationId", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/ack",
      payload: { notificationId: 123 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/focus", () => {
  it("rejects empty-string agentId", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/focus",
      payload: { agentId: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/jobs/{run,enable,disable}", () => {
  it.each([
    ["/api/v1/jobs/run"],
    ["/api/v1/jobs/enable"],
    ["/api/v1/jobs/disable"],
  ])("%s requires name and directory", async (url) => {
    const res = await ctx.app.inject({
      method: "POST",
      url,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
