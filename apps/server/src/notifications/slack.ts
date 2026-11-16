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
import { type AlertTiming, DEFAULT_ALERT_TIMING } from "./question-alerts.js";

const NOTIFY_EVENT_TYPES = ["waiting_user", "blocked"] as const;
type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number];
export type NotificationSignal = {
  type: NotifyEventType;
  message: string;
};

export type { NotifyInput, NotifyResult };

const SETTING_WEB_NOTIFY_ENABLED = "web_notify_enabled";
const SETTING_WEB_NOTIFY_EVENTS = "web_notify_events";
const SETTING_SLACK_AWAY_DELAY = "slack_away_delay_seconds";
const SETTING_SLACK_PRESENT_DELAY = "slack_present_delay_minutes";

/** Bounds for the Slack wait settings: away in seconds, present in minutes. */
export const SLACK_AWAY_DELAY_SECONDS = { min: 0, max: 3600, default: 30 };
export const SLACK_PRESENT_DELAY_MINUTES = { min: 1, max: 240, default: 10 };

/** Why a Slack wait setting is invalid, or null when every given one is fine. */
export function slackDelayError(input: {
  slackAwayDelaySeconds?: unknown;
  slackPresentDelayMinutes?: unknown;
}): string | null {
  for (const [key, bounds] of [
    ["slackAwayDelaySeconds", SLACK_AWAY_DELAY_SECONDS],
    ["slackPresentDelayMinutes", SLACK_PRESENT_DELAY_MINUTES],
  ] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < bounds.min ||
      value > bounds.max
    )
      return `${key} must be a whole number from ${bounds.min} to ${bounds.max}.`;
  }
  return null;
}

/** The user's presence in Dispatch, as notify sees it. */
export type NotifyPresence = {
  isPresent: () => boolean;
  isViewing: (agentId: string) => boolean;
  /** Toast the notice on present sessions; how many streams took it. */
  showInApp: (
    agent: AgentRecord,
    notice: { title?: string; message: string }
  ) => number;
};

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

export type NotificationSettings = {
  webNotifyEnabled: boolean;
  webNotifyEvents: NotifyEventType[];
  slackAwayDelaySeconds: number;
  slackPresentDelayMinutes: number;
};

function parseDelay(
  raw: string | null,
  bounds: { min: number; max: number; default: number }
): number {
  const value = raw === null ? NaN : Number(raw);
  return Number.isInteger(value) && value >= bounds.min && value <= bounds.max
    ? value
    : bounds.default;
}

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

  private presence?: NotifyPresence;
  /** Where notify learns whether the user is in Dispatch, and toasts them there. */
  setPresence(presence: NotifyPresence): void {
    this.presence = presence;
  }

  async getSettings(): Promise<NotificationSettings> {
    const [webNotifyEnabled, webNotifyEvents, timing] = await Promise.all([
      this.getWebNotifyEnabled(),
      this.getWebNotifyEvents(),
      this.getSlackDelays(),
    ]);
    return { webNotifyEnabled, webNotifyEvents, ...timing };
  }

  async getSlackDelays(): Promise<{
    slackAwayDelaySeconds: number;
    slackPresentDelayMinutes: number;
  }> {
    const [away, present] = await Promise.all([
      getSetting(this.pool, SETTING_SLACK_AWAY_DELAY),
      getSetting(this.pool, SETTING_SLACK_PRESENT_DELAY),
    ]);
    return {
      slackAwayDelaySeconds: parseDelay(away, SLACK_AWAY_DELAY_SECONDS),
      slackPresentDelayMinutes: parseDelay(
        present,
        SLACK_PRESENT_DELAY_MINUTES
      ),
    };
  }

  /** Out-of-range values throw; the route checks first with `slackDelayError`. */
  async setSlackDelays(input: {
    slackAwayDelaySeconds?: number;
    slackPresentDelayMinutes?: number;
  }): Promise<void> {
    const invalid = slackDelayError(input);
    if (invalid) throw new RangeError(invalid);
    const write = async (key: string, value: number | undefined) => {
      if (value !== undefined) await setSetting(this.pool, key, String(value));
    };
    await write(SETTING_SLACK_AWAY_DELAY, input.slackAwayDelaySeconds);
    await write(SETTING_SLACK_PRESENT_DELAY, input.slackPresentDelayMinutes);
    this.timingCache = null;
  }

  private timingCache: { timing: AlertTiming; expiresAt: number } | null = null;
  /** The question-alert waits, cached briefly (read every alert tick). */
  async alertTiming(): Promise<AlertTiming> {
    if (this.timingCache && Date.now() < this.timingCache.expiresAt)
      return this.timingCache.timing;
    const delays = await this.getSlackDelays().catch(() => null);
    const timing = delays
      ? {
          awayDelayMs: delays.slackAwayDelaySeconds * 1000,
          presentDelayMs: delays.slackPresentDelayMinutes * 60_000,
        }
      : DEFAULT_ALERT_TIMING;
    this.timingCache = { timing, expiresAt: Date.now() + CACHE_TTL_MS };
    return timing;
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
   * Agent-initiated notification via the notify MCP tool. Forms and thread
   * replies go to Slack now. Otherwise, while the user is in Dispatch it shows
   * there instead (unless urgent), and goes to Slack when they're away.
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

    // The user is in Dispatch: show it there instead of Slack.
    if (!input.urgent && this.presence?.isPresent()) {
      if (this.presence.isViewing(agent.id)) {
        this.recordNotifyTimestamp(agent.id);
        return {
          sent: false,
          inApp: true,
          reason: "User is viewing this agent in Dispatch; not sent to Slack.",
        };
      }
      const shown = this.presence.showInApp(agent, {
        title: input.title,
        message: input.message,
      });
      if (shown > 0) {
        this.recordNotifyTimestamp(agent.id);
        return {
          sent: false,
          inApp: true,
          reason: "User active in Dispatch; shown in-app, not sent to Slack.",
        };
      }
      // No present session could show it: Slack is the only way to reach them.
    }

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
        return note
          ? { sent: true, reason: "Sent to Slack.", note }
          : { sent: true, reason: "Sent to Slack." };
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
