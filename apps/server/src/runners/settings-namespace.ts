/** Storage identity is composition data, independent of a runner's wire ID. */
export type RunnerSettings = {
  runnerId: string;
  namespace: string;
  modelReports: "availability" | "history";
  updateLock: { sql: string; values?: string[] };
};

/** Main's durable local key and transaction-lock identity. */
export const localRunnerSettings: RunnerSettings = {
  runnerId: "local",
  namespace: "",
  modelReports: "availability",
  updateLock: { sql: "SELECT pg_advisory_xact_lock(1852271177, 1)" },
};

export function namespaced(
  runner: Pick<RunnerSettings, "namespace">,
  key: string
) {
  return `${runner.namespace}${key}`;
}

/** Enrolled composition escapes delimiters so unusual IDs stay distinct. */
export function enrolledRunnerSettings(runnerId: string): RunnerSettings {
  const namespace = `runner:${encodeURIComponent(runnerId)}:`;
  return {
    runnerId,
    namespace,
    modelReports: "history",
    updateLock: {
      sql: "SELECT pg_advisory_xact_lock(1852271177, hashtext($1))",
      values: [namespaced({ namespace }, "engine_update_operations")],
    },
  };
}
