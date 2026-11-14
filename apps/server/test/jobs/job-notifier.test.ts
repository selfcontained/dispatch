import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  JobNotifier,
  formatDuration,
  type JobSlackApp,
} from "../../src/notifications/job-notifier.js";
import { SlackRetryError } from "../../src/notifications/slack-app.js";
import type { JobRunRecord } from "../../src/jobs/store.js";

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

type Posted = { text: string; blocks: any[]; username?: string };

function fakeApp(connected = true) {
  const posted: Posted[] = [];
  const postBlocks = vi.fn(async (input: Posted) => {
    posted.push(input);
    return { channelId: "C1", timestamp: "1.1", generation: "g" };
  });
  const app = {
    settings: vi.fn(async () => ({
      binding: connected ? { baseUrl: "http://lan:6767" } : null,
    })),
    postBlocks,
  } as unknown as JobSlackApp;
  return { app, posted, postBlocks };
}

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

const bodyOf = (p: Posted) =>
  p.blocks.find((b) => b.type === "markdown")?.text as string;
const notesOf = (p: Posted) =>
  p.blocks
    .filter((b) => b.type === "context")
    .map((b) => b.elements[0].text as string);

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

describe("JobNotifier", () => {
  it("sends one Slack app message for a completed run with on_complete: [slack]", async () => {
    const { app, posted } = fakeApp();
    await new JobNotifier(app, fakeLogger).onJobRunStateChange(makeRun());

    expect(posted).toHaveLength(1);
    expect(posted[0].username).toBe("Dispatch Jobs");
    expect(bodyOf(posted[0])).toBe(
      '**Job "test-job" completed successfully**\n\nAll done'
    );
    expect(posted[0].text).toContain("test-job");
    // Shared layout: View in Dispatch link to the run's agent.
    expect(notesOf(posted[0]).at(-1)).toContain(
      "<http://lan:6767/agents/agent-1|View in Dispatch>"
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends nothing and doesn't error when the Slack app isn't configured", async () => {
    const { app, postBlocks } = fakeApp(false);
    await expect(
      new JobNotifier(app, fakeLogger).onJobRunStateChange(makeRun())
    ).resolves.toBeUndefined();

    expect(postBlocks).not.toHaveBeenCalled();
    expect(fakeLogger.warn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends a failed run with on_error: [slack]", async () => {
    const { app, posted } = fakeApp();
    await new JobNotifier(app, fakeLogger).onJobRunStateChange(
      makeRun({
        status: "failed",
        report: { status: "failed", summary: "Broke", tasks: [] },
      })
    );

    expect(posted).toHaveLength(1);
    expect(bodyOf(posted[0])).toBe('**Job "test-job" failed**\n\nBroke');
    expect(notesOf(posted[0])[0]).toContain("Status: `failed`");
  });

  it("sends needs_input with on_needs_input configured, using pendingQuestion", async () => {
    const { app, posted } = fakeApp();
    await new JobNotifier(app, fakeLogger).onJobRunStateChange(
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

    expect(posted).toHaveLength(1);
    expect(bodyOf(posted[0])).toContain("needs your input");
    expect(bodyOf(posted[0])).toContain("What should I do next?");
    expect(posted[0].text).toContain("What should I do next?");
  });

  it("keeps the success/failure filter: no channels for the event, nothing sent", async () => {
    const { app, postBlocks } = fakeApp();
    const notifier = new JobNotifier(app, fakeLogger);
    await notifier.onJobRunStateChange(
      makeRun({
        config: {
          ...makeRun().config,
          notify: { onComplete: [], onError: ["slack"], onNeedsInput: [] },
        },
      })
    );
    await notifier.onJobRunStateChange(
      makeRun({
        status: "failed",
        config: {
          ...makeRun().config,
          notify: { onComplete: ["slack"], onError: [], onNeedsInput: [] },
        },
      })
    );
    expect(postBlocks).not.toHaveBeenCalled();
  });

  it("does not send when notify config is undefined", async () => {
    const { app, postBlocks } = fakeApp();
    await new JobNotifier(app, fakeLogger).onJobRunStateChange(
      makeRun({ config: { ...makeRun().config, notify: undefined as never } })
    );
    expect(postBlocks).not.toHaveBeenCalled();
  });

  it("does not send for running status", async () => {
    const { app, postBlocks } = fakeApp();
    await new JobNotifier(app, fakeLogger).onJobRunStateChange(
      makeRun({ status: "running" })
    );
    expect(postBlocks).not.toHaveBeenCalled();
  });

  it.each(["timed_out", "crashed"] as const)(
    "routes %s to on_error channels",
    async (status) => {
      const { app, posted } = fakeApp();
      await new JobNotifier(app, fakeLogger).onJobRunStateChange(
        makeRun({ status })
      );
      expect(posted).toHaveLength(1);
      expect(bodyOf(posted[0])).toContain("failed");
    }
  );

  it("displays 'timed out' as status label for timed_out runs", async () => {
    const { app, posted } = fakeApp();
    await new JobNotifier(app, fakeLogger).onJobRunStateChange(
      makeRun({ status: "timed_out" })
    );
    expect(notesOf(posted[0])[0]).toContain("`timed out`");
  });

  it("neutralizes mentions and escapes context-line text", async () => {
    const { app, posted } = fakeApp();
    await new JobNotifier(app, fakeLogger).onJobRunStateChange(
      makeRun({
        config: { ...makeRun().config, directory: "/tmp/<repo> & co" },
        report: {
          status: "completed",
          summary: "Ping <!channel> and @here",
          tasks: [],
        },
      })
    );

    expect(bodyOf(posted[0])).not.toContain("<!channel>");
    expect(bodyOf(posted[0])).not.toMatch(/@here/);
    expect(notesOf(posted[0])[0]).toContain("/tmp/&lt;repo&gt; &amp; co");
  });

  it("shows duration in the context line, and omits it when null", async () => {
    const { app, posted } = fakeApp();
    const notifier = new JobNotifier(app, fakeLogger);
    await notifier.onJobRunStateChange(makeRun({ durationMs: 125_000 }));
    expect(notesOf(posted[0])[0]).toContain("2m 5s");

    // Second send waits out the app's one-second spacing in production; the
    // fake has none.
    await notifier.onJobRunStateChange(makeRun({ durationMs: null }));
    expect(notesOf(posted[1])[0]).not.toMatch(/\d+[hms]/);
  });

  it("retries once when the Slack app asks to wait", async () => {
    vi.useFakeTimers();
    try {
      const { app, postBlocks } = fakeApp();
      postBlocks.mockRejectedValueOnce(new SlackRetryError(1000));
      const sending = new JobNotifier(app, fakeLogger).onJobRunStateChange(
        makeRun()
      );
      await vi.advanceTimersByTimeAsync(1000);
      await sending;
      expect(postBlocks).toHaveBeenCalledTimes(2);
      expect(fakeLogger.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't wait out a long Slack rate limit: logs and moves on", async () => {
    const { app, postBlocks } = fakeApp();
    postBlocks.mockRejectedValueOnce(new SlackRetryError(60_000));
    await new JobNotifier(app, fakeLogger).onJobRunStateChange(makeRun());
    expect(postBlocks).toHaveBeenCalledTimes(1);
    expect(fakeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1" }),
      "Failed to send job notification"
    );
  });

  it("logs and swallows a Slack delivery failure", async () => {
    const { app, postBlocks } = fakeApp();
    postBlocks.mockRejectedValueOnce(new Error("channel_not_found"));
    await expect(
      new JobNotifier(app, fakeLogger).onJobRunStateChange(makeRun())
    ).resolves.toBeUndefined();
    expect(fakeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1" }),
      "Failed to send job notification"
    );
  });
});

describe("formatDuration", () => {
  it.each([
    [500, "500ms"],
    [45_000, "45s"],
    [125_000, "2m 5s"],
    [120_000, "2m"],
    [3_900_000, "1h 5m"],
    [3_600_000, "1h"],
  ])("formats %d as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
