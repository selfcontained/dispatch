import { PlanLimits, useNow } from "./provider-usage";
import type { EngineScope } from "@dispatch/runner-protocol/engine-management";
import { useScopedProviderUsage } from "@/hooks/use-runner-engines";

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
  const usage = useScopedProviderUsage(scope, true);
  return (
    <section aria-label="Runner plan limits" className="space-y-2 text-body-sm">
      {usage.configured === undefined ? (
        <h4 className="font-medium">Plan limits</h4>
      ) : (
        <PlanLimits
          enabled
          plans={usage}
          now={now}
          scope={scope}
          allowReset={allowReset}
          configured={usage.configured}
        />
      )}
    </section>
  );
}
