import type { Pool } from "pg";

import { cleanExpiredSessions, isPasswordSet } from "../auth.js";

type CreateAuthRuntimeDeps = {
  pool: Pool;
  sessionCleanupIntervalMs: number;
};

export function createAuthRuntime(deps: CreateAuthRuntimeDeps) {
  const { pool, sessionCleanupIntervalMs } = deps;

  let passwordSetCache: boolean | null = null;
  let sessionCleanupTimer: NodeJS.Timeout | null = null;

  return {
    async isPasswordSetCached(): Promise<boolean> {
      if (passwordSetCache === null) {
        passwordSetCache = await isPasswordSet(pool);
      }
      return passwordSetCache;
    },

    invalidatePasswordSetCache(): void {
      passwordSetCache = null;
    },

    startSessionCleanupTimer(): void {
      if (sessionCleanupTimer) return;
      sessionCleanupTimer = setInterval(() => {
        void cleanExpiredSessions(pool).catch(() => null);
      }, sessionCleanupIntervalMs);
    },

    stopSessionCleanupTimer(): void {
      if (!sessionCleanupTimer) return;
      clearInterval(sessionCleanupTimer);
      sessionCleanupTimer = null;
    },
  };
}
