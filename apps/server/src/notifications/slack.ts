import {
  SlackApp,
  SlackDeliveryUnknownError,
  SlackRetryError,
} from "./slack-app.js";
import { notifyMessage, type SlackBlock as KitBlock } from "./slack-blocks.js";
import { imageBlocks, loadImages, sendWithImages } from "./slack-images.js";
import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";

import type { NotifyInput, NotifyResult } from "../shared/mcp/server.js";
import type { AgentRecord } from "../agents/manager.js";
import { getSetting, setSetting } from "../db/settings.js";

const NOTIFY_EVENT_TYPES = ["waiting_user", "blocked"] as const;
type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number];
export type NotificationSignal = {
  type: NotifyEventType;
  message: string;
};

export type { NotifyInput, NotifyResult };

const SETTING_WEB_NOTIFY_ENABLED = "web_notify_enabled";
const SETTING_WEB_NOTIFY_EVENTS = "web_notify_events";

/** Short-lived cache to avoid DB reads on every agent event. */
const CACHE_TTL_MS = 10_000;

/** Rate limit for agent-initiated notifications: max per window. */
const NOTIFY_RATE_LIMIT = 5;
const NOTIFY_RATE_WINDOW_MS = 60_000;

type CachedSettings = {
  webNotifyEnabled: boolean;
  webNotifyEvents: NotifyEventType[];
  expiresAt: number;
};

export class SlackNotifier {
  readonly app: SlackApp;
  private cachedSettings: CachedSettings | null = null;
  private isFocused: ((agentId: string) => boolean) | null = null;
  /** Records a notify message so Slack thread replies route to that agent. */
  private notifySent?: (
    sent: { channelId: string; timestamp: string; generation: string },
    agentId: string
  ) => Promise<void>;
  setNotifySent(fn: NonNullable<SlackNotifier["notifySent"]>) {
    this.notifySent = fn;
  }
  /** `notify({ replyTo })`: an agent answering in a Slack thread. */
  private threadReply?: (
    agent: AgentRecord,
    input: {
      replyTo: string;
      message: string;
      title?: string;
      images?: string[];
    }
  ) => Promise<NotifyResult>;
  setThreadReply(fn: NonNullable<SlackNotifier["threadReply"]>) {
    this.threadReply = fn;
  }
  /**
   * The Slack-origin post the agent's open turn answers, if its thread is
   * still live: a notify without replyTo during that turn answers there.
   */
  private turnPost?: (agentId: string) => Promise<string | null>;
  setTurnPost(fn: NonNullable<SlackNotifier["turnPost"]>) {
    this.turnPost = fn;
  }
  /** `notify({ form })`: create a Dispatch form and alert Slack about it now. */
  private formNotify?: (
    agent: AgentRecord,
    input: NotifyInput & { form: NonNullable<NotifyInput["form"]> }
  ) => Promise<NotifyResult>;
  setFormNotify(fn: NonNullable<SlackNotifier["formNotify"]>) {
    this.formNotify = fn;
  }
  /** Per-agent rate limit tracking for notify calls. */
  private notifyTimestamps: Map<string, number[]> = new Map();

  constructor(
    private pool: Pool,
    private log: FastifyBaseLogger
  ) {
    this.app = new SlackApp(
      pool,
      fetch,
      (url) => new WebSocket(url),
      (diagnostic) => {
        this.log.info(
          diagnostic,
          "Slack Socket Mode interactive callback stage"
        );
      }
    );
  }

  /** Register a callback to check if the user is actively viewing an agent. */
  setFocusCheck(fn: (agentId: string) => boolean): void {
    this.isFocused = fn;
  }

  async getSettings(): Promise<{
    webNotifyEnabled: boolean;
    webNotifyEvents: NotifyEventType[];
  }> {
    const [webNotifyEnabled, webNotifyEvents] = await Promise.all([
      this.getWebNotifyEnabled(),
      this.getWebNotifyEvents(),
    ]);
    return { webNotifyEnabled, webNotifyEvents };
  }

  async getWebNotifyEnabled(): Promise<boolean> {
    const raw = await getSetting(this.pool, SETTING_WEB_NOTIFY_ENABLED);
    return raw === "true";
  }

  async setWebNotifyEnabled(enabled: boolean): Promise<void> {
    await setSetting(this.pool, SETTING_WEB_NOTIFY_ENABLED, String(enabled));
    this.invalidateCache();
  }

  async getWebNotifyEvents(): Promise<NotifyEventType[]> {
    return this.getEventSetting(SETTING_WEB_NOTIFY_EVENTS);
  }

  async setWebNotifyEvents(events: string[]): Promise<void> {
    return this.setEventSetting(SETTING_WEB_NOTIFY_EVENTS, events);
  }

  /**
   * Check whether a web notification should be sent for this agent event.
   * Returns the notification payload if web notifications are enabled and
   * the event type is configured, or null if not applicable.
   */
  async shouldWebNotify(
    agent: AgentRecord,
    event: NotificationSignal
  ): Promise<{
    agentId: string;
    agentName: string;
    eventType: string;
    message: string;
  } | null> {
    if (!NOTIFY_EVENT_TYPES.includes(event.type as NotifyEventType))
      return null;

    if (this.isFocused?.(agent.id)) return null;

    const settings = await this.getCachedSettings();
    if (!settings.webNotifyEnabled) return null;
    if (!settings.webNotifyEvents.includes(event.type as NotifyEventType))
      return null;

    return {
      agentId: agent.id,
      agentName: agent.name || agent.id.slice(0, 8),
      eventType: event.type,
      message: event.message,
    };
  }

  /**
   * Agent-initiated notification via the notify MCP tool.
   * Bypasses focus filtering by default (agents explicitly chose to notify).
   */
  async sendNotification(
    agent: AgentRecord,
    input: NotifyInput
  ): Promise<NotifyResult> {
    // Rate limit check
    if (this.isRateLimited(agent.id)) {
      return {
        sent: false,
        reason: "Rate limited — max 5 notifications per minute per agent.",
      };
    }

    // A form to answer now: created in Dispatch, then alerted through the
    // Slack app's interactive flow. Every refusal here precedes creation.
    if (input.form) {
      if (input.images?.length)
        throw new Error(
          "notify can't combine form with images. Send them separately."
        );
      if (input.title && input.form.title)
        throw new Error(
          "notify got both title and form.title; give the form one title."
        );
      if (!this.formNotify)
        return { sent: false, reason: "Slack forms are unavailable." };
      if (!(await this.app.settings()).binding)
        return {
          sent: false,
          reason:
            "Slack forms need the Slack app connected in Settings. Nothing was created; use post with form to ask in Dispatch.",
        };
      this.recordNotifyTimestamp(agent.id);
      return this.formNotify(agent, { ...input, form: input.form });
    }

    const toThread = async (replyTo: string): Promise<NotifyResult> => {
      if (!this.threadReply)
        return { sent: false, reason: "Slack thread replies are unavailable." };
      if (!(await this.app.settings()).binding)
        return {
          sent: false,
          reason:
            "Slack thread replies need the Slack app connected in Settings. Nothing was sent.",
        };
      this.recordNotifyTimestamp(agent.id);
      return this.threadReply(agent, {
        replyTo,
        message: input.message,
        title: input.title,
        images: input.images,
      });
    };

    // An explicit answer in the Slack thread a message came from.
    if (input.replyTo) return toThread(input.replyTo);

    // Respect focus if explicitly requested
    if (input.respectFocus && this.isFocused?.(agent.id)) {
      return {
        sent: false,
        reason: "Notification suppressed — user is focused on this agent.",
      };
    }

    // While the open turn answers a live Slack thread, the alert goes there.
    const turnPost = this.threadReply
      ? await this.turnPost?.(agent.id).catch(() => null)
      : null;
    if (turnPost) return toThread(turnPost);

    const appSettings = await this.app.settings();
    if (appSettings.binding) {
      const loaded = await loadImages(input.images);
      if ("error" in loaded)
        return { sent: false, reason: `${loaded.error} Nothing was sent.` };
      const pictures = await imageBlocks(this.app, loaded.images);
      const compose = (images: KitBlock[]) =>
        notifyMessage({
          agentName: agent.name || agent.id,
          title: input.title,
          message: input.message,
          openUrl: `${appSettings.binding!.baseUrl}/agents/${encodeURIComponent(agent.id)}`,
          images,
        });
      try {
        const result = await sendWithImages(
          this.app,
          pictures.blocks,
          (images) =>
            this.app.postBlocks({
              ...compose(images),
              username: agent.name || agent.id,
            }),
          {
            onRefused: (code, attempts) =>
              this.log.warn(
                { agentId: agent.id, code, attempts },
                "Slack refused notify images; sent text only"
              ),
          }
        );
        const sent = result.sent;
        const note = result.note ?? pictures.skipped;
        await this.notifySent?.(sent, agent.id).catch(() => {});
        this.recordNotifyTimestamp(agent.id);
        return note ? { sent: true, note } : { sent: true };
      } catch (error) {
        if (error instanceof SlackRetryError)
          return { sent: false, reason: "Slack rate limited. Retry shortly." };
        if (error instanceof SlackDeliveryUnknownError)
          return {
            sent: false,
            reason:
              "Slack's response was unclear, so it may or may not have posted. Don't repeat it.",
          };
        return {
          sent: false,
          reason: "Slack delivery failed. Check connection in Settings.",
        };
      }
    }
    return {
      sent: false,
      reason:
        "Slack notifications need the Slack app connected in Settings. Nothing was sent.",
    };
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

  private async getEventSetting(key: string): Promise<NotifyEventType[]> {
    const raw = await getSetting(this.pool, key);
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

  private async setEventSetting(key: string, events: string[]): Promise<void> {
    const filtered = events.filter((e): e is NotifyEventType =>
      NOTIFY_EVENT_TYPES.includes(e as NotifyEventType)
    );
    await setSetting(this.pool, key, JSON.stringify(filtered));
    this.invalidateCache();
  }

  private async getCachedSettings(): Promise<CachedSettings> {
    if (this.cachedSettings && Date.now() < this.cachedSettings.expiresAt) {
      return this.cachedSettings;
    }
    const [webNotifyEnabled, webNotifyEvents] = await Promise.all([
      this.getWebNotifyEnabled(),
      this.getWebNotifyEvents(),
    ]);
    this.cachedSettings = {
      webNotifyEnabled,
      webNotifyEvents,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    return this.cachedSettings;
  }

  private invalidateCache(): void {
    this.cachedSettings = null;
  }
}
