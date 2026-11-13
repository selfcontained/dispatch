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
  /** Bot user id (auth.test user_id), for ignoring self echoes. */
  botUserId?: string;
};
export type SlackBinding = Binding;
/** An inbound Socket Mode envelope already checked against the bound app/team. */
export type SlackInbound = {
  type: "interactive" | "events_api";
  payload: Record<string, any>;
  binding: Binding;
  botUserId: string | null;
};
/** Returned payload is sent in the Socket Mode ack (e.g. modal validation errors). */
export type SlackInboundHandler = (
  inbound: SlackInbound
) => Promise<Record<string, unknown> | void>;
/** The person-facing reason inside a modal errors/update ack payload. */
function lateReason(result: Record<string, unknown> | void) {
  if (!result) return null;
  if (result.response_action === "errors" && result.errors)
    return Object.values(result.errors as Record<string, string>).join(" ");
  if (result.response_action === "update") {
    const blocks = (result.view as { blocks?: any[] } | undefined)?.blocks;
    const text = blocks?.find((b) => b?.text?.text)?.text?.text;
    return typeof text === "string" ? text : "Open Dispatch to answer.";
  }
  return null;
}
export const ANSWER_SCOPES = ["channels:history", "groups:history"];
/** Inline images in Dispatch messages are uploaded privately by the bot. */
export const IMAGE_SCOPES = ["files:write"];
/** Lets a message show the agent as its sender instead of "Dispatch". */
export const IDENTITY_SCOPE = "chat:write.customize";
/** The header block that names the agent inside the message. */
export const WHO_BLOCK_ID = "dispatch_who";
const FORM_METHODS = new Set([
  "conversations.list",
  "files.getUploadURLExternal",
]);
/** Socket Mode requires an ack within 3 seconds. */
const ACK_BUDGET_MS = 2500;
type Credentials = { botToken: string; appToken: string };
export type SlackChannel = { id: string; name: string; private: boolean };
/**
 * The request may have reached Slack (timeout, unreadable reply): whether a
 * message was posted is unknown, so a caller that must not duplicate it
 * should not resend.
 */
export class SlackDeliveryUnknownError extends Error {}
/** Connection errors that mean the request never reached Slack. */
const UNSENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
export class SlackRetryError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Slack delivery rate limited; retry later.");
  }
}
const KEY = "slack_app_binding";
export class SlackAuthError extends Error {}
/**
 * Slack answered and definitively refused the request: nothing was posted.
 * `code` is Slack's own error code (e.g. `invalid_blocks`), safe to log;
 * `slackFile` says the refusal named a `slack_file` reference.
 */
export class SlackRejectedError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly slackFile: boolean
  ) {
    super(message);
  }
}

/** No raw provider errors, credential-bearing socket URLs or response bodies escape this client. */
export class SlackApp {
  private socket?: WebSocket;
  private verifiedSocket?: {
    generation: string;
    revision: number;
    appId: string;
  };
  private socketConnections: number | null = null;
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private revision = 0;
  private backoff = 1000;
  private lastSend = 0;
  private lastDelivery: string | null = null;
  private status = "not_configured";
  private channels: SlackChannel[] = [];
  private botUserId: string | null = null;
  /** Bot scopes Slack reported on the last auth.test; null when unknown. */
  private scopes: string[] | null = null;
  private recheckWork?: Promise<void>;
  private inbound?: SlackInboundHandler;
  private callbackDiagnostic: { stage: string; at: string } | null = null;
  private callbackStageCounts: Record<string, number> = {};
  /** Fixed stage names only: never payloads, credentials or provider errors. */
  recordCallbackStage(
    stage:
      | "identity_unverified"
      | "received"
      | "link_claimed"
      | "accepted"
      | "handler_completed"
      | "handler_failed"
      | "binding_unavailable"
      | "app_mismatch"
      | "team_mismatch"
      | "malformed"
      | "handler_unavailable"
      | "link_received"
      | "link_refused"
      | "link_expired"
      | "link_pending"
      | "link_already_allowed"
  ) {
    this.callbackDiagnostic = { stage, at: new Date().toISOString() };
    this.callbackStageCounts[stage] =
      (this.callbackStageCounts[stage] ?? 0) + 1;
    this.onCallbackDiagnostic?.(this.callbackDiagnostic);
  }
  private onConnected?: () => void;
  private validated?: {
    credentials: Credentials;
    teamId: string;
    teamName: string;
    appId: string;
    botUserId?: string;
  };
  constructor(
    private pool: Pool,
    private transport: typeof fetch = fetch,
    private openSocket: (url: string) => WebSocket = (url) =>
      new WebSocket(url),
    private onCallbackDiagnostic?: (diagnostic: {
      stage: string;
      at: string;
    }) => void
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
          "Content-Type": FORM_METHODS.has(method)
            ? "application/x-www-form-urlencoded"
            : "application/json",
        },
        body: FORM_METHODS.has(method)
          ? new URLSearchParams(
              Object.entries(data).map(
                ([key, value]) => [key, String(value)] as [string, string]
              )
            ).toString()
          : JSON.stringify(data),
      });
    } catch (error) {
      const code = (error as { cause?: { code?: unknown } })?.cause?.code;
      if (typeof code === "string" && UNSENT_CODES.has(code))
        throw new Error("Slack connection failed. Try again.");
      throw new SlackDeliveryUnknownError(
        "Slack connection failed. Try again."
      );
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      throw new SlackRetryError(
        (Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 3600)) : 60) *
          1000
      );
    }
    // A 5xx (often a gateway timeout) can follow a request Slack already
    // processed, so its outcome is unknown; other non-2xx were rejected.
    if (response.status >= 500)
      throw new SlackDeliveryUnknownError(
        "Slack service unavailable. Try again."
      );
    if (!response.ok) throw new Error("Slack service unavailable. Try again.");
    let body: Record<string, any>;
    try {
      body = (await response.json()) as Record<string, any>;
    } catch {
      throw new SlackDeliveryUnknownError("Invalid Slack response.");
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
      // Slack names a refused `slack_file` in `errors` or in
      // response_metadata.messages; only that fact and the code are kept.
      const details = [body.errors, body.response_metadata?.messages]
        .flatMap((list) => (Array.isArray(list) ? list : []))
        .filter((item): item is string => typeof item === "string");
      const code =
        typeof body.error === "string" && /^[a-z0-9_]{1,64}$/.test(body.error)
          ? body.error
          : "unknown";
      throw new SlackRejectedError(
        "Slack request rejected. Check app permissions and channel membership.",
        code,
        details.some((item) => /slack_file|slack file/i.test(item))
      );
    }
    if (method === "auth.test") {
      const header = response.headers.get("x-oauth-scopes");
      this.scopes =
        header === null
          ? null
          : header
              .split(",")
              .map((scope) => scope.trim())
              .filter(Boolean);
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
      const verified = this.verifiedSocket;
      if (
        verified &&
        verified.generation === config.binding.generation &&
        verified.revision === this.revision
      )
        config.binding.appId = verified.appId;
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
      socketConnections: this.socketConnections,
      binding,
      channels: this.channels,
      lastDelivery: this.lastDelivery,
      missingLinkScopes: this.scopes
        ? ["chat:write"].filter((scope) => !this.scopes!.includes(scope))
        : null,
      callbackDiagnostic: this.callbackDiagnostic,
      callbackStageCounts: { ...this.callbackStageCounts },
      missingImageScopes: this.scopes
        ? IMAGE_SCOPES.filter((scope) => !this.scopes!.includes(scope))
        : null,
      // Answering needs thread-reply events; interactivity can't be probed.
      missingAnswerScopes: this.scopes
        ? ANSWER_SCOPES.filter((scope) => !this.scopes!.includes(scope))
        : null,
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
    const appId = await this.readSocketIdentity(url.href);
    // App identity comes only from authenticated hello, never URL query internals.
    if (!appId || typeof auth.team_id !== "string")
      throw new Error("Slack did not return app/workspace identity.");
    this.validated = {
      credentials,
      teamId: auth.team_id,
      teamName: String(auth.team),
      appId,
      ...(typeof auth.user_id === "string" ? { botUserId: auth.user_id } : {}),
    };
    this.channels = await this.listChannels(credentials.botToken);
    return { teamName: String(auth.team), channels: this.channels };
  }
  private readSocketIdentity(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = this.openSocket(url);
      const finish = (appId?: string) => {
        clearTimeout(timer);
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
        if (appId) resolve(appId);
        else
          reject(
            new Error(
              "Slack Socket Mode did not verify its app identity. Try again."
            )
          );
      };
      const timer = setTimeout(() => finish(), 10000);
      socket.onclose = () => finish();
      socket.onerror = () => finish();
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type !== "hello") return;
          const appId = message.connection_info?.app_id;
          finish(
            typeof appId === "string" && /^A[A-Z0-9]+$/.test(appId)
              ? appId
              : undefined
          );
        } catch {
          finish();
        }
      };
    });
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
      ...(candidate.botUserId ? { botUserId: candidate.botUserId } : {}),
    };
    await setSetting(
      this.pool,
      KEY,
      JSON.stringify({ binding, credentials: candidate.credentials })
    );
    this.validated = undefined;
    await this.start();
  }
  /** Probe stored credentials without reconnecting, rewriting tokens or changing generation. */
  recheckPermissions() {
    if (this.recheckWork) return this.recheckWork;
    this.recheckWork = this.performRecheck().finally(() => {
      this.recheckWork = undefined;
    });
    return this.recheckWork;
  }
  private async performRecheck() {
    const config = await this.configuration();
    if (!config) throw new Error("Connect Slack first.");
    const probe = new SlackApp(this.pool, this.transport, this.openSocket);
    const auth = await probe.api(config.credentials.botToken, "auth.test");
    if (auth.team_id !== config.binding.teamId)
      throw new Error(
        "Slack workspace identity changed. Recheck the installation."
      );
    const current = await this.configuration();
    if (
      current?.binding.generation !== config.binding.generation ||
      current.credentials.botToken !== config.credentials.botToken
    )
      throw new Error("Slack installation changed. Recheck again.");
    this.scopes = probe.scopes;
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
  /** Receive interactive/event envelopes. Without a handler they are acked and dropped. */
  setInboundHandler(handler: SlackInboundHandler, onConnected?: () => void) {
    this.inbound = handler;
    this.onConnected = onConnected;
  }
  async currentBinding() {
    return this.binding();
  }
  private async dispatchInbound(
    message: Record<string, any>,
    ack: (payload?: Record<string, unknown>) => void
  ) {
    const diagnose = (
      stage: Parameters<SlackApp["recordCallbackStage"]>[0]
    ) => {
      if (message.type === "interactive") this.recordCallbackStage(stage);
    };
    diagnose("received");
    const inboundRevision = this.revision;
    const handler = this.inbound;
    const payload = message.payload;
    const config = handler
      ? await this.configuration().catch(() => null)
      : null;
    if (inboundRevision !== this.revision || this.stopped) {
      ack();
      return;
    }
    const binding = config?.binding;
    const team =
      message.type === "interactive" ? payload?.team?.id : payload?.team_id;
    // The socket is authenticated by the app token, but bind every payload
    // to the stored installation anyway: wrong app/team is dropped unread.
    if (
      !this.verifiedSocket ||
      this.verifiedSocket.revision !== this.revision ||
      !handler ||
      !binding ||
      !payload ||
      typeof payload !== "object" ||
      payload.api_app_id !== binding.appId ||
      team !== binding.teamId
    ) {
      diagnose(
        !this.verifiedSocket || this.verifiedSocket.revision !== this.revision
          ? "identity_unverified"
          : !handler
            ? "handler_unavailable"
            : !binding
              ? "binding_unavailable"
              : !payload || typeof payload !== "object"
                ? "malformed"
                : payload.api_app_id !== binding.appId
                  ? "app_mismatch"
                  : "team_mismatch"
      );
      ack();
      return;
    }
    diagnose("accepted");
    const inbound: SlackInbound = {
      type: message.type,
      payload,
      binding,
      botUserId: binding.botUserId ?? this.botUserId,
    };
    if (message.type === "interactive" && payload.type === "view_submission") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = handler(inbound).catch(() => {
        diagnose("handler_failed");
        return undefined;
      });
      const timedOut = Symbol("timeout");
      const result = await Promise.race([
        work,
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), ACK_BUDGET_MS);
        }),
      ]);
      clearTimeout(timer);
      if (result !== timedOut) {
        ack(result || undefined);
        return;
      }
      // Slack has closed the modal by now: a late refusal must still reach
      // the person, or they'd assume it was recorded.
      ack();
      const late = await work;
      const reason = lateReason(late);
      if (reason && typeof payload.user?.id === "string")
        await this.postEphemeral(
          payload.user.id,
          `Not recorded: ${reason}`
        ).catch(() => {});
      return;
    }
    ack();
    try {
      await handler(inbound);
      // Preserve the more specific link outcome reported by the handler.
      if (this.callbackDiagnostic?.stage === "accepted")
        diagnose("handler_completed");
    } catch {
      diagnose("handler_failed");
      if (
        message.type === "interactive" &&
        payload.type === "block_actions" &&
        payload.actions?.[0]?.action_id === "dispatch_link" &&
        typeof payload.user?.id === "string"
      ) {
        await this.postEphemeral(
          payload.user.id,
          "Dispatch couldn't complete this link request. Check the Socket Mode callback status in Dispatch Settings, then request a fresh link. Nothing was allowed."
        ).catch(() => {});
      }
    }
  }
  stop() {
    this.stopped = true;
    this.verifiedSocket = undefined;
    this.socketConnections = null;
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
      this.verifiedSocket = undefined;
      this.socketConnections = null;
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
      // Also refreshes granted scopes after a manifest update + reinstall.
      const auth = await this.api(credentials.botToken, "auth.test");
      if (typeof auth.user_id === "string") this.botUserId = auth.user_id;
      const response = await this.api(
        credentials.appToken,
        "apps.connections.open"
      );
      const url = this.socketUrl(response.url);
      if (this.stopped || revision !== this.revision) return;
      const socket = this.openSocket(url.href);
      this.socket = socket;
      socket.onmessage = (event) => {
        if (revision !== this.revision) return;
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "hello") {
            this.verifiedSocket = undefined;
            const appId = message.connection_info?.app_id;
            // Older versions stored an opaque URL query as appId. Resolve it
            // from this authenticated socket, preserving the installation generation.
            const legacy = /^[0-9a-f]{64}$/.test(binding.appId);
            if (
              typeof appId !== "string" ||
              !/^A[A-Z0-9]+$/.test(appId) ||
              (!legacy && appId !== binding.appId)
            ) {
              this.status = "app_identity_mismatch";
              socket.onclose = null;
              socket.close();
              return;
            }
            this.verifiedSocket = {
              generation: binding.generation,
              revision,
              appId,
            };
            this.socketConnections =
              Number.isInteger(message.num_connections) &&
              message.num_connections > 0
                ? message.num_connections
                : null;
            this.status = "connected";
            this.backoff = 1000;
            this.onConnected?.();
          }
          if (typeof message.envelope_id === "string") {
            const envelopeId = message.envelope_id;
            const ack = (payload?: Record<string, unknown>) => {
              if (revision !== this.revision) return;
              socket.send(
                JSON.stringify(
                  payload
                    ? { envelope_id: envelopeId, payload }
                    : { envelope_id: envelopeId }
                )
              );
            };
            if (message.type === "interactive" || message.type === "events_api")
              void this.dispatchInbound(message, ack);
            else ack();
          }
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
  /** Post Block Kit to the bound channel (plain-text fallback required by Slack). */
  /**
   * The agent is the message's sender (chat:write.customize), so the name is
   * not repeated inside the message. An install that hasn't granted that
   * scope would post as "Dispatch" with no name at all, so it keeps the line.
   */
  private sender(blocks: unknown[], username?: string) {
    if (!username || this.hasScope(IDENTITY_SCOPE) !== true) return { blocks };
    return {
      username: username.slice(0, 80),
      blocks: blocks.filter(
        (b) => (b as { block_id?: string })?.block_id !== WHO_BLOCK_ID
      ),
    };
  }
  async postBlocks(
    input: {
      text: string;
      blocks: unknown[];
      threadTs?: string;
      /** The agent to show as the sender, when the app may customize it. */
      username?: string;
    },
    expectedGeneration?: string
  ) {
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
      text: input.text.slice(0, 3000),
      ...this.sender(input.blocks, input.username),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
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
  /**
   * Wait until the local 1 msg/s guard would let a post through. For a
   * same-message retry after Slack definitively rejected the first try.
   */
  async waitForSendSlot() {
    const wait = 1000 - (Date.now() - this.lastSend);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  /** Whether Slack granted a scope on the last auth.test; null when unknown. */
  hasScope(scope: string): boolean | null {
    return this.scopes ? this.scopes.includes(scope) : null;
  }
  /**
   * Upload an image privately with the bot token (files.uploadV2 flow,
   * shared to no channel) and return its file id, to show inline via an
   * image block's `slack_file`. The file is only visible where the bot
   * posts a message that shows it.
   */
  async uploadImage(bytes: Uint8Array, filename: string) {
    const config = await this.configuration();
    if (!config) throw new Error("Slack app is not configured.");
    const token = config.credentials.botToken;
    const target = await this.api(token, "files.getUploadURLExternal", {
      filename,
      length: bytes.byteLength,
    });
    const uploadUrl = String(target.upload_url ?? "");
    const fileId = String(target.file_id ?? "");
    // Only ever send bytes to Slack's own upload host.
    const host = (() => {
      try {
        const u = new URL(uploadUrl);
        return u.protocol === "https:" ? u.hostname : "";
      } catch {
        return "";
      }
    })();
    if (!fileId || !(host === "slack.com" || host.endsWith(".slack.com")))
      throw new Error("Slack returned an unexpected upload target.");
    let uploaded: Response;
    try {
      uploaded = await this.transport(uploadUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        body: bytes,
      });
    } catch {
      throw new Error("Slack image upload failed.");
    }
    if (!uploaded.ok) throw new Error("Slack image upload failed.");
    await this.api(token, "files.completeUploadExternal", {
      files: [{ id: fileId, title: filename }],
    });
    return fileId;
  }
  /**
   * Download a file a person shared in the bound workspace (needs files:read).
   * The bot token is only ever sent to Slack's own file host.
   */
  async downloadFile(url: string, maxBytes: number): Promise<Uint8Array> {
    const config = await this.configuration();
    if (!config) throw new Error("Slack app is not configured.");
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error("Slack returned an unexpected file location.");
    }
    if (
      target.protocol !== "https:" ||
      !(
        target.hostname === "files.slack.com" ||
        target.hostname.endsWith(".slack.com")
      )
    )
      throw new Error("Slack returned an unexpected file location.");
    let response: Response;
    try {
      response = await this.transport(target.href, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${config.credentials.botToken}` },
      });
    } catch {
      throw new Error("Slack file download failed.");
    }
    if (!response.ok) throw new Error("Slack file download failed.");
    // Without files:read Slack serves its sign-in page instead of the file.
    if ((response.headers.get("content-type") ?? "").startsWith("text/html"))
      throw new Error("Slack file download needs the files:read permission.");
    // Never hold more than maxBytes: refuse a declared oversize up front and
    // stop reading the moment the running total passes the cap.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Slack file is too large.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Slack file download failed.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Slack file is too large.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  /** Only ever targets the bound channel; callers pass the stored ts. */
  async updateMessage(
    ts: string,
    text: string,
    blocks: unknown[],
    username?: string
  ) {
    const config = await this.configuration();
    if (!config) throw new Error("Slack app is not configured.");
    // The sender can't change on update; only the name line follows it.
    const { blocks: shown } = this.sender(blocks, username);
    await this.api(config.credentials.botToken, "chat.update", {
      channel: config.binding.channelId,
      ts,
      text: text.slice(0, 3000),
      blocks: shown,
    });
  }
  async postEphemeral(user: string, text: string, threadTs?: string) {
    const config = await this.configuration();
    if (!config) throw new Error("Slack app is not configured.");
    await this.api(config.credentials.botToken, "chat.postEphemeral", {
      channel: config.binding.channelId,
      user,
      text: text.slice(0, 3000),
      blocks: [
        {
          type: "section",
          text: { type: "plain_text", text: text.slice(0, 3000), emoji: false },
        },
      ],
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }
  async openView(triggerId: string, view: unknown) {
    const config = await this.configuration();
    if (!config) throw new Error("Slack app is not configured.");
    await this.api(config.credentials.botToken, "views.open", {
      trigger_id: triggerId,
      view,
    });
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
