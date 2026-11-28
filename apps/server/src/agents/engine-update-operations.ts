import { clearEngineVersionCache } from "@dispatch/runner-protocol/engine-version-cache";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  localRunnerSettings,
  namespaced,
  type RunnerSettings,
} from "../runners/settings-namespace.js";
import {
  RunnerCallError,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
import type { AcpEngineId } from "@dispatch/runner-protocol/host";
import type { EngineHostCallName } from "@dispatch/runner-protocol/engine-management";
import { compareVersions } from "@dispatch/runner-protocol/engine-options";

type EngineCalls = {
  call<K extends EngineHostCallName>(op: K, input: Req<K>): Promise<Res<K>>;
};
type Command = {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  refresh?: { executable: string; args: string[]; env?: NodeJS.ProcessEnv };
};
type Installation = Omit<Res<"engine.update.inspect">, "run"> & {
  run?: Command;
};
type UpdateObserver = {
  output?: (chunk: string) => void;
  spawned?: (pid: number) => Promise<void>;
  closed?: () => void;
};
type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowedExitCodes?: number[];
    timeoutMs?: number;
    trimOutput?: boolean;
  }
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type EngineUpdateOperation = {
  id: string;
  engineId: AcpEngineId;
  status: "running" | "succeeded" | "failed" | "interrupted";
  phase: "starting" | "refreshing" | "updating" | "complete";
  message: string;
  output: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  retryBlocked: boolean;
};
type StoredOperation = EngineUpdateOperation & {
  owner: string;
  ownerPid: number;
  childPid: number | null;
  spawnGated: boolean;
  target: string;
};
type OperationRecords = Partial<Record<AcpEngineId, StoredOperation>>;
export interface EngineOperationStore {
  exclusive<T>(work: (records: OperationRecords) => Promise<T>): Promise<T>;
}
const OPERATION_KEY = "engine_update_operations";
/** One transaction lock covers all engines, including shared brew/npm prefixes. */
export function engineOperationStore(
  pool: Pool,
  settings: RunnerSettings = localRunnerSettings
): EngineOperationStore {
  const operationKey = namespaced(settings, OPERATION_KEY);
  return {
    async exclusive(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(settings.updateLock.sql, settings.updateLock.values);
        const result = await client.query<{ value: string }>(
          "SELECT value FROM settings WHERE key = $1",
          [operationKey]
        );
        const records: OperationRecords = result.rows[0]
          ? JSON.parse(result.rows[0].value)
          : {};
        const value = await work(records);
        await client.query(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [operationKey, JSON.stringify(records)]
        );
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
function mayExist(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function publicOperation(record: StoredOperation): EngineUpdateOperation {
  const {
    owner: _owner,
    ownerPid: _ownerPid,
    childPid: _pid,
    spawnGated: _gate,
    target: _target,
    ...operation
  } = record;
  return operation;
}
/** Server-owned lifecycle. No request/socket owns the command or its exclusion. */
export class EngineUpdateOperations {
  private readonly owner = randomUUID();
  private readonly pendingTerminal = new Map<AcpEngineId, StoredOperation>();
  constructor(
    private readonly store: EngineOperationStore,
    private readonly options: {
      prepare: (
        id: AcpEngineId,
        overrides: Partial<Record<AcpEngineId, string>>,
        action?: "install" | "update"
      ) => Promise<Installation>;
      runner: (observer: UpdateObserver) => CommandRunner;
      mayExist?: (pid: number) => boolean;
      processExists?: (pid: number) => Promise<boolean>;
      verify: (
        bin: string,
        phase: "before" | "after"
      ) => Promise<string | null>;
      clearEngineVersionCache: () => void;
      onError?: (error: unknown) => void;
    }
  ) {}
  private async recover(records: OperationRecords) {
    for (const record of Object.values(records)) {
      if (record.status === "running" && record.owner !== this.owner) {
        record.status = "interrupted";
        record.finishedAt = record.updatedAt = new Date().toISOString();
        record.message =
          "Server continuity was lost. The update outcome is unknown; verify the installed version before retrying.";
      }
      if (record.status === "interrupted") {
        const ownerExists = this.options.mayExist ?? mayExist;
        const childExists = (pid: number) =>
          this.options.processExists
            ? this.options.processExists(pid)
            : ownerExists(pid);
        // ownerPid belongs to Dispatch; childPid belongs to the target runner.
        // Recovered identifiers are probes only and are never signalled.
        record.retryBlocked =
          (record.ownerPid !== process.pid && ownerExists(record.ownerPid)) ||
          (!record.childPid
            ? !record.spawnGated
            : await childExists(
                process.platform === "win32"
                  ? record.childPid
                  : -record.childPid
              ));
      }
    }
  }
  private reconcileTerminal(records: OperationRecords) {
    for (const [id, terminal] of this.pendingTerminal) {
      const current = records[id];
      if (
        current?.id === terminal.id &&
        current.owner === this.owner &&
        current.status === "running"
      )
        records[id] = { ...terminal };
    }
  }
  async read(): Promise<Partial<Record<AcpEngineId, EngineUpdateOperation>>> {
    const pending = [...this.pendingTerminal];
    const result = await this.store.exclusive(async (records) => {
      this.reconcileTerminal(records);
      await this.recover(records);
      return Object.fromEntries(
        Object.entries(records).map(([id, record]) => [
          id,
          publicOperation(record),
        ])
      );
    });
    // Only discard after the transaction commits; an interrupted/replaced
    // operation is fenced and must never be overwritten by an older result.
    for (const [id, terminal] of pending) {
      if (
        this.pendingTerminal.get(id)?.id === terminal.id &&
        (result[id]?.id !== terminal.id || result[id]?.status !== "running")
      )
        this.pendingTerminal.delete(id);
    }
    return result;
  }
  async start(
    id: AcpEngineId,
    overrides: Partial<Record<AcpEngineId, string>>,
    action: "install" | "update" = "update"
  ) {
    const installation = await this.options.prepare(id, overrides, action);
    if (!installation.canUpdate || !installation.run)
      throw new RunnerCallError({
        code: "unsupported",
        message: installation.reason,
      });
    const operation = await this.store.exclusive(async (records) => {
      this.reconcileTerminal(records);
      await this.recover(records);
      if (
        Object.values(records).some(
          (record) => record.status === "running" || record.retryBlocked
        )
      )
        throw new Error(
          "An engine update is running or its prior outcome is uncertain. Review the previous operation before retrying."
        );
      const now = new Date().toISOString();
      const record: StoredOperation = {
        id: randomUUID(),
        engineId: id,
        status: "running",
        phase: "starting",
        message: "Starting verified installation update.",
        output: "",
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        retryBlocked: true,
        owner: this.owner,
        ownerPid: process.pid,
        childPid: null,
        spawnGated: true,
        target: installation.target,
      };
      records[id] = record;
      return { ...record };
    });
    // Start only after the durable claim commits; disconnection cannot cancel it.
    void this.execute(
      operation,
      installation.run,
      installation.probePath ?? installation.realPath!,
      action
    ).catch((error) => this.options.onError?.(error));
    return publicOperation(operation);
  }
  private async execute(
    record: StoredOperation,
    command: Command,
    probePath: string,
    action: "install" | "update" = "update"
  ) {
    let output = "";
    const save = async () => {
      record.output = output;
      record.updatedAt = new Date().toISOString();
      await this.store.exclusive(async (records) => {
        if (
          records[record.engineId]?.id !== record.id ||
          records[record.engineId]?.status === "interrupted"
        )
          throw new Error("Engine operation ownership changed.");
        records[record.engineId] = { ...record };
      });
    };
    // Throttle writes; the in-memory and persisted buffers are both bounded.
    let dirty = false;
    let writes = Promise.resolve();
    const queueSave = () => {
      writes = writes.then(save);
      return writes;
    };
    const timer = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      void queueSave().catch((error) => this.options.onError?.(error));
    }, 250);
    timer.unref();
    const runner = this.options.runner({
      output: (chunk) => {
        output = (output + chunk).slice(-64_000);
        dirty = true;
      },
      spawned: async (pid) => {
        record.childPid = pid;
        await queueSave();
      },
    });
    try {
      const probe = (phase: "before" | "after") =>
        this.options.verify(probePath, phase);
      this.options.clearEngineVersionCache();
      const before = await probe("before");
      const execute = async (
        step: Command,
        phase: "refreshing" | "updating",
        timeoutMs: number
      ) => {
        record.phase = phase;
        record.message =
          phase === "refreshing"
            ? "Refreshing package metadata…"
            : "Updating the selected installation…";
        // Persist intent before each spawn. A restart in this gap is uncertain.
        record.childPid = null;
        await queueSave();
        const result = await runner(step.executable, step.args, {
          env: step.env,
          timeoutMs,
        });
        // Injectable runners need not stream their output.
        const finalOutput = [result.stdout, result.stderr]
          .filter(Boolean)
          .join("\n");
        if (finalOutput && !output.endsWith(finalOutput))
          output = (output + "\n" + finalOutput).slice(-64_000);
        return result.exitCode === 0;
      };
      const refreshed =
        !command.refresh ||
        (await execute(command.refresh, "refreshing", 60_000));
      const success =
        refreshed && (await execute(command, "updating", 120_000));
      this.options.clearEngineVersionCache();
      const version = await probe("after");
      const advanced = Boolean(
        action === "install"
          ? success && version
          : before && version && compareVersions(version, before) > 0
      );
      record.status = advanced ? "succeeded" : "failed";
      record.message = advanced
        ? `${action === "install" ? "Install" : "Update"} completed. Verified installed version ${version}.`
        : success
          ? "Update command completed, but a newer installed version could not be verified. Recheck status before retrying."
          : "Update command failed. Review the output before retrying.";
    } catch (error) {
      const unknown =
        error instanceof RunnerCallError &&
        ["unavailable", "unknown_outcome", "not_found"].includes(error.code);
      record.status = unknown ? "interrupted" : "failed";
      record.message = unknown
        ? "Server continuity was lost. The update outcome is unknown; verify the installed version before retrying."
        : "Update failed. Review the output before retrying.";
      output = (output + "\n" + String(error)).slice(-64_000);
    } finally {
      clearInterval(timer);
      this.options.clearEngineVersionCache();
      if (record.status !== "interrupted") record.phase = "complete";
      record.finishedAt = new Date().toISOString();
      record.retryBlocked = record.status === "interrupted";
      // Drain in-flight snapshots before writing the terminal result.
      await writes.catch(() => {});
      record.output = output;
      this.pendingTerminal.set(record.engineId, { ...record });
      await save();
      if (this.pendingTerminal.get(record.engineId)?.id === record.id)
        this.pendingTerminal.delete(record.engineId);
    }
  }
}

/** Main's full engine presentation, gathered from the target's engine operations. */
export async function runnerEngineStatuses(engines: EngineCalls) {
  const { entries } = await engines.call("engine.list", {
    refresh: true,
    include: [],
  });
  return Promise.all(
    entries.map(async (entry) => {
      const inspection = await engines.call("engine.update.inspect", {
        engine: entry.id,
        presentation: true,
      });
      if (!inspection.status)
        throw new Error("Incomplete engine status result.");
      return inspection.status;
    })
  );
}

/** One presentation for the scoped engine API and its legacy Local aliases. */
export async function engineStatusPresentation(
  engines: EngineCalls,
  updates: EngineUpdateOperations
) {
  const operations = await updates.read();
  return (await runnerEngineStatuses(engines)).map((engine) => ({
    ...engine,
    update: { ...engine.update, operation: operations[engine.id] ?? null },
  }));
}

/** Observe transitions only after the operation store has durably committed. */
export function observeModelUpdates(
  store: EngineOperationStore,
  succeeded: (engine: AcpEngineId) => void
): EngineOperationStore {
  return {
    async exclusive(work) {
      const completed: AcpEngineId[] = [];
      const result = await store.exclusive(async (records) => {
        const before = new Set(
          Object.entries(records)
            .filter(([, row]) => row?.status === "succeeded")
            .map(([engine, row]) => `${engine}:${row!.id}`)
        );
        const value = await work(records);
        for (const [engine, row] of Object.entries(records)) {
          if (row?.status === "succeeded" && !before.has(`${engine}:${row.id}`))
            completed.push(engine as AcpEngineId);
        }
        return value;
      });
      for (const engine of completed) succeeded(engine);
      return result;
    },
  };
}

export function engineUpdatePort(engines: EngineCalls) {
  return {
    clearEngineVersionCache,
    prepare: async (
      engine: "claude" | "codex" | "opencode",
      _overrides: Partial<Record<AcpEngineId, string>>,
      action: "install" | "update" = "update"
    ) => engines.call("engine.update.inspect", { engine, action }),
    verify: async (bin: string) =>
      (await engines.call("engine.update.probe", { pids: [], bin })).version,
    processExists: async (pid: number) => {
      try {
        return (
          (
            await engines.call("engine.update.probe", {
              pids: [Math.abs(pid)],
              groups: true,
            })
          ).alive[0] ?? true
        );
      } catch (error) {
        if (
          error instanceof RunnerCallError &&
          ["unavailable", "unknown_outcome", "not_found"].includes(error.code)
        )
          return true;
        throw error;
      }
    },
    runner:
      (observer: UpdateObserver): CommandRunner =>
      async (executable, args, options) => {
        const env =
          options?.env &&
          Object.fromEntries(
            Object.entries(options.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          );
        const operation = await engines.call("engine.update.spawn", {
          requestId: randomUUID(),
          command: { executable, args, ...(env && { env }) },
          timeoutMs: options?.timeoutMs ?? 120_000,
        });
        try {
          // The host is still blocked on stdin until this durable PID write commits.
          await observer.spawned?.(operation.pid);
        } catch (error) {
          await engines
            .call("engine.update.release", {
              operationId: operation.operationId,
              abort: true,
            })
            .catch(() => {});
          throw error;
        }
        let releaseError: unknown;
        const released = engines
          .call("engine.update.release", { operationId: operation.operationId })
          .catch((error: unknown) => {
            releaseError = error;
          });
        let offset = 0;
        while (true) {
          if (releaseError) throw releaseError;
          const state = await engines.call("engine.operation", {
            operationId: operation.operationId,
          });
          if (state.type !== "operation_state")
            throw new Error("Invalid engine process state.");
          if (state.outputOffset > offset)
            observer.output?.(
              state.output.slice(
                -Math.min(state.outputOffset - offset, state.output.length)
              )
            );
          offset = state.outputOffset;
          if (state.error) throw new Error(state.error);
          if (state.result) {
            await released;
            if (releaseError) throw releaseError;
            return state.result;
          }
          if (!state.running)
            throw new RunnerCallError({
              code: "unknown_outcome",
              message: "Engine process outcome is unavailable.",
            });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
  };
}
