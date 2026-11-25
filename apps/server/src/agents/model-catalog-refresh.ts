import type { Pool } from "pg";
import type { AgentType } from "../shared/agent-types.js";
import type { EngineCalls } from "../runners/local.js";
import {
  namespaced,
  type RunnerSettings,
} from "../runners/settings-namespace.js";
import { getSetting, setSetting } from "../db/settings.js";
import {
  getLearnedAgentModels,
  getAgentModelOptions,
  agentModelDefaults,
  type ModelValidationRequest,
} from "../shared/agent-models.js";
import { recordDiscoveredModels } from "./engine-models.js";
import { RunnerCallError, type Res } from "@dispatch/runner-protocol/contract";

export const MODEL_REFRESH_AGE_MS = 60 * 60_000;
export const MODEL_REFRESH_BACKOFF_MS = 60_000;

type Target = {
  settings: RunnerSettings;
  online: boolean;
  enabled: boolean;
  blocked?: boolean;
  calls: EngineCalls;
};
type Entry = {
  success?: number;
  retryAt: number;
  generation: number;
  dirty: boolean;
  again: boolean;
  pending?: Promise<void>;
};

/** Dispatch-owned freshness. Pickers schedule work; cold launch validation joins it. */
export class ModelCatalogRefresh {
  private entries = new Map<string, Entry>();
  private closed = false;
  constructor(
    private deps: {
      pool: Pool;
      resolve(runnerId: string, engine: AgentType): Target | undefined;
      now?: () => number;
      learn?: (
        runnerId: string,
        engine: AgentType,
        result: Res<"engine.models">,
        settings: RunnerSettings,
        refreshedAt: string,
        selectedModel?: string
      ) => Promise<boolean>;
      changed?: (runnerId: string, engine: AgentType) => void;
      failed?: (details: {
        runnerId: string;
        engine: AgentType;
        code: string;
      }) => void;
    }
  ) {}
  private state(runnerId: string, engine: AgentType, model?: string) {
    const key = JSON.stringify([runnerId, engine, model]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { retryAt: 0, generation: 0, dirty: false, again: false };
      this.entries.set(key, entry);
    }
    return entry;
  }
  request(runnerId: string, engine: AgentType, model?: string): void {
    if (this.closed) return;
    const entry = this.state(runnerId, engine, model);
    if (entry.pending) return;
    const now = this.deps.now?.() ?? Date.now();
    if (
      !entry.dirty &&
      (now < entry.retryAt ||
        (entry.success !== undefined &&
          now - entry.success < MODEL_REFRESH_AGE_MS))
    )
      return;
    let target: Target | undefined;
    try {
      target = this.deps.resolve(runnerId, engine);
    } catch {
      entry.retryAt = now + MODEL_REFRESH_BACKOFF_MS;
      this.deps.failed?.({ runnerId, engine, code: "target_unavailable" });
      return;
    }
    if (
      !target ||
      (!entry.dirty && (!target.enabled || !target.online || target.blocked))
    )
      return;
    entry.pending = this.refresh(
      runnerId,
      engine,
      entry,
      target,
      model
    ).finally(() => {
      entry.pending = undefined;
      if (entry.again && !this.closed) {
        entry.again = false;
        this.request(runnerId, engine);
      }
    });
  }
  /** Only launch validation waits, and only until a first observation exists. */
  async validate(
    runnerId: string,
    engine: AgentType,
    request: ModelValidationRequest = {}
  ): Promise<boolean> {
    const observed = () =>
      getLearnedAgentModels(engine, runnerId) !== undefined;
    this.request(runnerId, engine);
    if (!observed()) await this.settled(runnerId, engine);
    if (!observed()) return false;
    const model = request.model?.trim() || agentModelDefaults(runnerId)[engine];
    const option = getAgentModelOptions(engine, runnerId).find(
      (choice) => choice.id === model
    );
    if (
      request.effort != null &&
      model &&
      option &&
      option.effort === undefined
    ) {
      // An in-flight default listing may already supply this model's effort.
      await this.settled(runnerId, engine);
      const updated = getAgentModelOptions(engine, runnerId).find(
        (choice) => choice.id === model
      );
      if (updated && updated.effort === undefined) {
        this.request(runnerId, engine, model);
        await this.settled(runnerId, engine, model);
      }
    }
    return true;
  }
  /** A successful installation/update or sign-in invalidates durable freshness. */
  invalidate(runnerId: string, engine: AgentType): void {
    if (this.closed) return;
    const entry = this.state(runnerId, engine);
    entry.generation++;
    entry.success = Number.NEGATIVE_INFINITY;
    entry.retryAt = 0;
    entry.dirty = true;
    if (entry.pending) entry.again = true;
    else this.request(runnerId, engine);
  }
  private async refresh(
    runnerId: string,
    engine: AgentType,
    entry: Entry,
    target: Target,
    model?: string
  ) {
    const now = () => this.deps.now?.() ?? Date.now();
    const key = namespaced(target.settings, `agent_models_refresh:${engine}`);
    const generation = entry.generation;
    const engineGeneration = this.state(runnerId, engine).generation;
    const current = () =>
      generation === entry.generation &&
      engineGeneration === this.state(runnerId, engine).generation;
    try {
      if (entry.dirty) {
        await setSetting(
          this.deps.pool,
          key,
          JSON.stringify({ refreshedAt: null })
        );
        if (current()) entry.dirty = false;
      }
      if (!target.enabled || !target.online || target.blocked || this.closed)
        return;
      if (entry.success === undefined && !model) {
        const raw = await getSetting(this.deps.pool, key);
        let value = Number.NEGATIVE_INFINITY;
        try {
          const timestamp: unknown = raw && JSON.parse(raw)?.refreshedAt;
          if (typeof timestamp === "string") value = Date.parse(timestamp);
        } catch {
          /* Corrupt freshness is stale. */
        }
        entry.success = Number.isFinite(value)
          ? value
          : Number.NEGATIVE_INFINITY;
      }
      if (
        (entry.success !== undefined &&
          now() - entry.success < MODEL_REFRESH_AGE_MS) ||
        this.closed
      )
        return;
      entry.retryAt = now() + MODEL_REFRESH_BACKOFF_MS;
      const inventory = await boundedCall(target.calls, "engine.list", {
        refresh: true,
        include: ["signIn", "actions"],
      });
      const installed = inventory.entries.find((row) => row.id === engine);
      // Engines without a global login action (OpenCode) use provider-specific
      // authentication. Managed sign-ins must be positively authenticated.
      if (
        !installed?.installed ||
        (installed.signedIn !== true && installed.actions.includes("login"))
      )
        return;
      if (this.closed || !current()) return;
      const result = await boundedCall(target.calls, "engine.models", {
        engine,
        ...(model && { model }),
      });
      if (this.closed || !current()) return;
      const refreshedAt = new Date(now()).toISOString();
      const changed = this.deps.learn
        ? await this.deps.learn(
            runnerId,
            engine,
            result,
            target.settings,
            refreshedAt,
            model
          )
        : await recordDiscoveredModels(
            this.deps.pool,
            engine,
            result,
            { runnerId, settings: target.settings },
            refreshedAt,
            model
          );
      if (this.closed || !current()) return;
      entry.success = Date.parse(refreshedAt);
      entry.retryAt = 0;
      if (model) {
        const catalogEntry = this.state(runnerId, engine);
        catalogEntry.success = entry.success;
        catalogEntry.retryAt = 0;
      }
      if (changed) this.deps.changed?.(runnerId, engine);
    } catch (error) {
      entry.retryAt = now() + MODEL_REFRESH_BACKOFF_MS;
      this.deps.failed?.({
        runnerId,
        engine,
        code: error instanceof RunnerCallError ? error.code : "refresh_failed",
      });
    }
  }
  /** Join pending work for launch validation and fixture tests; never for pickers. */
  async settled(
    runnerId: string,
    engine: AgentType,
    model?: string
  ): Promise<void> {
    const entry = this.state(runnerId, engine, model);
    while (entry.pending) await entry.pending;
  }
  close() {
    this.closed = true;
  }
}

/** Bound transports which cannot yet consume an AbortSignal too. No retry timer. */
async function boundedCall<K extends "engine.list" | "engine.models">(
  calls: EngineCalls,
  op: K,
  request: import("@dispatch/runner-protocol/contract").Req<K>
): Promise<Res<K>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      calls.call(op, request, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new RunnerCallError({
              code: "timeout",
              message: "Model refresh timed out.",
            })
          );
        }, 20_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
