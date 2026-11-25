import type { DiffStats } from "@dispatch/shared";

export type DiffStatsComputation =
  | { kind: "success"; stats: DiffStats }
  | { kind: "no-data"; stats: null }
  | { kind: "partial"; stats: DiffStats; error: unknown }
  | { kind: "failure"; stats: null; error: unknown };
