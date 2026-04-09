import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";

import { getSetting } from "../db/settings.js";
import type { JobRunRecord, JobRunConfig } from "../jobs/store.js";

type SlackBlock =
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> };

const SETTING_WEBHOOK_URL = "slack_webhook_url";

/** Short-lived cache to avoid DB reads on every notification attempt. */
const CACHE_TTL_MS = 10_000;

type CachedWebhook = {
  url: string | null;
  expiresAt: number;
};

type JobEvent = "on_complete" | "on_error" | "on_needs_input";

const STATUS_TO_EVENT: Record<string, JobEvent | null> = {
  completed: "on_complete",
  failed: "on_error",
  timed_out: "on_error",
  crashed: "on_error",
  needs_input: "on_needs_input",
};

const EVENT_CONFIG: Record<JobEvent, { color: string; verb: string }> = {
  on_complete: { color: "#22c55e", verb: "completed successfully" },
  on_error: { color: "#ef4444", verb: "failed" },
  on_needs_input: { color: "#f59e0b", verb: "needs your input" },
};

export class JobNotifier {
  private cachedWebhook: CachedWebhook | null = null;

  constructor(
    private pool: Pool,
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
          this.log.debug({ channel, runId: run.id }, "Unknown notification channel, skipping");
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

  private async sendSlackNotification(run: JobRunRecord, event: JobEvent): Promise<void> {
    const webhookUrl = await this.getCachedWebhookUrl();
    if (!webhookUrl) {
      this.log.debug({ runId: run.id }, "No Slack webhook configured, skipping job notification");
      return;
    }

    const cfg = EVENT_CONFIG[event];
    const jobName = escapeSlackMrkdwn(run.config.name);
    const directory = run.config.directory;
    const summary = escapeSlackMrkdwn(run.report?.summary ?? run.pendingQuestion ?? "");
    const duration = run.durationMs != null ? this.formatDuration(run.durationMs) : null;

    const statusLabel = run.status === "timed_out" ? "timed out" : run.status;

    const blocks: SlackBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Job "${jobName}" ${cfg.verb}*${summary ? `\n_${summary}_` : ""}`,
        },
      },
    ];

    const contextParts: string[] = [];
    contextParts.push(`Status: \`${statusLabel}\``);
    contextParts.push(`Dir: \`${directory}\``);
    if (duration) contextParts.push(duration);

    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: contextParts.join("  ·  ") }],
    });

    const fallback = `Job "${jobName}" ${cfg.verb}: ${summary}`;

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Dispatch Jobs",
        attachments: [{ color: cfg.color, fallback, blocks }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.log.warn({ status: res.status, body }, "Slack webhook returned error for job notification");
    }
  }

  private async getCachedWebhookUrl(): Promise<string | null> {
    if (this.cachedWebhook && Date.now() < this.cachedWebhook.expiresAt) {
      return this.cachedWebhook.url;
    }
    const url = await getSetting(this.pool, SETTING_WEBHOOK_URL);
    this.cachedWebhook = { url: url ?? null, expiresAt: Date.now() + CACHE_TTL_MS };
    return this.cachedWebhook.url;
  }

  private formatDuration(ms: number): string {
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
}

/** Escape characters that Slack interprets as mrkdwn or link syntax. */
function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
