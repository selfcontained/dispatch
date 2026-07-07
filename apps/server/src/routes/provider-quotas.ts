import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { ProviderQuotaService } from "../provider-quotas/service.js";
import type { ProviderQuotaSnapshotResponse } from "../provider-quotas/store.js";
import {
  isProviderQuotaTrackingEnabled,
  setProviderQuotaTrackingEnabled,
} from "../provider-quotas/settings.js";

type ProviderQuotaRouteDeps = {
  pool: Pool;
  service: ProviderQuotaService;
};

function groupSnapshots(snapshots: ProviderQuotaSnapshotResponse[]) {
  const providers = new Map<
    string,
    {
      provider: string;
      accounts: Array<{
        accountLabel: string | null;
        accountId: string | null;
        snapshots: ProviderQuotaSnapshotResponse[];
      }>;
    }
  >();

  for (const snapshot of snapshots) {
    const providerGroup =
      providers.get(snapshot.provider) ??
      (() => {
        const group = { provider: snapshot.provider, accounts: [] };
        providers.set(snapshot.provider, group);
        return group;
      })();
    const account = providerGroup.accounts.find(
      (entry) =>
        entry.accountId === snapshot.accountId &&
        entry.accountLabel === snapshot.accountLabel
    );
    if (account) {
      account.snapshots.push(snapshot);
    } else {
      providerGroup.accounts.push({
        accountLabel: snapshot.accountLabel,
        accountId: snapshot.accountId,
        snapshots: [snapshot],
      });
    }
  }

  return Array.from(providers.values());
}

export async function registerProviderQuotaRoutes(
  app: FastifyInstance,
  deps: ProviderQuotaRouteDeps
): Promise<void> {
  app.get("/api/v1/provider-quotas/settings", async () => {
    return {
      usageTrackingEnabled: await isProviderQuotaTrackingEnabled(deps.pool),
    };
  });

  app.post("/api/v1/provider-quotas/settings", async (request, reply) => {
    const body = request.body as { usageTrackingEnabled?: unknown };
    if (typeof body.usageTrackingEnabled !== "boolean") {
      return reply
        .code(400)
        .send({ error: "usageTrackingEnabled must be a boolean." });
    }
    await setProviderQuotaTrackingEnabled(deps.pool, body.usageTrackingEnabled);
    return { usageTrackingEnabled: body.usageTrackingEnabled };
  });

  app.get("/api/v1/provider-quotas", async () => {
    const usageTrackingEnabled = await isProviderQuotaTrackingEnabled(
      deps.pool
    );
    if (!usageTrackingEnabled) {
      return { usageTrackingEnabled, snapshots: [], providers: [] };
    }
    const snapshots = await deps.service.listLatest();
    return {
      usageTrackingEnabled,
      snapshots,
      providers: groupSnapshots(snapshots),
    };
  });

  app.post("/api/v1/provider-quotas/refresh", async () => {
    const usageTrackingEnabled = await isProviderQuotaTrackingEnabled(
      deps.pool
    );
    if (!usageTrackingEnabled) {
      return {
        usageTrackingEnabled,
        results: [],
        snapshots: [],
        providers: [],
      };
    }
    const results = await deps.service.refreshAll({ interaction: "manual" });
    const snapshots = await deps.service.listLatest();
    return {
      usageTrackingEnabled,
      results,
      snapshots,
      providers: groupSnapshots(snapshots),
    };
  });
}
