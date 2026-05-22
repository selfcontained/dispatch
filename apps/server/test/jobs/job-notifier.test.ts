import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
    await setSetting(
      pool,
      "slack_webhook_url",
      "https://hooks.slack.test/test"
    );
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
    await setSetting(
      pool,
      "slack_webhook_url",
      "https://hooks.slack.test/test"
    );
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
    await setSetting(
      pool,
      "slack_webhook_url",
      "https://hooks.slack.test/test"
    );
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
    await setSetting(
      pool,
      "slack_webhook_url",
      "https://hooks.slack.test/test"
    );
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
    await setSetting(
      pool,
      "slack_webhook_url",
      "https://hooks.slack.test/test"
    );
    await notifier.onJobRunStateChange(makeRun({ status: "running" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("routes timed_out to on_error channels", async () => {
    await setSetting(
      pool,
      "slack_webhook_url",
      "https://hooks.slack.test/test"
    );
    await notifier.onJobRunStateChange(makeRun({ status: "timed_out" }));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.attachments[0].color).toBe("#ef4444");
  });

  it("displays 'timed out' as status label for timed_out runs", async () => {
    await setSetting(
      pool,
      "slack_webhook_url",
      "https://hooks.slack.test/test"
    );
    await notifier.onJobRunStateChange(makeRun({ status: "timed_out" }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const contextText = body.attachments[0].blocks[1].elements[0].text;
    expect(contextText).toContain("`timed out`");
  });

  it("escapes special characters in job name and summary", async () => {
    await setSetting(
      pool,
      "slack_webhook_url",
      "https://hooks.slack.test/test"
    );
    await notifier.onJobRunStateChange(
      makeRun({
        config: {
          ...makeRun().config,
          name: "job <with> & special chars",
        },
        report: {
          status: "completed",
          summary: "Fixed <script> & stuff",
          tasks: [],
        },
      })
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const text = body.attachments[0].blocks[0].text.text;
    expect(text).toContain("&amp;");
    expect(text).toContain("&lt;");
    expect(text).toContain("&gt;");
    expect(text).not.toContain("<with>");
    expect(text).not.toContain("<script>");
  });

  describe("duration formatting in Slack payload", () => {
    async function getDurationFromPayload(durationMs: number): Promise<string> {
      await setSetting(
        pool,
        "slack_webhook_url",
        "https://hooks.slack.test/test"
      );
      notifier = new JobNotifier(pool, fakeLogger);
      fetchSpy.mockClear();
      await notifier.onJobRunStateChange(makeRun({ durationMs }));
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      return body.attachments[0].blocks[1].elements[0].text;
    }

    it("formats sub-second duration as milliseconds", async () => {
      const text = await getDurationFromPayload(500);
      expect(text).toContain("500ms");
    });

    it("formats seconds-only duration", async () => {
      const text = await getDurationFromPayload(45_000);
      expect(text).toContain("45s");
    });

    it("formats minutes with remaining seconds", async () => {
      const text = await getDurationFromPayload(125_000);
      expect(text).toContain("2m 5s");
    });

    it("formats exact minutes without seconds", async () => {
      const text = await getDurationFromPayload(120_000);
      expect(text).toContain("2m");
      expect(text).not.toContain("2m 0s");
    });

    it("formats hours with remaining minutes", async () => {
      const text = await getDurationFromPayload(3_900_000);
      expect(text).toContain("1h 5m");
    });

    it("formats exact hours without minutes", async () => {
      const text = await getDurationFromPayload(3_600_000);
      expect(text).toContain("1h");
      expect(text).not.toContain("1h 0m");
    });

    it("omits duration when durationMs is null", async () => {
      await setSetting(
        pool,
        "slack_webhook_url",
        "https://hooks.slack.test/test"
      );
      notifier = new JobNotifier(pool, fakeLogger);
      fetchSpy.mockClear();
      await notifier.onJobRunStateChange(makeRun({ durationMs: null }));
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const contextText = body.attachments[0].blocks[1].elements[0].text;
      expect(contextText).not.toMatch(/\d+[hms]/);
    });
  });

  it("does not send notification when notify config is undefined", async () => {
    await setSetting(
      pool,
      "slack_webhook_url",
      "https://hooks.slack.test/test"
    );
    await notifier.onJobRunStateChange(
      makeRun({
        config: {
          ...makeRun().config,
          notify: undefined as never,
        },
      })
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("routes crashed status to on_error channels", async () => {
    await setSetting(
      pool,
      "slack_webhook_url",
      "https://hooks.slack.test/test"
    );
    await notifier.onJobRunStateChange(makeRun({ status: "crashed" }));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.attachments[0].color).toBe("#ef4444");
  });

  it("uses pendingQuestion as summary for needs_input when report is absent", async () => {
    await setSetting(
      pool,
      "slack_webhook_url",
      "https://hooks.slack.test/test"
    );
    await notifier.onJobRunStateChange(
      makeRun({
        status: "needs_input",
        report: null,
        pendingQuestion: "What should I do next?",
        config: {
          ...makeRun().config,
          notify: { onComplete: [], onError: [], onNeedsInput: ["slack"] },
        },
      })
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const fallback = body.attachments[0].fallback;
    expect(fallback).toContain("What should I do next?");
  });
});
