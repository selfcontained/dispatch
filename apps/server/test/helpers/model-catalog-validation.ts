import { vi } from "vitest";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { ModelCatalogRefresh } from "../../src/agents/model-catalog-refresh.js";
import { enrolledRunnerSettings } from "../../src/runners/settings-namespace.js";
import {
  onModelCatalogValidation,
  getAgentModelOptions,
  setLearnedAgentModels,
  type AgentModelOption,
} from "../../src/shared/agent-models.js";
import type { AgentType } from "../../src/shared/agent-types.js";

/** Current typed port + real atomic learner, without a host process or database. */
export function validationCatalogFixture(
  runnerId: string,
  engine: AgentType,
  models: AgentModelOption[],
  fail = false
) {
  const rows = new Map<string, string>();
  let transaction: Map<string, string> | undefined;
  const query = async (sql: string, args: string[] = []) => {
    if (sql === "BEGIN") transaction = new Map(rows);
    if (sql === "COMMIT" && transaction) {
      rows.clear();
      for (const [k, v] of transaction) rows.set(k, v);
      transaction = undefined;
    }
    if (sql === "ROLLBACK") transaction = undefined;
    if (sql.includes("FROM runner_registrations"))
      return { rows: [{ id: runnerId }] };
    const store = transaction ?? rows;
    if (sql.includes("INSERT INTO settings")) store.set(args[0]!, args[1]!);
    return {
      rows: store.has(args[0]!) ? [{ value: store.get(args[0]!) }] : [],
    };
  };
  const call = vi.fn(async (op: string) => {
    if (op === "engine.list")
      return {
        entries: [
          { id: engine, installed: true, signedIn: true, actions: ["login"] },
        ],
      };
    if (fail)
      throw new RunnerCallError({
        code: "unavailable",
        message: "Fixture listing unavailable",
      });
    return {
      defaultModel: models[0]?.id ?? null,
      current: models[0]?.id,
      models,
    };
  });
  const service = new ModelCatalogRefresh({
    pool: { query, connect: async () => ({ query, release() {} }) } as never,
    resolve: () => ({
      settings: enrolledRunnerSettings(runnerId),
      online: true,
      enabled: true,
      calls: { call } as never,
    }),
  });
  const stop = onModelCatalogValidation((id, type, request) =>
    service.validate(id, type, request)
  );
  return {
    call,
    close() {
      stop();
      service.close();
    },
  };
}

/** Explicitly model a prior report for tests of authoritative rejection. */
export function teachKnownSeedCatalogs() {
  for (const engine of ["claude", "codex"] as const)
    setLearnedAgentModels(engine, getAgentModelOptions(engine));
}
