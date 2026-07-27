import type { Pool } from "pg";

import type { AgentManager } from "../../agents/manager.js";
import type { ActivityEventRow } from "../../activity-metrics.js";

export type ActivityRouteDeps = {
  pool: Pool;
  agentManager: AgentManager;
  parseActivityQuery: (query: Record<string, unknown>) => {
    start: Date | null;
    end: Date | null;
    tz: string;
    granularity: "hour" | "day" | "week" | "month";
  };
  loadScopedActivityEvents: (
    aq: ReturnType<ActivityRouteDeps["parseActivityQuery"]>,
    opts?: { includeProjectDir?: boolean }
  ) => Promise<{ rows: ActivityEventRow[]; rangeStart: Date | null }>;
  timeRangeClause: (
    aq: ReturnType<ActivityRouteDeps["parseActivityQuery"]>,
    column: string,
    paramOffset?: number
  ) => { clause: string; params: unknown[] };
  dateTruncTz: (
    granularity: "hour" | "day" | "week" | "month",
    column: string,
    tz: string
  ) => string;
  escapeLike: (s: string) => string;
};
