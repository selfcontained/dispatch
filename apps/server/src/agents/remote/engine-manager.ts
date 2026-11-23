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
  RUNNER_ENGINES,
  engineScopeKey,
  isEngineCapabilityOperation,
  type EngineInventoryEntry,
  type EngineOperation,
  type EngineOperationAck,
  type EngineOperationEvent,
  type EngineScope,
} from "@dispatch/runner-protocol/engine-management";

import type { AcpEngineId } from "../acp/engine-spec.js";
import type { EngineUpdateOperations } from "../engine-updates.js";
import type { EngineCalls } from "../../runners/local.js";

/**
 * One place to read engine status and run install/update/sign-in, for any
 * placement. The inventory (`engine.list`) and sign-in (`engine.login.*`)
 * go through the placement's runner: the local child (or, while it is away,
 * the same port in process) or an enrolled runner over its transport. Local
 * update still runs main's `EngineUpdateOperations` (T29). This class has
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
      local: LocalEngineDeps;
      remote: RunnerEngineTransport;
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
    const entries =
      scope.kind === "local"
        ? await this.localInventory()
        : await this.remoteInventory(scope);
    if (entries) this.emitChanged(scope, entries);
    return entries;
  }

  async rpc(
    scope: EngineScope,
    operation: EngineOperation,
    onEvent?: (event: EngineOperationEvent) => void
  ): Promise<EngineOperationAck> {
    const ack =
      scope.kind === "local"
        ? await this.localRpc(operation)
        : await this.deps.remote.send(scope.runnerId, operation, onEvent);
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
      const entries =
        scope.kind === "local"
          ? await this.localInventory().catch(() => null)
          : await this.remoteInventory(scope, { force: true }).catch(
              () => null
            );
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
    if (scope.kind === "local") return this.localLogin(operation);
    const ack = await this.deps.remote.send(scope.runnerId, operation);
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
    const entries = (await this.inventory(scope)) ?? [];
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

  private async localInventory(): Promise<EngineInventoryEntry[]> {
    const { entries } = await this.deps.local.engines.call("engine.list", {
      refresh: true,
    });
    return entries as EngineInventoryEntry[];
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

  private async remoteInventory(
    scope: Extract<EngineScope, { kind: "runner" }>,
    opts: { force?: boolean } = {}
  ): Promise<EngineInventoryEntry[] | null> {
    const cached = opts.force
      ? undefined
      : this.deps.remote.cachedInventory?.(scope.runnerId);
    if (cached) return cached;
    let result: EngineInventoryEntry[] = [];
    const ack = await this.deps.remote.send(
      scope.runnerId,
      { type: "status" },
      (event) => {
        if (event.type === "inventory") result = event.entries;
      }
    );
    if (!ack.ok) {
      // A failed read, as behind an update fence, doesn't mean "not
      // installed". Nothing can be changed there until a read succeeds.
      if (!ack.unsupported)
        return (
          this.deps.remote
            .lastKnownInventory?.(scope.runnerId)
            ?.map((entry) => ({ ...entry, actions: [] })) ?? null
        );
      // Unsupported: report every engine as unknown rather than throwing,
      // so the UI can show "unavailable" instead of an error page.
      return RUNNER_ENGINES.map((id) => ({
        id,
        label: LABELS[id],
        installed: false,
        signedIn: null,
        version: null,
        actions: [],
      }));
    }
    return result;
  }

  private async localRpc(
    operation: EngineOperation
  ): Promise<EngineOperationAck> {
    const { updates, overrides } = this.deps.local;
    if (isEngineCapabilityOperation(operation)) {
      return this.localCapabilities.handle(operation);
    }
    switch (operation.type) {
      case "status":
        return { ok: true };
      case "install":
        return {
          ok: false,
          error: `${LABELS[operation.engine]} is installed manually on this machine; there is no automatic install here.`,
          unsupported: true,
        };
      case "update": {
        if (!isAcpEngine(operation.engine)) {
          return {
            ok: false,
            error: `${LABELS[operation.engine]} has no update path.`,
          };
        }
        try {
          const op = await updates.start(operation.engine, overrides ?? {});
          return { ok: true, operationId: op.id };
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      }
      case "login_start":
      case "login_submit":
      case "login_cancel":
      case "login_status":
        return this.localLogin(operation);
    }
  }
}

function isAcpEngine(engine: RunnerEngine): engine is AcpEngineId {
  return engine === "claude" || engine === "codex" || engine === "opencode";
}
