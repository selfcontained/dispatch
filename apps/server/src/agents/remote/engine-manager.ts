import {
  createLocalEngineRunner,
  type LocalEngineRunner,
} from "../local-runner-engine.js";
import { EventEmitter } from "node:events";

import type { RunnerEngine } from "@dispatch/runner-protocol";
import type { EngineLoginEngine } from "@dispatch/shared";
import {
  RUNNER_ENGINES,
  engineScopeKey,
  isEngineCapabilityOperation,
  type EngineInventoryEntry,
  type EngineOperation,
  type EngineOperationAck,
  type EngineOperationEvent,
  type EngineScope,
  type EngineSupportedAction,
} from "@dispatch/runner-protocol/engine-management";

import type { AcpEngineId } from "../acp/engine-spec.js";
import {
  engineStatuses,
  withEngineVersions,
  type EngineStatus,
} from "../engine-availability.js";
import { withEngineUpdates } from "../engine-updates.js";
import type { EngineLogins } from "../engine-login.js";
import type { EngineUpdateOperations } from "../engine-updates.js";

/**
 * One place to read engine status and run install/update/sign-in, whether
 * the engine runs on this machine or on a named runner workspace. Local
 * scope wraps the existing `EngineLogins`/`EngineUpdateOperations`
 * untouched — this adds a scope-aware read model and dispatch on top, it
 * never changes what those run or how. Remote scope forwards to whatever
 * transport the caller supplies; this class has no socket of its own.
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
  logins: EngineLogins;
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
  private readonly runnerLogins = new Map<string, Map<RunnerEngine, string>>();

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
    if (
      scope.kind === "runner" &&
      operation.type === "login_start" &&
      ack.ok &&
      ack.login
    ) {
      let logins = this.runnerLogins.get(scope.runnerId);
      if (!logins) {
        logins = new Map();
        this.runnerLogins.set(scope.runnerId, logins);
      }
      logins.set(operation.engine, ack.login.id);
    }
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

  /** Resolve the latest runner sign-in to the ID used by the wire operation. */
  async runnerLoginStatus(
    scope: Extract<EngineScope, { kind: "runner" }>,
    engine: EngineLoginEngine
  ): Promise<EngineOperationAck> {
    const logins = this.runnerLogins.get(scope.runnerId);
    const loginId = logins?.get(engine);
    if (!logins || loginId === undefined) return { ok: true };
    const ack = await this.rpc(scope, { type: "login_status", loginId });
    // The runner prunes old logins and forgets them when it restarts.
    if (!ack.ok && ack.error === "Sign-in not found.") {
      if (logins.get(engine) === loginId) {
        logins.delete(engine);
        if (logins.size === 0) this.runnerLogins.delete(scope.runnerId);
      }
      return { ok: true };
    }
    return ack;
  }

  private async localInventory(): Promise<EngineInventoryEntry[]> {
    const { logins, overrides } = this.deps.local;
    const statuses = await withEngineUpdates(
      await withEngineVersions(await engineStatuses(overrides))
    );
    return Promise.all(
      statuses.map(async (status) => {
        let signedIn: boolean | null = null;
        let detail: string | undefined;
        if (status.installed && isLoginSupported(status.id)) {
          const auth = await logins.status(status.id);
          signedIn = auth.signedIn;
          detail = auth.detail;
        }
        const actions: EngineSupportedAction[] = [];
        // Local install is always manual (see missingEngineMessage); this
        // view never offers an automatic install, matching current behavior.
        if (status.installed && status.update.canUpdate) actions.push("update");
        if (status.installed && isLoginSupported(status.id))
          actions.push("login", "login_cancel");
        return {
          id: status.id,
          label: LABELS[status.id],
          installed: status.installed,
          signedIn,
          version: status.version,
          ...(detail ? { detail } : {}),
          actions,
        };
      })
    );
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
    const { logins, updates, overrides } = this.deps.local;
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
      case "login_start": {
        if (!isLoginSupported(operation.engine)) {
          return {
            ok: false,
            error: `${LABELS[operation.engine]} has no sign-in flow.`,
          };
        }
        const login = await logins.start(operation.engine, {
          restart: operation.restart,
        });
        return { ok: true, login };
      }
      case "login_submit": {
        const login = logins.submitCode(operation.loginId, operation.code);
        if (!login) return { ok: false, error: "Sign-in not found." };
        return { ok: true, login };
      }
      case "login_cancel": {
        const login = logins.cancel(operation.loginId);
        if (!login) return { ok: false, error: "Sign-in not found." };
        return { ok: true, login };
      }
      case "login_status": {
        const login = logins.get(operation.loginId);
        if (!login) return { ok: false, error: "Sign-in not found." };
        return { ok: true, login };
      }
    }
  }
}

function isAcpEngine(engine: RunnerEngine): engine is AcpEngineId {
  return engine === "claude" || engine === "codex" || engine === "opencode";
}

function isLoginSupported(engine: RunnerEngine): engine is "claude" | "codex" {
  return engine === "claude" || engine === "codex";
}

export type { EngineStatus };
