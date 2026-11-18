/** An instantaneous, replaceable sample. Capacity is relative to the runner environment. */
export type RunnerHealth = {
  version: string;
  sessions: number;
  working: number;
  cpuPercent: number | null;
  memoryUsed: number;
  memoryTotal: number;
};

export function parseRunnerHealth(input: unknown): RunnerHealth | null {
  if (!input || typeof input !== "object") return null;
  const { version, sessions, working, cpuPercent, memoryUsed, memoryTotal } =
    input as Record<string, unknown>;
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
  return { version, sessions, working, cpuPercent, memoryUsed, memoryTotal };
}
