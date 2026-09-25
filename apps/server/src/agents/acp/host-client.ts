import type {
  AgentPermissionRequest,
  AgentPermissionsResponse,
} from "@dispatch/shared";
import type { PromptSource } from "./prompt-source.js";
import net from "node:net";

import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import type { DriverLogger } from "./driver.js";
import {
  type ClientMessage,
  encodeMessage,
  type HostMessage,
  type JournalEntry,
  ndjsonDecoder,
} from "./host-protocol.js";

const CONNECT_TIMEOUT_MS = 5_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export type HostWelcome = Extract<HostMessage, { type: "welcome" }>;

export type HostClientDeps = {
  agentId: string;
  socketPath: string;
  logger: DriverLogger;
  /** The newest journal seq already applied; the host replays after it. */
  fromSeq: () => number;
  journalId: () => string | null;
  onEvent: (entry: JournalEntry) => void;
  /** The engine is up and the session is known. Fires on every reconnect too. */
  onWelcome: (welcome: HostWelcome) => void;
  /** The socket closed and reconnection is not possible or was stopped. */
  onGone: (reason: string) => void;
  onPermissions?: (requests: AgentPermissionRequest[]) => void;
};

/**
 * The server's end of one agent's host socket. Keeps the connection up for
 * as long as the agent is meant to be running: a dropped socket reconnects
 * with backoff and a `hello` that names the last seq applied, so replay
 * makes the reconnect idempotent. `close()` stops reconnecting.
 */
export class HostClient {
  private permissions: AgentPermissionRequest[] = [];
  private readonly pendingPermissions = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  private socket: net.Socket | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private readonly pendingPrompts = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  private readonly pendingConfig = new Map<
    string,
    {
      resolve: (options: SessionConfigOption[]) => void;
      reject: (err: Error) => void;
    }
  >();
  private welcomeWaiters: Array<{
    resolve: (w: HostWelcome) => void;
    reject: (err: Error) => void;
  }> = [];
  private lastWelcome: HostWelcome | null = null;
  private sentFromSeq = 0;
  private reconnectingForLegacyReplay = false;

  constructor(private readonly deps: HostClientDeps) {}

  get welcome(): HostWelcome | null {
    return this.lastWelcome;
  }

  /**
   * Connect and complete the hello. Resolves with the first welcome whose
   * engine is running; rejects if the host answers with an error, or after
   * `timeoutMs` without a running engine.
   */
  async connect(
    timeoutMs: number,
    /** Stop waiting early: the host process is known to be gone. */
    abandoned: () => boolean = () => false
  ): Promise<HostWelcome> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline && !this.closed) {
      if (abandoned()) {
        throw new Error(
          lastError || "the agent host exited before it answered"
        );
      }
      try {
        await this.dial();
        return await this.awaitRunningWelcome(deadline - Date.now());
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (this.closed || /^engine failed:/.test(lastError)) {
          throw new Error(lastError);
        }
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_BASE_MS));
      }
    }
    throw new Error(lastError || "the agent host did not answer in time");
  }

  /** Reconnect to a host that is already running; false when it is not there. */
  async attach(timeoutMs: number): Promise<boolean> {
    try {
      await this.connect(timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  private awaitRunningWelcome(timeoutMs: number): Promise<HostWelcome> {
    if (this.lastWelcome?.running) return Promise.resolve(this.lastWelcome);
    return new Promise<HostWelcome>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.welcomeWaiters = this.welcomeWaiters.filter((w) => w !== waiter);
          reject(new Error("the agent host did not report a running engine"));
        },
        Math.max(0, timeoutMs)
      );
      const waiter = {
        resolve: (w: HostWelcome) => {
          clearTimeout(timer);
          resolve(w);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.welcomeWaiters.push(waiter);
    });
  }

  private dial(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.deps.socketPath);
      const timer = setTimeout(() => {
        socket.destroy(new Error("connect timed out"));
      }, CONNECT_TIMEOUT_MS);
      socket.once("connect", () => {
        clearTimeout(timer);
        this.attempts = 0;
        this.socket = socket;
        this.wire(socket);
        this.sentFromSeq = this.deps.fromSeq();
        socket.write(
          encodeMessage({
            type: "hello",
            fromSeq: this.sentFromSeq,
            journalId: this.deps.journalId(),
          } satisfies ClientMessage)
        );
        resolve();
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        if (this.socket !== socket) reject(err);
      });
    });
  }

  private wire(socket: net.Socket): void {
    const decode = ndjsonDecoder<HostMessage>();
    socket.on("data", (chunk) => {
      for (const message of decode(chunk)) this.handle(message);
    });
    socket.on("error", (err) => {
      this.deps.logger.debug(
        { err: String(err), agentId: this.deps.agentId },
        "host socket error"
      );
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending(new Error("the agent host connection closed"));
      if (this.closed) return;
      this.scheduleReconnect();
    });
  }

  private handle(message: HostMessage): void {
    switch (message.type) {
      case "welcome":
        if (
          !message.journalId &&
          message.journalSeq < this.sentFromSeq &&
          !this.reconnectingForLegacyReplay
        ) {
          // An older host does not know journal identities or replay when
          // fromSeq exceeds its head. Let the runtime reset the cursor,
          // then reconnect with hello(0) before any live event is applied.
          this.reconnectingForLegacyReplay = true;
          this.deps.onWelcome(message);
          this.socket?.destroy();
          return;
        }
        this.reconnectingForLegacyReplay = false;
        this.lastWelcome = message;
        const previousPermissions = this.permissions;
        this.permissions = message.permissions ?? [];
        if (message.running) {
          const waiters = this.welcomeWaiters;
          this.welcomeWaiters = [];
          for (const w of waiters) w.resolve(message);
        }
        this.deps.onWelcome(message);
        if (this.permissions.length || previousPermissions.length)
          this.deps.onPermissions?.(this.permissions);
        return;
      case "event":
        if (this.reconnectingForLegacyReplay) return;
        this.deps.onEvent({
          seq: message.seq,
          at: message.at,
          event: message.event,
        });
        return;
      case "prompt_accepted": {
        const pending = this.pendingPrompts.get(message.id);
        if (pending) {
          this.pendingPrompts.delete(message.id);
          pending.resolve();
        }
        return;
      }
      case "permissions":
        this.permissions = message.requests;
        this.deps.onPermissions?.(this.permissions);
        return;
      case "permission_answered": {
        const pending = this.pendingPermissions.get(message.id);
        this.pendingPermissions.delete(message.id);
        pending?.resolve();
        return;
      }
      case "config_set": {
        const pending = this.pendingConfig.get(message.id);
        if (pending) {
          this.pendingConfig.delete(message.id);
          pending.resolve(message.options);
        }
        return;
      }
      case "error": {
        if (message.id) {
          const pending =
            this.pendingPrompts.get(message.id) ??
            this.pendingConfig.get(message.id) ??
            this.pendingPermissions.get(message.id);
          if (pending) {
            this.pendingPrompts.delete(message.id);
            this.pendingConfig.delete(message.id);
            this.pendingPermissions.delete(message.id);
            pending.reject(new Error(message.message));
          }
          return;
        }
        // An error with no id is the engine failing to start.
        const waiters = this.welcomeWaiters;
        this.welcomeWaiters = [];
        for (const w of waiters) {
          w.reject(new Error(`engine failed: ${message.message}`));
        }
        return;
      }
      case "pong":
        return;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.attempts, 5)
    );
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.dial().catch((err) => {
        if (this.attempts >= 6) {
          this.deps.onGone(err instanceof Error ? err.message : String(err));
          return;
        }
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private failPending(err: Error): void {
    for (const pending of this.pendingPermissions.values()) pending.reject(err);
    this.pendingPermissions.clear();
    for (const pending of this.pendingPrompts.values()) pending.reject(err);
    this.pendingPrompts.clear();
    for (const pending of this.pendingConfig.values()) pending.reject(err);
    this.pendingConfig.clear();
  }

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("the agent host is not connected");
    }
    this.socket.write(encodeMessage(message));
  }

  /** Resolves once the adapter has accepted the prompt. */
  prompt(id: string, text: string, source?: PromptSource): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingPrompts.set(id, { resolve, reject });
      try {
        this.send({ type: "prompt", id, text, ...(source ? { source } : {}) });
      } catch (err) {
        this.pendingPrompts.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Resolves with the engine's options once it took the value. */
  setConfig(
    id: string,
    configId: string,
    value: string
  ): Promise<SessionConfigOption[]> {
    return new Promise<SessionConfigOption[]>((resolve, reject) => {
      this.pendingConfig.set(id, { resolve, reject });
      try {
        this.send({ type: "set_config", id, configId, value });
      } catch (err) {
        this.pendingConfig.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  getPermissions(): AgentPermissionsResponse {
    return {
      connected: this.isConnected() && !!this.lastWelcome?.running,
      requests: this.permissions,
    };
  }

  answerPermission(
    id: string,
    requestId: string,
    optionId: string | null
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(id);
        reject(
          new Error(
            "The agent host did not confirm the permission response. Refresh to check its state."
          )
        );
      }, 10_000);
      this.pendingPermissions.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.send({ type: "answer_permission", id, requestId, optionId });
      } catch (err) {
        this.pendingPermissions
          .get(id)
          ?.reject(err instanceof Error ? err : new Error(String(err)));
        this.pendingPermissions.delete(id);
      }
    });
  }

  cancel(): void {
    this.send({ type: "cancel" });
  }

  shutdown(force: boolean): void {
    this.send({ type: "shutdown", force });
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Stop reconnecting and drop the socket. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failPending(new Error("the agent host client was closed"));
    this.socket?.destroy();
    this.socket = null;
  }
}
