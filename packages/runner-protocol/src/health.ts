const maintenanceSteps = [
  "prepare",
  "stage",
  "stop",
  "signal",
  "replace",
  "start",
  "restore",
  "unit",
] as const;
export type RunnerMaintenanceFailure = {
  step: (typeof maintenanceSteps)[number];
  exitCode: number;
  at: string;
};

export function parseMaintenanceFailure(
  input: unknown
): RunnerMaintenanceFailure | undefined {
  if (!input || typeof input !== "object") return;
  const { step, exitCode, at } = input as Record<string, unknown>;
  const knownStep = maintenanceSteps.find((item) => item === step);
  if (
    !knownStep ||
    typeof exitCode !== "number" ||
    !Number.isInteger(exitCode) ||
    exitCode < 1 ||
    exitCode > 255 ||
    typeof at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at) ||
    !Number.isFinite(Date.parse(at))
  )
    return;
  return { step: knownStep, exitCode, at };
}

/** An instantaneous, replaceable sample. Capacity is relative to the runner environment. */
export type RunnerHealth = {
  version: string;
  revision?: string;
  maintenanceFailure?: RunnerMaintenanceFailure;
  sessions: number;
  working: number;
  cpuPercent: number | null;
  memoryUsed: number;
  memoryTotal: number;
};

export function parseRunnerHealth(input: unknown): RunnerHealth | null {
  if (!input || typeof input !== "object") return null;
  const {
    version,
    revision,
    maintenanceFailure,
    sessions,
    working,
    cpuPercent,
    memoryUsed,
    memoryTotal,
  } = input as Record<string, unknown>;
  const count = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (
    typeof version !== "string" ||
    !/^[\w.+-]{1,80}$/.test(version) ||
    !count(sessions) ||
    !count(working) ||
    working > sessions ||
    !count(memoryUsed) ||
    !count(memoryTotal) ||
    memoryUsed > memoryTotal ||
    (cpuPercent !== null &&
      (typeof cpuPercent !== "number" ||
        !Number.isFinite(cpuPercent) ||
        cpuPercent < 0 ||
        cpuPercent > 100))
  )
    return null;
  const failure = parseMaintenanceFailure(maintenanceFailure);
  return {
    version,
    sessions,
    working,
    cpuPercent,
    memoryUsed,
    memoryTotal,
    ...(typeof revision === "string" && /^[a-f0-9]{7,40}$/.test(revision)
      ? { revision }
      : {}),
    ...(failure ? { maintenanceFailure: failure } : {}),
  };
}
