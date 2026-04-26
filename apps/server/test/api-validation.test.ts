/**
 * Schema-validation tests for API routes that accept untyped JSON bodies.
 *
 * These were ported out of the Playwright e2e suite — they only assert
 * `400 + error message`, never touch the browser, and don't depend on
 * end-to-end behavior. Running them here saves ~3-5 s per test versus
 * the Playwright path.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  setupTestDb,
  teardownTestDb,
  runTestMigrations,
  getTestDatabaseUrl,
} from "./db/setup.js";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

let pool: Pool;
let app: FastifyInstance;

const uncaughtExceptionFilter = (err: Error): void => {
  if (
    err instanceof TypeError &&
    err.message.includes("destroySoon is not a function")
  ) {
    return;
  }
  throw err;
};

beforeAll(async () => {
  process.prependListener("uncaughtException", uncaughtExceptionFilter);

  pool = await setupTestDb();
  await runTestMigrations();

  process.env.DATABASE_URL = getTestDatabaseUrl();
  process.env.DISPATCH_AGENT_RUNTIME = "inert";
  process.env.DISPATCH_PORT = "6771";
  process.env.DISPATCH_HOST = "127.0.0.1";

  const serverModule = await import("../src/server.js");
  app = await serverModule.initializeApp({
    runMigrations: false,
    reconcileState: false,
  });
  // No password is set in the test DB → the auth gate is open, matching
  // the e2e environment.
});

afterAll(async () => {
  const serverModule = await import("../src/server.js");
  await serverModule.closeApp();
  delete process.env.DISPATCH_AGENT_RUNTIME;
  delete process.env.DATABASE_URL;
  delete process.env.DISPATCH_PORT;
  delete process.env.DISPATCH_HOST;
  await teardownTestDb();
  await new Promise((resolve) => setTimeout(resolve, 600));
  process.off("uncaughtException", uncaughtExceptionFilter);
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_events");
  await pool.query("DELETE FROM agents");
});

describe("POST /api/v1/agents", () => {
  it("requires cwd as a string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: { name: "missing-cwd" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/cwd/) });
  });

  it("rejects unknown type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: { cwd: "/tmp", type: "invalid-type" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/type/) });
  });

  it("rejects non-string baseBranch", async () => {
    const res = await app.inject({
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
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: { cwd: "/tmp", useWorktree: "not-a-boolean" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("useWorktree"),
    });
  });

  it("rejects non-boolean autoReview", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: {
        name: `unit-${Date.now()}`,
        cwd: "/tmp",
        useWorktree: false,
        autoReview: "true",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "autoReview must be a boolean when provided.",
    });
  });

  it("rejects oversized initialPrompt", async () => {
    const res = await app.inject({
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
    // Reproduce the e2e test's multipart shape with a hand-rolled form-data body.
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

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "URL pins must be valid http or https URLs.",
    });
  });

  it("rejects unknown agent type with a message that mentions terminal", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: { type: "not-a-real-type", cwd: "/tmp", useWorktree: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("terminal"),
    });
  });
});

describe("POST /api/v1/agents/settings", () => {
  it("rejects an invalid worktree location", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      payload: { worktreeLocation: "invalid" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/notifications/settings", () => {
  it("rejects non-boolean webNotifyEnabled", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      payload: { webNotifyEnabled: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-array webNotifyEvents", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      payload: { webNotifyEvents: "done" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/notifications/ack", () => {
  it("rejects missing notificationId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/ack",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-string notificationId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/ack",
      payload: { notificationId: 123 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/focus", () => {
  it("rejects empty-string agentId", async () => {
    const res = await app.inject({
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
    const res = await app.inject({
      method: "POST",
      url,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
