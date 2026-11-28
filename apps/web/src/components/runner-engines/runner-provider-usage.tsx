import { PlanLimits, useNow } from "./provider-usage";
import type { EngineScope } from "@dispatch/runner-protocol/engine-management";
import { Link } from "react-router-dom";

import {
  useRunnerProviderUsage,
  useRunnerEngineInventory,
} from "@/hooks/use-runner-engines";

export function RunnerProviderUsage({
  runnerId,
  scope = { kind: "runner", runnerId },
  allowReset = false,
}: {
  runnerId: string;
  scope?: EngineScope;
  allowReset?: boolean;
}) {
  const now = useNow(true);
  const inventory = useRunnerEngineInventory(scope);
  const accountEntries = inventory.data?.entries?.filter(
    (entry) => entry.id === "claude" || entry.id === "codex"
  );
  const canReadUsage =
    accountEntries?.some(
      (entry) => entry.installed && entry.signedIn !== false
    ) ?? false;
  const usage = useRunnerProviderUsage(runnerId, canReadUsage, scope);
  return (
    <section aria-label="Runner plan limits" className="space-y-2 text-body-sm">
      {!canReadUsage && <h4 className="font-medium">Plan limits</h4>}
      {accountEntries && !canReadUsage && (
        <p className="text-muted-foreground">
          <Link
            className="underline"
            to={{
              pathname: "/settings/runners",
              search: `?${new URLSearchParams({ runner: runnerId })}`,
              hash: "#runner-agent-engines",
            }}
            onClick={() =>
              document
                .getElementById("runner-agent-engines")
                ?.scrollIntoView({ block: "start" })
            }
          >
            Set up Claude or Codex
          </Link>{" "}
          to see usage here.
        </p>
      )}
      {canReadUsage && (
        <PlanLimits
          enabled
          plans={usage}
          now={now}
          scope={scope}
          allowReset={allowReset}
        />
      )}
    </section>
  );
}
