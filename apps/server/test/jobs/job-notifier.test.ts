import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { JobNotifier } from "../../src/notifications/job-notifier.js";
import type { JobRunRecord } from "../../src/jobs/store.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "../db/setup.js";
import { setSetting } from "../../src/db/settings.js";

let pool: Pool;
let notifier: JobNotifier;
let fetchSpy: ReturnType<typeof vi.fn>;

const fakeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => fakeLogger,
  level: "info",
  silent: vi.fn(),
} as unknown as import("fastify").FastifyBaseLogger;

function makeRun(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    id: "run-1",
    jobId: "job-1",
    agentId: "agent-1",
    status: "completed",
    report: { status: "completed", summary: "All done", tasks: [] },
    config: {
      directory: "/tmp/repo",
      filePath: "/tmp/repo/.dispatch/jobs/test.md",
      name: "test-job",
      schedule: "0 * * * *",
      timeoutMs: 60_000,
      needsInputTimeoutMs: 86_400_000,
      notify: { onComplete: ["slack"], onError: ["slack"], onNeedsInput: [] },
    },
    pendingQuestion: null,
    startedAt: new Date().toISOString(),
    statusUpdatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 5_000,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  notifier = new JobNotifier(pool, fakeLogger);
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "ok" });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("JobNotifier", () => {
  it("sends Slack notification on completed run with on_complete: [slack]", async () => {
    await setSetting(pool, "slack_webhook_url", "https://hooks.slack.test/test");
    await notifier.onJobRunStateChange(makeRun());

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://hooks.slack.test/test");
    const body = JSON.parse(opts.body);
    expect(body.username).toBe("Dispatch Jobs");
    expect(body.attachments[0].color).toBe("#22c55e");
    expect(body.attachments[0].fallback).toContain("test-job");
  });

  it("sends Slack notification on failed run with on_error: [slack]", async () => {
    await setSetting(pool, "slack_webhook_url", "https://hooks.slack.test/test");
    await notifier.onJobRunStateChange(
      makeRun({
        status: "failed",
        report: { status: "failed", summary: "Broke", tasks: [] },
      })
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.attachments[0].color).toBe("#ef4444");
  });

  it("sends Slack notification on needs_input with on_needs_input configured", async () => {
    await setSetting(pool, "slack_webhook_url", "https://hooks.slack.test/test");
    await notifier.onJobRunStateChange(
      makeRun({
        status: "needs_input",
        pendingQuestion: "Should I proceed?",
        config: {
          ...makeRun().config,
          notify: { onComplete: [], onError: [], onNeedsInput: ["slack"] },
        },
      })
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.attachments[0].color).toBe("#f59e0b");
  });

  it("does not send notification when no channels configured for event", async () => {
    await setSetting(pool, "slack_webhook_url", "https://hooks.slack.test/test");
    await notifier.onJobRunStateChange(
      makeRun({
        config: {
          ...makeRun().config,
          notify: { onComplete: [], onError: [], onNeedsInput: [] },
        },
      })
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not send notification when no webhook URL configured", async () => {
    await setSetting(pool, "slack_webhook_url", "");
    // Force cache invalidation by creating a new notifier
    notifier = new JobNotifier(pool, fakeLogger);
    await notifier.onJobRunStateChange(makeRun());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not send notification for running status", async () => {
    await setSetting(pool, "slack_webhook_url", "https://hooks.slack.test/test");
    await notifier.onJobRunStateChange(makeRun({ status: "running" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("routes timed_out to on_error channels", async () => {
    await setSetting(pool, "slack_webhook_url", "https://hooks.slack.test/test");
    await notifier.onJobRunStateChange(makeRun({ status: "timed_out" }));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.attachments[0].color).toBe("#ef4444");
  });
});
