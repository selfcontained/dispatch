import type { BackgroundSnapshot } from "@dispatch/shared";
import type { AgentMcpInventoryResponse } from "@dispatch/shared";
import type {
  AgentPermissionRequest,
  AgentPermissionsResponse,
} from "@dispatch/shared";
import type { PromptImage, PromptSource } from "./prompt-source.js";

import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { isDeepStrictEqual } from "node:util";

import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import type { DriverLogger } from "./driver.js";
import {
  type ClientMessage,
  encodeMessage,
  type HostMessage,
  type JournalEntry,
  type PromptReceiptState,
  ndjsonDecoder,
} from "./host-protocol.js";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const QUIESCE_TIMEOUT_MS = 2_000;

type QuiesceReply = Extract<
  HostMessage,
  { type: "quiesce_result" | "quiesce_shutdown_result" }
>;

export type HostQuiesceLease = {
  current(): boolean;
  release(): void;
  shutdown(): Promise<boolean>;
};

export type HostWelcome = Extract<HostMessage, { type: "welcome" }>;

const UNKNOWN_EXECUTION =
  "Runner connection dropped before acknowledgement; execution is unknown.";

export class UpdateAcknowledgementLost extends Error {
  constructor(readonly reattached: Promise<HostWelcome | null>) {
    super(UNKNOWN_EXECUTION);
  }
}

export type HostClientDeps = {
  agentId: string;
  remote: boolean;
  openSocket: () => Promise<Duplex>;
  reconnectError?: (error: unknown) => "retry" | "gone" | undefined;
  onReady?: () => void;
  /** The active runner update's deadline, sampled when the socket drops. */
  updateDeadline?: () => number | undefined;
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
  private pendingQuiesce?: {
    id: string;
    finish(reply?: QuiesceReply): void;
  };
  private readonly pendingBackground = new Map<
    string,
    {
      resolve: (value: BackgroundSnapshot) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly pendingInventory = new Map<
    string,
    {
      resolve: (result: AgentMcpInventoryResponse) => void;
      reject: (err: Error) => void;
    }
  >();
  private readonly pendingSteers = new Map<
    string,
    {
      resolve: (outcome: "injected" | "promptRequired") => void;
      reject: (err: Error) => void;
    }
  >();
  private readonly pendingInterrupts = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  private permissions: AgentPermissionRequest[] = [];
  private readonly pendingPermissions = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  private socket: Duplex | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private readonly pendingPrompts = new Map<
    string,
    {
      resolve: (outcome: "accepted" | "deferred") => void;
      reject: (err: Error) => void;
    }
  >();
  private readonly pendingConfig = new Map<
    string,
    {
      resolve: (options: SessionConfigOption[]) => void;
      reject: (err: Error) => void;
    }
  >();
  private welcomeWaiters: Array<{
    requireReplay: boolean;
    resolve: (w: HostWelcome) => void;
    reject: (err: Error) => void;
  }> = [];
  private lastWelcome: HostWelcome | null = null;
  private sentFromSeq = 0;
  private replayReady = false;
  private reconnectingForLegacyReplay = false;
  private finishUpdateReattach?: (welcome: HostWelcome | null) => void;
  private readonly pendingReceipts = new Map<
    string,
    (receipt?: Extract<HostMessage, { type: "prompt_receipt_result" }>) => void
  >();

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
    abandoned: () => boolean = () => false,
    requireReplay = false
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
        return await this.awaitRunningWelcome(
          deadline - Date.now(),
          requireReplay
        );
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

  private awaitRunningWelcome(
    timeoutMs: number,
    requireReplay: boolean
  ): Promise<HostWelcome> {
    if (this.lastWelcome?.running && (!requireReplay || this.isReady()))
      return Promise.resolve(this.lastWelcome);
    return new Promise<HostWelcome>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.welcomeWaiters = this.welcomeWaiters.filter((w) => w !== waiter);
          reject(new Error("the agent host did not report a running engine"));
        },
        Math.max(0, timeoutMs)
      );
      const waiter = {
        requireReplay,
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

  private async dial(): Promise<void> {
    const socket = await this.deps.openSocket();
    if (this.closed) {
      socket.destroy();
      throw new Error("the agent host client was closed");
    }
    this.connected(socket);
  }

  private connected(socket: Duplex): void {
    this.attempts = 0;
    this.lastWelcome = null;
    this.replayReady = !this.deps.remote;
    this.socket = socket;
    this.wire(socket);
    this.sentFromSeq = this.deps.fromSeq();
    this.send({
      type: "hello",
      fromSeq: this.sentFromSeq,
      journalId: this.deps.journalId(),
      ...(this.deps.remote ? { replayComplete: true } : {}),
    });
  }

  private wire(socket: Duplex): void {
    const decode = ndjsonDecoder<HostMessage>();
    socket.on("data", (chunk) => {
      for (const message of decode(chunk)) {
        if (socket.destroyed || this.socket !== socket) break;
        if (
          this.deps.remote &&
          ((message.type === "welcome" &&
            (message.agentId !== this.deps.agentId || !message.journalId)) ||
            (message.type === "event" &&
              (!this.lastWelcome ||
                message.event?.agentId !== this.deps.agentId ||
                (message.journalId !== undefined &&
                  message.journalId !== this.lastWelcome.journalId) ||
                !Number.isSafeInteger(message.seq) ||
                message.seq < 1)))
        ) {
          socket.destroy();
          break;
        }
        this.handle(message);
      }
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
      // Only operations pending at the update disconnect get this exception
      // to the normal ambiguous-loss policy. An incomplete attach leaves
      // the original recovery waiting for a complete journal replay.
      const deadline = this.deps.remote
        ? this.deps.updateDeadline?.()
        : undefined;
      const recovery =
        !this.finishUpdateReattach &&
        deadline !== undefined &&
        deadline > Date.now() &&
        (this.pendingPrompts.size || this.pendingPermissions.size)
          ? new UpdateAcknowledgementLost(this.awaitUpdateReattach(deadline))
          : undefined;
      this.failPending(
        new Error(
          this.deps.remote
            ? UNKNOWN_EXECUTION
            : "the agent host connection closed"
        ),
        recovery
      );
      if (this.closed) return;
      this.scheduleReconnect();
    });
  }

  private awaitUpdateReattach(deadline: number): Promise<HostWelcome | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.finishUpdateReattach?.(null),
        deadline - Date.now()
      );
      timer.unref?.();
      this.finishUpdateReattach = (welcome) => {
        clearTimeout(timer);
        this.finishUpdateReattach = undefined;
        resolve(welcome);
      };
    });
  }

  private resolveWelcomeWaiters(): void {
    const welcome = this.lastWelcome;
    if (!welcome?.running) return;
    const waiters = this.welcomeWaiters;
    this.welcomeWaiters = [];
    for (const waiter of waiters) {
      if (waiter.requireReplay && !this.isReady())
        this.welcomeWaiters.push(waiter);
      else waiter.resolve(welcome);
    }
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
        this.resolveWelcomeWaiters();
        this.deps.onWelcome(message);

        if (this.permissions.length || previousPermissions.length)
          this.deps.onPermissions?.(this.permissions);
        return;
      case "replay_complete":
        this.replayReady = true;
        this.resolveWelcomeWaiters();
        this.finishUpdateReattach?.(this.isReady() ? this.lastWelcome : null);
        this.deps.onReady?.();
        return;
      case "event":
        if (this.reconnectingForLegacyReplay) return;
        this.deps.onEvent({
          seq: message.seq,
          at: message.at,
          event: message.event,
        });
        return;
      case "quiesce_result":
      case "quiesce_shutdown_result":
        if (this.pendingQuiesce?.id === message.id)
          this.pendingQuiesce.finish(message);
        return;
      case "background_work_result": {
        const pending = this.pendingBackground.get(message.id);
        this.pendingBackground.delete(message.id);
        pending?.resolve(message.result);
        return;
      }
      case "mcp_inventory_result": {
        const pending = this.pendingInventory.get(message.id);
        this.pendingInventory.delete(message.id);
        pending?.resolve(message.result);
        return;
      }
      case "steer_result": {
        const pending = this.pendingSteers.get(message.id);
        this.pendingSteers.delete(message.id);
        pending?.resolve(message.outcome);
        return;
      }
      case "interrupt_result": {
        const pending = this.pendingInterrupts.get(message.id);
        this.pendingInterrupts.delete(message.id);
        pending?.resolve();
        return;
      }
      case "prompt_receipt_result":
        this.pendingReceipts.get(message.id)?.(message);
        return;
      case "prompt_accepted":
      case "prompt_deferred": {
        const pending = this.pendingPrompts.get(message.id);
        if (pending) {
          this.pendingPrompts.delete(message.id);
          pending.resolve(
            message.type === "prompt_accepted" ? "accepted" : "deferred"
          );
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
          this.pendingReceipts.get(message.id)?.();
          const pending =
            this.pendingBackground.get(message.id) ??
            this.pendingInventory.get(message.id) ??
            this.pendingInterrupts.get(message.id) ??
            this.pendingSteers.get(message.id) ??
            this.pendingPrompts.get(message.id) ??
            this.pendingConfig.get(message.id) ??
            this.pendingPermissions.get(message.id);
          if (pending) {
            this.pendingBackground.delete(message.id);
            this.pendingInventory.delete(message.id);
            this.pendingInterrupts.delete(message.id);
            this.pendingSteers.delete(message.id);
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
        const disposition = this.deps.reconnectError?.(err);
        if (
          disposition === "gone" ||
          (this.attempts >= 6 && disposition !== "retry")
        ) {
          this.deps.onGone(err instanceof Error ? err.message : String(err));
          return;
        }
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private failPending(err: Error, recovery?: UpdateAcknowledgementLost): void {
    this.pendingQuiesce?.finish();
    for (const finish of this.pendingReceipts.values()) finish();
    for (const pending of this.pendingBackground.values()) pending.reject(err);
    this.pendingBackground.clear();
    for (const pending of this.pendingInventory.values()) pending.reject(err);
    this.pendingInventory.clear();
    for (const pending of this.pendingInterrupts.values()) pending.reject(err);
    this.pendingInterrupts.clear();
    for (const pending of this.pendingSteers.values()) pending.reject(err);
    this.pendingSteers.clear();
    for (const pending of this.pendingPermissions.values())
      pending.reject(recovery ?? err);
    this.pendingPermissions.clear();
    for (const pending of this.pendingPrompts.values())
      pending.reject(recovery ?? err);
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

  async quiesce(): Promise<HostQuiesceLease | null> {
    const welcome = this.lastWelcome;
    const socket = this.socket;
    if (welcome?.quiesceSupported !== true || !socket || !this.isReady())
      return null;

    const id = randomUUID();
    let released = false;
    const current = () =>
      !released && this.socket === socket && this.isCurrent(welcome);
    const release = () => {
      if (!released && this.socket === socket && !socket.destroyed)
        this.send({ type: "release_quiesce", id });
      released = true;
    };
    const reply = await this.requestQuiesce(id, { type: "quiesce", id });
    if (
      reply?.type !== "quiesce_result" ||
      reply.state !== "idle" ||
      !current()
    ) {
      release();
      return null;
    }
    return {
      current,
      release,
      shutdown: async () => {
        if (!current()) return false;
        const result = await this.requestQuiesce(id, {
          type: "shutdown",
          quiesceId: id,
        });
        return (
          result?.type === "quiesce_shutdown_result" && result.accepted === true
        );
      },
    };
  }

  private requestQuiesce(id: string, message: ClientMessage) {
    return new Promise<QuiesceReply | undefined>((resolve) => {
      if (this.pendingQuiesce) {
        resolve(undefined);
        return;
      }
      const timer = setTimeout(() => finish(), QUIESCE_TIMEOUT_MS);
      const finish = (reply?: QuiesceReply) => {
        clearTimeout(timer);
        this.pendingQuiesce = undefined;
        resolve(reply);
      };
      this.pendingQuiesce = { id, finish };
      try {
        this.send(message);
      } catch {
        finish();
      }
    });
  }

  async getBackgroundWork(): Promise<BackgroundSnapshot> {
    const welcome = this.lastWelcome;
    const empty = (
      status: BackgroundSnapshot["status"]
    ): BackgroundSnapshot => ({ status, items: [] });
    if (!this.isConnected() || !welcome?.running) return empty("offline");
    if (!welcome.backgroundWorkSupported) return empty("unsupported");
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingBackground.delete(id);
        resolve(empty("unavailable"));
      }, 2000);
      this.pendingBackground.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(this.lastWelcome === welcome ? result : empty("unavailable"));
        },
        reject: () => {
          clearTimeout(timer);
          resolve(empty("offline"));
        },
      });
      try {
        this.send({
          type: "background_work",
          id,
          sessionId: welcome.sessionId,
        });
      } catch {
        this.pendingBackground.get(id)?.reject(new Error("Disconnected"));
        this.pendingBackground.delete(id);
      }
    });
  }

  async getMcpInventory(agentId: string): Promise<AgentMcpInventoryResponse> {
    const welcome = this.lastWelcome;
    const empty = (
      status: AgentMcpInventoryResponse["status"]
    ): AgentMcpInventoryResponse => ({ agentId, status, inventory: null });
    if (!this.isConnected() || !welcome?.running) return empty("offline");
    if (!welcome.mcpInventorySupported) return empty("unsupported");
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingInventory.delete(id);
        resolve(empty("timeout"));
      }, 10000);
      this.pendingInventory.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(
            this.lastWelcome !== welcome || result.agentId !== agentId
              ? empty("unavailable")
              : result
          );
        },
        reject: () => {
          clearTimeout(timer);
          resolve(empty("offline"));
        },
      });
      try {
        this.send({ type: "mcp_inventory", id, sessionId: welcome.sessionId });
      } catch {
        this.pendingInventory.get(id)?.reject(new Error("Disconnected"));
        this.pendingInventory.delete(id);
      }
    });
  }

  /** Resolves once the adapter has accepted the steering request. */
  steer(
    id: string,
    text: string,
    source?: PromptSource
  ): Promise<"injected" | "promptRequired"> {
    return new Promise((resolve, reject) => {
      this.pendingSteers.set(id, { resolve, reject });
      try {
        this.send({ type: "steer", id, text, ...(source ? { source } : {}) });
      } catch (err) {
        this.pendingSteers.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Resolves once the adapter has accepted the prompt, or with "deferred"
   * when the host handed it back because the engine's own turn is open.
   */
  async prompt(
    id: string,
    text: string,
    source?: PromptSource,
    images?: PromptImage[],
    mayReplay?: () => boolean
  ): Promise<"accepted" | "deferred"> {
    const journalId = this.deps.remote
      ? this.lastWelcome?.journalId
      : undefined;
    const command = {
      type: "prompt" as const,
      id,
      text,
      ...(this.deps.remote ? { journalId } : {}),
      ...(source ? { source } : {}),
      ...(images?.length ? { images } : {}),
    };
    try {
      return await this.sendPrompt(command);
    } catch (error) {
      if (!(error instanceof UpdateAcknowledgementLost) || !journalId)
        throw error;
      const welcome = await error.reattached;
      if (
        welcome?.promptReceiptSupported !== true ||
        welcome.journalId !== journalId ||
        !this.isCurrent(welcome)
      )
        throw error;
      const state = await this.queryPromptReceipt(id, journalId);
      if (!this.isCurrent(welcome)) throw error;
      if (state === "accepted") return "accepted";
      if (state !== "unclaimed" || mayReplay?.() === false) throw error;
      // The host atomically checks the same ID and journal again before
      // claiming, so even a query-to-send race cannot submit twice.
      return this.sendPrompt(command);
    }
  }

  private isCurrent(welcome: HostWelcome): boolean {
    return this.isReady() && this.lastWelcome === welcome;
  }

  private queryPromptReceipt(
    id: string,
    journalId: string
  ): Promise<PromptReceiptState | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(), 5000);
      const finish = (
        receipt?: Extract<HostMessage, { type: "prompt_receipt_result" }>
      ) => {
        clearTimeout(timer);
        this.pendingReceipts.delete(id);
        resolve(receipt?.journalId === journalId ? receipt.state : undefined);
      };
      this.pendingReceipts.set(id, finish);
      try {
        this.send({ type: "prompt_receipt", id, journalId });
      } catch {
        finish();
      }
    });
  }

  private sendPrompt(
    command: Extract<ClientMessage, { type: "prompt" }>
  ): Promise<"accepted" | "deferred"> {
    const { id } = command;
    return new Promise<"accepted" | "deferred">((resolve, reject) => {
      this.pendingPrompts.set(id, { resolve, reject });
      try {
        this.send(command);
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

  async answerPermission(
    id: string,
    requestId: string,
    optionId: string | null
  ): Promise<void> {
    const original = this.lastWelcome;
    const request = this.permissions.find(
      (permission) => permission.id === requestId
    );
    try {
      await this.sendPermission(id, requestId, optionId);
    } catch (error) {
      if (
        !(error instanceof UpdateAcknowledgementLost) ||
        !original?.journalId ||
        !request
      )
        throw error;
      const welcome = await error.reattached;
      if (
        !welcome ||
        !this.isCurrent(welcome) ||
        welcome.journalId !== original.journalId ||
        welcome.sessionId !== original.sessionId ||
        !isDeepStrictEqual(
          this.permissions.find((permission) => permission.id === requestId),
          request
        ) ||
        (optionId !== null &&
          !request.options.some((option) => option.optionId === optionId))
      )
        throw error;
      await this.sendPermission(id, requestId, optionId);
    }
  }

  private sendPermission(
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

  /** Completion means the cancel request returned, not that the turn settled. */
  interrupt(id: string, turnSeq: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingInterrupts.set(id, { resolve, reject });
      try {
        this.send({ type: "interrupt", id, turnSeq });
      } catch (err) {
        this.pendingInterrupts.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  cancel(): void {
    this.send({ type: "cancel" });
  }

  shutdown(force: boolean): void {
    this.send({ type: "shutdown", force });
  }

  isReady(): boolean {
    return (
      this.replayReady && this.isConnected() && !!this.lastWelcome?.running
    );
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Reject an incomplete journal suffix and ask for replay on a fresh channel. */
  replay(): void {
    this.socket?.destroy();
  }

  /** Stop reconnecting and drop the socket. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.finishUpdateReattach?.(null);
    this.failPending(new Error("the agent host client was closed"));
    this.socket?.destroy();
    this.socket = null;
  }
}
