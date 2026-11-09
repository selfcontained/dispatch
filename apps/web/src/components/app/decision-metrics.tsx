import type { DecisionMetrics } from "@dispatch/shared";
import { useDecisionMetrics, type ActivityRange } from "@/hooks/use-activity";
import { StatCard } from "./stat-card";
import { Button } from "@/components/ui/button";

const ms = (value: number | null) =>
  value === null ? "—" : `${Math.round(value)} ms`;
function Metrics({
  title,
  data,
  steering,
}: {
  title: string;
  data: DecisionMetrics;
  steering?: boolean;
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium">{title}</h3>
      <div className="flex flex-wrap gap-2 sm:gap-3">
        <StatCard
          label="API attempts"
          value={data.attempts}
          sub={`${data.pending} pending · ${data.skipped} skipped`}
        />
        {steering ? (
          <>
            <StatCard
              label="Steered into active work"
              value={data.steered}
              sub="Accepted by the host"
            />
            <StatCard label="Queued for next turn" value={data.queued} />
          </>
        ) : (
          <StatCard label="Routing choices applied" value={data.applied} />
        )}
        <StatCard label="Existing default kept" value={data.defaults} />
        <StatCard
          label="API failures"
          value={data.failures}
          sub={
            steering
              ? `${data.expired} expired · ${data.overridden} overridden`
              : undefined
          }
        />
        <StatCard
          label="API latency"
          value={ms(data.medianMs)}
          sub={`p95 ${ms(data.p95Ms)}`}
        />
        <StatCard
          label="Known estimated API cost"
          value={
            data.attempts > 0 && data.unknownCostCalls === data.attempts
              ? "—"
              : `$${data.knownEstimatedUsd.toFixed(5)}`
          }
          sub={
            data.unknownCostCalls
              ? `${data.unknownCostCalls} attempts unpriced`
              : "Usage-based estimate"
          }
        />
      </div>
      {data.attempts === 0 && (
        <p className="text-xs text-muted-foreground">
          No decisions in this range. Enable{" "}
          {steering ? "steering" : "reply routing"} in Settings → AI routing to
          start collecting metrics.
        </p>
      )}
    </div>
  );
}
export function DecisionMetricsSection({
  range,
  dailyDate,
}: {
  range: ActivityRange;
  dailyDate?: string;
}) {
  const query = useDecisionMetrics(range, dailyDate);
  return (
    <section aria-labelledby="decision-metrics-heading" className="space-y-5">
      <div>
        <h2 id="decision-metrics-heading" className="text-sm font-medium">
          AI decisions
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Selected time range, limited to retained diagnostics: up to 14 days
          and 2,000 records per feature. Counts describe delivery, not decision
          accuracy. Costs are estimates, not billing.
        </p>
      </div>
      {query.isPending && (
        <p className="text-xs text-muted-foreground">
          Loading decision metrics…
        </p>
      )}
      {query.error && (
        <div role="alert" className="text-xs text-destructive">
          Couldn’t load decision metrics.{" "}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {query.data && (
        <>
          <Metrics title="Reply routing" data={query.data.routing} />
          <Metrics
            title="Message steering"
            data={query.data.steering}
            steering
          />
        </>
      )}
    </section>
  );
}
