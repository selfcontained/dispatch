import type { FastifyBaseLogger } from "fastify";

import type { JobRunRecord, JobRunConfig } from "../jobs/store.js";
import { SlackRetryError, type SlackApp } from "./slack-app.js";
import { dispatchMessage, mrkdwnText, noteLine } from "./slack-blocks.js";

/** The slice of the Slack app job notifications use. */
export type JobSlackApp = Pick<SlackApp, "postBlocks"> & {
  settings(): Promise<{ binding: { baseUrl: string } | null }>;
};

type JobEvent = "on_complete" | "on_error" | "on_needs_input";

const STATUS_TO_EVENT: Record<string, JobEvent | null> = {
  completed: "on_complete",
  failed: "on_error",
  timed_out: "on_error",
  crashed: "on_error",
  needs_input: "on_needs_input",
};

const EVENT_VERB: Record<JobEvent, string> = {
  on_complete: "completed successfully",
  on_error: "failed",
  on_needs_input: "needs your input",
};

const SENDER = "Dispatch Jobs";
const MAX_RETRY_WAIT_MS = 2_000;

export class JobNotifier {
  constructor(
    private app: JobSlackApp,
    private log: FastifyBaseLogger
  ) {}

  /**
   * Called when a job run reaches a lifecycle state that may warrant a notification.
   * Reads the run's notify config and routes to configured channels.
   */
  async onJobRunStateChange(run: JobRunRecord): Promise<void> {
    const event = STATUS_TO_EVENT[run.status];
    if (!event) return;

    const channels = this.getNotifyChannels(run.config, event);
    if (channels.length === 0) return;

    try {
      for (const channel of channels) {
        if (channel === "slack") {
          await this.sendSlackNotification(run, event);
        } else {
          this.log.debug(
            { channel, runId: run.id },
            "Unknown notification channel, skipping"
          );
        }
      }
    } catch (err) {
      this.log.warn({ err, runId: run.id }, "Failed to send job notification");
    }
  }

  private getNotifyChannels(config: JobRunConfig, event: JobEvent): string[] {
    const notify = config.notify;
    if (!notify) return [];
    switch (event) {
      case "on_complete":
        return notify.onComplete ?? [];
      case "on_error":
        return notify.onError ?? [];
      case "on_needs_input":
        return notify.onNeedsInput ?? [];
    }
  }

  private async sendSlackNotification(
    run: JobRunRecord,
    event: JobEvent
  ): Promise<void> {
    const { binding } = await this.app.settings();
    if (!binding) {
      this.log.debug(
        { runId: run.id },
        "Slack app not configured, skipping job notification"
      );
      return;
    }

    const headline = `Job "${run.config.name}" ${EVENT_VERB[event]}`;
    const summary = run.report?.summary ?? run.pendingQuestion ?? "";
    const statusLabel = run.status === "timed_out" ? "timed out" : run.status;
    const details = [
      `Status: \`${mrkdwnText(statusLabel)}\``,
      `Dir: \`${mrkdwnText(run.config.directory)}\``,
      ...(run.durationMs != null ? [formatDuration(run.durationMs)] : []),
    ];

    const message = dispatchMessage({
      header: { agentName: SENDER },
      body: summary ? `**${headline}**\n\n${summary}` : `**${headline}**`,
      notes: [noteLine(details.join("  ·  "))],
      openUrl: run.agentId
        ? `${binding.baseUrl}/agents/${encodeURIComponent(run.agentId)}`
        : undefined,
      summary: summary ? `${headline}: ${summary}` : headline,
    });

    const send = () => this.app.postBlocks({ ...message, username: SENDER });
    try {
      await send();
    } catch (err) {
      // The app spaces sends a second apart; a burst of finished runs waits
      // once. A longer wait (Slack's own rate limit) isn't worth holding for.
      if (
        !(err instanceof SlackRetryError) ||
        err.retryAfterMs > MAX_RETRY_WAIT_MS
      )
        throw err;
      await new Promise((r) => setTimeout(r, err.retryAfterMs));
      await send();
    }
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}
