import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { getSetting, setSetting, deleteSetting } from "../db/settings.js";

type Binding = {
  generation: string;
  enabledAt: string;
  teamId: string;
  teamName: string;
  appId: string;
  channelId: string;
  channelName: string;
  baseUrl: string;
};
type Credentials = { botToken: string; appToken: string };
export type SlackChannel = { id: string; name: string; private: boolean };
export class SlackRetryError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Slack delivery rate limited; retry later.");
  }
}
const KEY = "slack_app_binding";
class SlackAuthError extends Error {}

/** No raw provider errors, credential-bearing socket URLs or response bodies escape this client. */
export class SlackApp {
  private socket?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private revision = 0;
  private backoff = 1000;
  private lastSend = 0;
  private lastDelivery: string | null = null;
  private status = "not_configured";
  private channels: SlackChannel[] = [];
  private validated?: {
    credentials: Credentials;
    teamId: string;
    teamName: string;
    appId: string;
  };
  constructor(
    private pool: Pool,
    private transport: typeof fetch = fetch,
    private openSocket: (url: string) => WebSocket = (url) => new WebSocket(url)
  ) {}

  private async api(
    token: string,
    method: string,
    data: Record<string, unknown> = {}
  ) {
    let response: Response;
    try {
      response = await this.transport(`https://slack.com/api/${method}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type":
            method === "conversations.list"
              ? "application/x-www-form-urlencoded"
              : "application/json",
        },
        body:
          method === "conversations.list"
            ? new URLSearchParams(
                Object.entries(data).map(
                  ([key, value]) => [key, String(value)] as [string, string]
                )
              ).toString()
            : JSON.stringify(data),
      });
    } catch {
      throw new Error("Slack connection failed. Try again.");
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      throw new SlackRetryError(
        (Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 3600)) : 60) *
          1000
      );
    }
    if (!response.ok) throw new Error("Slack service unavailable. Try again.");
    let body: Record<string, any>;
    try {
      body = (await response.json()) as Record<string, any>;
    } catch {
      throw new Error("Invalid Slack response.");
    }
    if (!body.ok) {
      if (
        [
          "invalid_auth",
          "token_revoked",
          "account_inactive",
          "not_authed",
        ].includes(body.error)
      ) {
        throw new SlackAuthError(
          "Slack credentials rejected. Replace tokens in Settings."
        );
      }
      throw new Error(
        "Slack request rejected. Check app permissions and channel membership."
      );
    }
    return body;
  }
  private async configuration(): Promise<{
    binding: Binding;
    credentials: Credentials;
  } | null> {
    const raw = await getSetting(this.pool, KEY);
    if (!raw) return null;
    try {
      const config = JSON.parse(raw);
      if (
        !config.binding?.generation ||
        !config.credentials?.botToken ||
        !config.credentials?.appToken
      )
        throw new Error();
      return config;
    } catch {
      throw new Error(
        "Stored Slack configuration is invalid. Disconnect and configure again."
      );
    }
  }
  private async binding() {
    return (await this.configuration())?.binding ?? null;
  }
  async settings() {
    const binding = await this.binding();
    return {
      configured: !!binding,
      status: this.status,
      binding,
      channels: this.channels,
      lastDelivery: this.lastDelivery,
    };
  }
  async validate(credentials: Credentials) {
    this.validated = undefined;
    if (
      !/^xoxb-[A-Za-z0-9-]+$/.test(credentials.botToken) ||
      !/^xapp-[A-Za-z0-9-]+$/.test(credentials.appToken)
    )
      throw new Error("Enter a bot token (xoxb) and app token (xapp).");
    const auth = await this.api(credentials.botToken, "auth.test");
    const connection = await this.api(
      credentials.appToken,
      "apps.connections.open"
    );
    const url = this.socketUrl(connection.url);
    const appId = url.searchParams.get("app_id");
    // Minimal bot scopes cannot query bots.info (requires users:read).
    // Bind the socket app and authenticated posting workspace separately;
    // this foundation never executes inbound payloads.
    if (!appId || typeof auth.team_id !== "string")
      throw new Error("Slack did not return app/workspace identity.");
    this.validated = {
      credentials,
      teamId: auth.team_id,
      teamName: String(auth.team),
      appId,
    };
    this.channels = await this.listChannels(credentials.botToken);
    return { teamName: String(auth.team), channels: this.channels };
  }
  private socketUrl(value: unknown) {
    if (typeof value !== "string")
      throw new Error("Slack did not return a Socket Mode connection.");
    const url = new URL(value);
    if (
      url.protocol !== "wss:" ||
      !url.hostname.endsWith(".slack.com") ||
      url.username ||
      url.password
    )
      throw new Error("Invalid Slack socket endpoint.");
    return url;
  }
  private async listChannels(token: string) {
    const channels: SlackChannel[] = [];
    let cursor = "";
    const cursors = new Set<string>();
    let pages = 0;
    do {
      if (++pages > 50 || cursors.has(cursor))
        throw new Error(
          "Slack channel pagination did not complete. Try again."
        );
      cursors.add(cursor);
      const page = await this.api(token, "conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const c of page.channels ?? [])
        if (
          c.is_member &&
          !c.is_archived &&
          typeof c.id === "string" &&
          typeof c.name === "string"
        )
          channels.push({ id: c.id, name: c.name, private: !!c.is_private });
      cursor = page.response_metadata?.next_cursor ?? "";
      if (channels.length > 5000)
        throw new Error("Too many Slack channels. Narrow app membership.");
    } while (cursor);
    return channels;
  }
  async enable(channelId: string, baseUrl: string) {
    const candidate = this.validated;
    if (!candidate) throw new Error("Validate both tokens first.");
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) throw new Error("Choose a channel the app has joined.");
    const url = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Enter a Dispatch web base URL without credentials or query parameters."
      );
    const binding: Binding = {
      generation: randomUUID(),
      enabledAt: new Date().toISOString(),
      teamId: candidate.teamId,
      teamName: candidate.teamName,
      appId: candidate.appId,
      channelId,
      channelName: channel.name,
      baseUrl: url.href.replace(/\/$/, ""),
    };
    await setSetting(
      this.pool,
      KEY,
      JSON.stringify({ binding, credentials: candidate.credentials })
    );
    this.validated = undefined;
    await this.start();
  }
  async refreshChannels() {
    const config = await this.configuration();
    const token =
      this.validated?.credentials.botToken ?? config?.credentials.botToken;
    if (!token) throw new Error("Validate tokens first.");
    this.channels = await this.listChannels(token);
    return this.channels;
  }
  async disconnect() {
    this.stop();
    this.validated = undefined;
    this.channels = [];
    await deleteSetting(this.pool, KEY);
    this.status = "disabled";
  }
  stop() {
    this.stopped = true;
    this.revision++;
    clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.socket?.close();
    this.socket = undefined;
  }
  async start() {
    this.stop();
    this.stopped = false;
    const revision = this.revision;
    this.status = "connecting";
    const retry = () => {
      if (this.stopped || revision !== this.revision || this.reconnect) return;
      this.status = "reconnecting";
      this.reconnect = setTimeout(() => {
        this.reconnect = undefined;
        void this.start();
      }, this.backoff);
      this.reconnect.unref();
      this.backoff = Math.min(this.backoff * 2, 60000);
    };
    try {
      const config = await this.configuration();
      if (!config) {
        this.status = "not_configured";
        return;
      }
      const { binding, credentials } = config;
      const response = await this.api(
        credentials.appToken,
        "apps.connections.open"
      );
      const url = this.socketUrl(response.url);
      if (url.searchParams.get("app_id") !== binding.appId)
        throw new Error("Slack app identity changed.");
      if (this.stopped || revision !== this.revision) return;
      const socket = this.openSocket(url.href);
      this.socket = socket;
      socket.onmessage = (event) => {
        if (revision !== this.revision) return;
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "hello") {
            this.status = "connected";
            this.backoff = 1000;
          }
          // Transport receipt only. This foundation executes no external actions.
          if (typeof message.envelope_id === "string")
            socket.send(JSON.stringify({ envelope_id: message.envelope_id }));
          if (message.type === "disconnect") {
            socket.close();
            retry();
          }
        } catch {
          /* Ignore malformed/unsupported envelopes without logging their contents. */
        }
      };
      socket.onclose = retry;
      socket.onerror = () => {
        socket.close();
        retry();
      };
    } catch (error) {
      if (error instanceof SlackAuthError) this.status = "credentials_rejected";
      else retry();
    }
  }
  async send(text: string, expectedGeneration?: string) {
    const config = await this.configuration();
    if (!config) throw new Error("Slack app is not configured.");
    const { binding, credentials } = config;
    if (expectedGeneration && binding.generation !== expectedGeneration)
      throw new Error(
        "Slack destination changed; notification requires revalidation."
      );
    if (Date.now() - this.lastSend < 1000) throw new SlackRetryError(1000);
    this.lastSend = Date.now();
    const result = await this.api(credentials.botToken, "chat.postMessage", {
      channel: binding.channelId,
      text: text
        .slice(0, 3000)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;"),
      mrkdwn: false,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    });
    this.lastDelivery = new Date().toISOString();
    return {
      channelId: binding.channelId,
      timestamp: String(result.ts),
      generation: binding.generation,
    };
  }
}
