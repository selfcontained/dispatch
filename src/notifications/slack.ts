import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";

import type { AgentRecord } from "../agents/manager.js";
import { getSetting, setSetting, deleteSetting } from "../db/settings.js";

type SlackBlock =
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> };

const NOTIFY_EVENT_TYPES = ["done", "waiting_user", "blocked"] as const;
type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number];

const EVENT_CONFIG: Record<NotifyEventType, { emoji: string; verb: string; color: string }> = {
  done: { emoji: "\u2705", verb: "finished", color: "#22c55e" },
  waiting_user: { emoji: "\ud83d\udfe1", verb: "needs your input", color: "#f59e0b" },
  blocked: { emoji: "\ud83d\udd34", verb: "is blocked", color: "#ef4444" },
};

const SETTING_WEBHOOK_URL = "slack_webhook_url";
const SETTING_NOTIFY_EVENTS = "slack_notify_events";

/** Short-lived cache to avoid DB reads on every agent event. */
const CACHE_TTL_MS = 10_000;

type CachedSettings = {
  webhookUrl: string | null;
  notifyEvents: NotifyEventType[];
  expiresAt: number;
};

export class SlackNotifier {
  private cachedSettings: CachedSettings | null = null;

  constructor(
    private pool: Pool,
    private log: FastifyBaseLogger
  ) {}

  async getWebhookUrl(): Promise<string | null> {
    return getSetting(this.pool, SETTING_WEBHOOK_URL);
  }

  async setWebhookUrl(url: string): Promise<void> {
    if (!url) {
      await deleteSetting(this.pool, SETTING_WEBHOOK_URL);
    } else {
      await setSetting(this.pool, SETTING_WEBHOOK_URL, url);
    }
    this.invalidateCache();
  }

  async getNotifyEvents(): Promise<NotifyEventType[]> {
    const raw = await getSetting(this.pool, SETTING_NOTIFY_EVENTS);
    if (!raw) return [...NOTIFY_EVENT_TYPES];
    try {
      const parsed = JSON.parse(raw) as string[];
      return parsed.filter((e): e is NotifyEventType =>
        NOTIFY_EVENT_TYPES.includes(e as NotifyEventType)
      );
    } catch {
      return [...NOTIFY_EVENT_TYPES];
    }
  }

  async setNotifyEvents(events: string[]): Promise<void> {
    const filtered = events.filter((e): e is NotifyEventType =>
      NOTIFY_EVENT_TYPES.includes(e as NotifyEventType)
    );
    await setSetting(this.pool, SETTING_NOTIFY_EVENTS, JSON.stringify(filtered));
    this.invalidateCache();
  }

  async getSettings(): Promise<{
    webhookUrl: string;
    notifyEvents: NotifyEventType[];
  }> {
    const [webhookUrl, notifyEvents] = await Promise.all([
      this.getWebhookUrl(),
      this.getNotifyEvents(),
    ]);
    return { webhookUrl: webhookUrl ?? "", notifyEvents };
  }

  /**
   * Called on every agent event upsert. Uses a short-lived cache to avoid
   * hitting the DB on the hot path (most events are "working"/"idle" and
   * are filtered out before the cache is even checked).
   */
  async onAgentEvent(agent: AgentRecord): Promise<void> {
    const event = agent.latestEvent;
    if (!event) return;
    if (!NOTIFY_EVENT_TYPES.includes(event.type as NotifyEventType)) return;

    try {
      const settings = await this.getCachedSettings();
      if (!settings.webhookUrl) return;
      if (!settings.notifyEvents.includes(event.type as NotifyEventType)) return;

      const cfg = EVENT_CONFIG[event.type as NotifyEventType];
      await this.sendSlackMessage(settings.webhookUrl, agent, event, cfg);
    } catch (err) {
      this.log.warn({ err, agentId: agent.id }, "Failed to send Slack notification");
    }
  }

  async sendTestMessage(webhookUrl: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.postToSlack(webhookUrl, {
        username: "Dispatch",
        text: "Dispatch test notification — your Slack webhook is working!",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "\u2705 *Dispatch test notification*\nYour Slack webhook is configured and working!",
            },
          },
        ],
      });

      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `Slack returned ${res.status}: ${body}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
    }
  }

  private async getCachedSettings(): Promise<{ webhookUrl: string | null; notifyEvents: NotifyEventType[] }> {
    if (this.cachedSettings && Date.now() < this.cachedSettings.expiresAt) {
      return this.cachedSettings;
    }
    const [webhookUrl, notifyEvents] = await Promise.all([
      this.getWebhookUrl(),
      this.getNotifyEvents(),
    ]);
    this.cachedSettings = { webhookUrl, notifyEvents, expiresAt: Date.now() + CACHE_TTL_MS };
    return this.cachedSettings;
  }

  private invalidateCache(): void {
    this.cachedSettings = null;
  }

  private async postToSlack(webhookUrl: string, payload: Record<string, unknown>): Promise<Response> {
    return fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  private async sendSlackMessage(
    webhookUrl: string,
    agent: AgentRecord,
    event: { type: string; message: string },
    cfg: { emoji: string; verb: string; color: string }
  ): Promise<void> {
    const agentName = agent.name || agent.id.slice(0, 8);
    const branch = agent.gitContext?.branch;
    const elapsed = this.formatElapsed(agent.createdAt);
    const agentType = agent.type ? agent.type.charAt(0).toUpperCase() + agent.type.slice(1) : "Agent";

    const blocks: SlackBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Agent "${agentName}" ${cfg.verb}*\n_${event.message}_`,
        },
      },
    ];

    const contextParts: string[] = [];
    if (branch) contextParts.push(`Branch: \`${branch}\``);
    contextParts.push(agentType);
    contextParts.push(elapsed);

    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: contextParts.join("  \u00b7  ") }],
    });

    const fallback = `Agent "${agentName}" ${cfg.verb}: ${event.message}`;

    const res = await this.postToSlack(webhookUrl, {
      username: "Dispatch",
      attachments: [{ color: cfg.color, fallback, blocks }],
    });

    if (!res.ok) {
      const body = await res.text();
      this.log.warn({ status: res.status, body }, "Slack webhook returned error");
    }
  }

  private formatElapsed(createdAt: string): string {
    const ms = Date.now() - new Date(createdAt).getTime();
    const mins = Math.floor(ms / 60_000);
    if (mins < 1) return "just started";
    if (mins < 60) return `running ${mins}m`;
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return remainMins > 0 ? `running ${hours}h ${remainMins}m` : `running ${hours}h`;
  }
}
