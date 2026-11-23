import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

  it("refuses a worktree folder that does not exist", async () => {
    const missing = path.join(os.tmpdir(), `absent-drive-${Date.now()}`);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      payload: { worktreeLocation: "directory", worktreeDirectory: missing },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("does not exist");
    const settings = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/agents/settings",
    });
    expect(settings.json().worktreeLocation).not.toBe("directory");
  });

  it("saves an existing worktree folder and keeps it when switching away", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "worktree-folder-"));
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/agents/settings",
        payload: { worktreeLocation: "directory", worktreeDirectory: folder },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        worktreeLocation: "directory",
        worktreeDirectory: folder,
      });
      const back = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/agents/settings",
        payload: { worktreeLocation: "sibling" },
      });
      expect(back.json()).toMatchObject({
        worktreeLocation: "sibling",
        worktreeDirectory: folder,
      });
    } finally {
      await ctx.app.inject({
        method: "POST",
        url: "/api/v1/agents/settings",
        payload: { worktreeLocation: "sibling" },
      });
      await rm(folder, { recursive: true, force: true });
    }
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
  ])("%s requires jobId", async (url) => {
    const res = await ctx.app.inject({
      method: "POST",
      url,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
