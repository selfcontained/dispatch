import type { AgentModelOption } from "../../shared/agent-models.js";
import type { createRunnerUsage } from "../codex-reset.js";
import { runnerPluginChecker } from "../../routes/plugin.js";
import {
  createLocalEngineRunner,
  type LocalEngineRunner,
} from "../local-runner-engine.js";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { RunnerEngine } from "@dispatch/runner-protocol";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import {
  LOGIN_ENGINES,
  type EngineAuthStatus,
  type EngineLogin,
  type EngineLoginEngine,
} from "@dispatch/shared";
import {
  engineScopeKey,
  isEngineCapabilityOperation,
  type EngineInventoryEntry,
  type EngineOperation,
  type EngineOperationAck,
  type EngineOperationEvent,
  type EngineScope,
} from "@dispatch/runner-protocol/engine-management";

import type { AcpEngineId } from "@dispatch/runner-protocol/host";
import type { EngineUpdateOperations } from "../engine-update-operations.js";
import type { EngineCalls } from "../../runners/local.js";

/**
 * One place to read engine status and run install/update/sign-in, for any
 * placement. The inventory (`engine.list`) and sign-in (`engine.login.*`)
 * go through the placement's runner: the local child (or, while it is away,
 * the same port in process) or an enrolled runner over its transport.
 * Install/update use the same durable coordinator for every target. This class has
 * no socket of its own.
 */

export type { EngineScope };

/** What a runner's connection exposes for engine management; supplied by the caller. */
export interface RunnerEngineTransport {
  /**
   * Send one operation to the named runner. `onEvent` receives any
   * progress frames the runner streams before its ack. Reject (or resolve
   * `{ ok: false, unsupported: true }`) for an offline runner or one that
   * predates engine management.
   */
  send(
    runnerId: string,
    operation: EngineOperation,
    onEvent?: (event: EngineOperationEvent) => void
  ): Promise<EngineOperationAck>;
  /**
   * The runner's last pushed inventory snapshot, if any — a cheap read
   * that skips a wire round trip. `inventory()` falls back to `send` with
   * a `"status"` operation when this is absent (not yet pushed, or the
   * transport doesn't track a cache).
   */
  cachedInventory?(runnerId: string): EngineInventoryEntry[] | undefined;
  /**
   * The last inventory from any connection: what to show while the runner
   * can't be read, as during its update.
   */
  lastKnownInventory?(runnerId: string): EngineInventoryEntry[] | undefined;
}

export type LocalEngineDeps = {
  /** The local runner's engine inventory and sign-in. */
  engines: EngineCalls;
  updates: EngineUpdateOperations;
  capabilities?: Pick<LocalEngineRunner, "handle">;
  overrides?: Partial<Record<AcpEngineId, string>>;
};

const LABELS: Record<RunnerEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export type EngineManagerChangeListener = (
  entries: EngineInventoryEntry[]
) => void;

export class EngineManager {
  private readonly events = new EventEmitter();
  private readonly localCapabilities: Pick<LocalEngineRunner, "handle">;
  /** Each placement's latest sign-in per engine, by scope key. */
  private readonly logins = new Map<string, Map<RunnerEngine, string>>();

  constructor(
    private readonly deps: {
      onSignedIn?: (scope: EngineScope, engine: RunnerEngine) => void;
      local: LocalEngineDeps;
      remote: RunnerEngineTransport;
      engineActions: {
        calls(scope: EngineScope): EngineCalls;
        models(
          scope: EngineScope,
          engine: RunnerEngine,
          model?: string
        ): { defaultModel: string | null; models: readonly AgentModelOption[] };
        usage(scope: EngineScope): ReturnType<typeof createRunnerUsage>;
        updates(scope: EngineScope): EngineUpdateOperations;
      };
    }
  ) {
    this.localCapabilities =
      deps.local.capabilities ??
      createLocalEngineRunner({
        bins: {
          claude: deps.local.overrides?.claude ?? "claude",
          codex: deps.local.overrides?.codex ?? "codex",
        },
      });
  }

  /** Subscribe to inventory changes for one scope; call the returned function to stop. */
  onChanged(
    scope: EngineScope,
    listener: EngineManagerChangeListener
  ): () => void {
    const key = engineScopeKey(scope);
    this.events.on(key, listener);
    return () => this.events.off(key, listener);
  }

  private emitChanged(
    scope: EngineScope,
    entries: EngineInventoryEntry[]
  ): void {
    this.events.emit(engineScopeKey(scope), entries);
  }

  /** Null while a runner's engines are not known yet. */
  async inventory(scope: EngineScope): Promise<EngineInventoryEntry[] | null> {
    const entries = await this.readInventory(scope, false);
    if (entries) this.emitChanged(scope, entries);
    return entries;
  }

  async rpc(
    scope: EngineScope,
    operation: EngineOperation,
    onEvent?: (event: EngineOperationEvent) => void
  ): Promise<EngineOperationAck> {
    if (operation.type === "model_catalog") {
      const catalog = this.deps.engineActions.models(
        scope,
        operation.engine,
        operation.model
      );
      return {
        ok: true,
        capability: {
          type: "model_catalog",
          catalog: { ...catalog, models: [...catalog.models] },
        },
      };
    }
    if (operation.type === "provider_usage") {
      return {
        ok: true,
        capability: {
          type: "provider_usage",
          usage: await this.deps.engineActions.usage(scope).providerPlans(),
        },
      };
    }
    if (operation.type === "codex_reset") {
      const result = await this.deps.engineActions
        .usage(scope)
        .redeemCodexReset(operation.requestId);
      if (result.error) return { ok: false, error: result.error.message };
      return {
        ok: true,
        capability: { type: "codex_reset", ...result.outcome! },
      };
    }
    if (operation.type === "contract")
      return {
        ok: true,
        result: await this.deps.engineActions
          .calls(scope)
          .call(operation.call.op, operation.call.request as never),
      };
    if (operation.type === "install" || operation.type === "update") {
      try {
        const updates = this.deps.engineActions.updates(scope);
        const started =
          operation.type === "install"
            ? await updates.start(operation.engine, {}, "install")
            : await updates.start(
                operation.engine,
                this.deps.local.overrides ?? {}
              );
        return { ok: true, operationId: started.id };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(operation.type === "install" &&
            error instanceof RunnerCallError &&
            error.code === "unsupported" && { unsupported: true }),
        };
      }
    }
    if (
      operation.type === "plugin_status" ||
      operation.type === "plugin_install" ||
      operation.type === "plugin_update"
    ) {
      const checker = runnerPluginChecker(
        this.deps.engineActions.calls(scope),
        operation.plugin
      );
      try {
        const change =
          operation.type === "plugin_install"
            ? await checker.install(operation.engine)
            : operation.type === "plugin_update"
              ? await checker.update(operation.engine)
              : null;
        if (change?.error)
          return {
            ok: false,
            error: change.error,
            ranCommands: change.ranCommands,
            probeFailed: change.probeFailed,
            status: {
              ...change.status,
              actions: change.status.installed ? ["update"] : ["install"],
            },
          };
        const status =
          change?.status ?? (await checker.getStatus(operation.engine));
        return {
          ok: true,
          ...(change && {
            ranCommands: change.ranCommands,
            probeFailed: change.probeFailed,
          }),
          capability: {
            type: "plugin_status",
            status: {
              ...status,
              actions: status.installed ? ["update"] : ["install"],
            },
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const ack =
      scope.kind === "local"
        ? await this.localRpc(operation)
        : await this.deps.remote.send(scope.runnerId, operation, onEvent);
    this.observeSignIn(scope, ack);
    if (scope.kind === "runner" && operation.type === "login_start")
      this.track(scope, ack.ok ? ack.login : undefined);
    // Refresh before returning, so a caller that awaits `rpc` sees the
    // change notification fire no later than its own result. A runner's
    // own pushed-cache update can lag its ack by a round trip, so force a
    // live read here rather than risk handing back what the cache held
    // before the operation ran.
    if (
      !isEngineCapabilityOperation(operation) &&
      operation.type !== "status" &&
      operation.type !== "login_status"
    ) {
      const entries = await this.readInventory(scope, true).catch(() => null);
      if (entries) this.emitChanged(scope, entries);
    }
    return ack;
  }

  /**
   * A sign-in operation alone, without the inventory refresh `rpc` adds:
   * main's sign-in routes answer as soon as the login does.
   */
  async login(
    scope: EngineScope,
    operation: Extract<EngineOperation, { type: `login_${string}` }>
  ): Promise<EngineOperationAck> {
    const ack =
      scope.kind === "local"
        ? await this.localLogin(operation)
        : await this.deps.remote.send(scope.runnerId, operation);
    this.observeSignIn(scope, ack);
    if (operation.type === "login_start")
      this.track(scope, ack.ok ? ack.login : undefined);
    return ack;
  }

  /**
   * The engine's sign-in a page should show on this placement: the one under
   * way, else the newest that ended in the last few minutes. `{ ok: true }`
   * without a login when there is neither.
   */
  async currentLogin(
    scope: EngineScope,
    engine: EngineLoginEngine
  ): Promise<EngineOperationAck> {
    const key = engineScopeKey(scope);
    const logins = this.logins.get(key);
    const loginId = logins?.get(engine);
    if (!logins || loginId === undefined) return { ok: true };
    const ack = await this.login(scope, { type: "login_status", loginId });
    // The runner prunes old logins and forgets them when it restarts.
    if (!ack.ok && ack.error === "Sign-in not found.") {
      if (logins.get(engine) === loginId) {
        logins.delete(engine);
        if (logins.size === 0) this.logins.delete(key);
      }
      return { ok: true };
    }
    return ack;
  }

  /** Whether each signed-in engine's CLI is signed in on this placement, and as whom. */
  async signInStatus(scope: EngineScope): Promise<EngineAuthStatus[]> {
    // Locally, only the sign-in is asked for: no version or update probes,
    // so this costs what main's sign-in check did.
    const entries =
      scope.kind === "local"
        ? ((
            await this.deps.local.engines.call("engine.list", {
              refresh: true,
              include: ["signIn"],
            })
          ).entries as EngineInventoryEntry[])
        : ((await this.inventory(scope)) ?? []);
    return LOGIN_ENGINES.map((engine) => {
      const entry = entries.find((candidate) => candidate.id === engine);
      const installed = entry?.installed ?? false;
      const signedIn = entry?.signedIn === true;
      return {
        engine,
        installed,
        signedIn,
        ...(installed && entry?.detail ? { detail: entry.detail } : {}),
      };
    });
  }

  /** Cancel this placement's sign-ins under way; the app is closing. */
  async closeLogins(scope: EngineScope): Promise<void> {
    const logins = this.logins.get(engineScopeKey(scope));
    if (!logins) return;
    await Promise.all(
      [...logins.values()].map((loginId) =>
        this.login(scope, { type: "login_cancel", loginId }).catch(() => null)
      )
    );
  }

  private readonly completedSignIns = new Set<string>();
  private observeSignIn(scope: EngineScope, ack: EngineOperationAck) {
    if (!ack.ok || ack.login?.status !== "succeeded") return;
    const key = JSON.stringify([engineScopeKey(scope), ack.login.id]);
    if (this.completedSignIns.has(key)) return;
    this.completedSignIns.add(key);
    this.deps.onSignedIn?.(scope, ack.login.engine);
  }

  private track(
    scope: EngineScope,
    login: { id: string; engine: string } | undefined
  ) {
    if (!login) return;
    const key = engineScopeKey(scope);
    let logins = this.logins.get(key);
    if (!logins) {
      logins = new Map();
      this.logins.set(key, logins);
    }
    logins.set(login.engine as RunnerEngine, login.id);
  }

  async operations(scope: EngineScope) {
    return this.deps.engineActions.updates(scope).read();
  }

  private async readInventory(
    scope: EngineScope,
    refresh: boolean
  ): Promise<EngineInventoryEntry[] | null> {
    const result = await this.deps.engineActions
      .calls(scope)
      .call("engine.list", { refresh });
    return result.available === false
      ? null
      : (result.entries as EngineInventoryEntry[]);
  }

  /** A local sign-in operation through the local runner, as a wire v1 ack. */
  private async localLogin(
    operation: Extract<EngineOperation, { type: `login_${string}` }>
  ): Promise<EngineOperationAck> {
    const { engines } = this.deps.local;
    const local: EngineScope = { kind: "local" };
    try {
      let login: unknown;
      switch (operation.type) {
        case "login_start":
          login = await engines.call(
            "engine.login.start",
            {
              engine: operation.engine,
              restart: operation.restart ?? false,
              requestId: randomUUID(),
            },
            // Known by ID from the moment it exists, so a page asking for
            // the current login sees it while its link is on the way.
            { onEvent: (event) => this.track(local, event.login) }
          );
          this.track(local, login as EngineLogin);
          break;
        case "login_submit":
          login = await engines.call("engine.login.submit", {
            loginId: operation.loginId,
            code: operation.code,
          });
          break;
        case "login_status":
          login = await engines.call("engine.login.status", {
            loginId: operation.loginId,
          });
          break;
        case "login_cancel":
          login = await engines.call("engine.login.cancel", {
            loginId: operation.loginId,
          });
          break;
      }
      return { ok: true, login: login as EngineLogin };
    } catch (error) {
      if (error instanceof RunnerCallError)
        return { ok: false, error: error.message };
      throw error;
    }
  }

  private async localRpc(
    operation: EngineOperation
  ): Promise<EngineOperationAck> {
    if (isEngineCapabilityOperation(operation)) {
      return this.localCapabilities.handle(operation);
    }
    switch (operation.type) {
      case "status":
        return { ok: true };
      case "login_start":
      case "login_submit":
      case "login_cancel":
      case "login_status":
        return this.localLogin(operation);
    }
    throw new Error("Engine operation was not routed.");
  }
}
