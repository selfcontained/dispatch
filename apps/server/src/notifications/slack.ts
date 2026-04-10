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

const NOTIFY_LEVELS = ["info", "success", "warning", "error"] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

const LEVEL_CONFIG: Record<NotifyLevel, { emoji: string; color: string }> = {
  info: { emoji: "\u2139\ufe0f", color: "#3b82f6" },
  success: { emoji: "\u2705", color: "#22c55e" },
  warning: { emoji: "\u26a0\ufe0f", color: "#f59e0b" },
  error: { emoji: "\ud83d\udead", color: "#ef4444" },
};

export type NotifyInput = {
  message: string;
  title?: string;
  level?: NotifyLevel;
  respectFocus?: boolean;
};

export type NotifyResult = {
  sent: boolean;
  reason?: string;
};

const SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/";
const SETTING_WEBHOOK_URL = "slack_webhook_url";
const SETTING_NOTIFY_EVENTS = "slack_notify_events";

/** Short-lived cache to avoid DB reads on every agent event. */
const CACHE_TTL_MS = 10_000;

/** Rate limit for agent-initiated notifications: max per window. */
const NOTIFY_RATE_LIMIT = 5;
const NOTIFY_RATE_WINDOW_MS = 60_000;

type CachedSettings = {
  webhookUrl: string | null;
  notifyEvents: NotifyEventType[];
  expiresAt: number;
};

/**
 * Validate that a webhook URL points to Slack's official endpoint.
 * Prevents SSRF by rejecting internal/arbitrary URLs.
 */
export function isValidSlackWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.href.startsWith(SLACK_WEBHOOK_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Escape Slack special mention syntax (<!channel>, <!here>, <!everyone>)
 * in agent-provided content to prevent mrkdwn injection.
 */
function sanitizeSlackMrkdwn(text: string): string {
  return text.replace(/<!([^>]*)>/g, "&lt;!$1&gt;");
}

export class SlackNotifier {
  private cachedSettings: CachedSettings | null = null;
  private isFocused: ((agentId: string) => boolean) | null = null;
  /** Per-agent rate limit tracking for dispatch_notify calls. */
  private notifyTimestamps: Map<string, number[]> = new Map();

  constructor(
    private pool: Pool,
    private log: FastifyBaseLogger
  ) {}

  /** Register a callback to check if the user is actively viewing an agent. */
  setFocusCheck(fn: (agentId: string) => boolean): void {
    this.isFocused = fn;
  }

  async getWebhookUrl(): Promise<string | null> {
    return getSetting(this.pool, SETTING_WEBHOOK_URL);
  }

  async setWebhookUrl(url: string): Promise<void> {
    if (!url) {
      await deleteSetting(this.pool, SETTING_WEBHOOK_URL);
    } else {
      if (!isValidSlackWebhookUrl(url)) {
        throw new Error("Invalid webhook URL: must start with https://hooks.slack.com/");
      }
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
      if (this.isFocused?.(agent.id)) {
        this.log.debug({ agentId: agent.id }, "Skipping notification — user is focused on agent");
        return;
      }

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
    if (!isValidSlackWebhookUrl(webhookUrl)) {
      return { ok: false, error: "Invalid webhook URL: must start with https://hooks.slack.com/" };
    }
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

  /**
   * Agent-initiated notification via the dispatch_notify MCP tool.
   * Bypasses focus filtering by default (agents explicitly chose to notify).
   */
  async sendNotification(agent: AgentRecord, input: NotifyInput): Promise<NotifyResult> {
    // Rate limit check
    if (this.isRateLimited(agent.id)) {
      return { sent: false, reason: "Rate limited — max 5 notifications per minute per agent." };
    }

    // Respect focus if explicitly requested
    if (input.respectFocus && this.isFocused?.(agent.id)) {
      return { sent: false, reason: "Notification suppressed — user is focused on this agent." };
    }

    const settings = await this.getCachedSettings();
    if (!settings.webhookUrl) {
      return { sent: false, reason: "No Slack webhook configured." };
    }

    try {
      const level = input.level ?? "info";
      const cfg = LEVEL_CONFIG[level];
      const agentName = agent.name || agent.id.slice(0, 8);

      // Sanitize agent-provided content to prevent Slack mrkdwn injection
      // (<!channel>, <!here>, <!everyone> mentions, and <url|label> link spoofing)
      const safeMessage = sanitizeSlackMrkdwn(input.message);
      const safeTitle = input.title ? sanitizeSlackMrkdwn(input.title) : undefined;

      const blocks: SlackBlock[] = [];

      // Title + message
      const titleLine = safeTitle
        ? `*${cfg.emoji} ${safeTitle}*`
        : `*${cfg.emoji} Notification from "${agentName}"*`;
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `${titleLine}\n${safeMessage}` },
      });

      // Context line
      const branch = agent.gitContext?.branch;
      const contextParts: string[] = [];
      contextParts.push(`Agent: ${agentName}`);
      if (branch) contextParts.push(`Branch: \`${branch}\``);
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: contextParts.join("  \u00b7  ") }],
      });

      const fallback = safeTitle
        ? `${safeTitle}: ${safeMessage}`
        : `Notification from "${agentName}": ${safeMessage}`;

      const res = await this.postToSlack(settings.webhookUrl, {
        username: "Dispatch",
        attachments: [{ color: cfg.color, fallback, blocks }],
      });

      if (!res.ok) {
        const body = await res.text();
        this.log.warn({ status: res.status, body }, "Slack webhook returned error for dispatch_notify");
        return { sent: false, reason: `Slack returned ${res.status}: ${body}` };
      }

      this.recordNotifyTimestamp(agent.id);
      return { sent: true };
    } catch (err) {
      this.log.warn({ err, agentId: agent.id }, "Failed to send agent-initiated notification");
      return { sent: false, reason: err instanceof Error ? err.message : "Unknown error" };
    }
  }

  private isRateLimited(agentId: string): boolean {
    const now = Date.now();
    const timestamps = this.notifyTimestamps.get(agentId) ?? [];
    const recent = timestamps.filter((t) => now - t < NOTIFY_RATE_WINDOW_MS);
    if (recent.length === 0) {
      this.notifyTimestamps.delete(agentId);
    } else {
      this.notifyTimestamps.set(agentId, recent);
    }
    return recent.length >= NOTIFY_RATE_LIMIT;
  }

  private recordNotifyTimestamp(agentId: string): void {
    const timestamps = this.notifyTimestamps.get(agentId) ?? [];
    timestamps.push(Date.now());
    this.notifyTimestamps.set(agentId, timestamps);
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
      signal: AbortSignal.timeout(10_000),
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
