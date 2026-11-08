import type { RoutingDiagnostic } from "@dispatch/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
const choiceLabel = (choice?: string) =>
  choice === "initiating_discussion"
    ? "Thread"
    : choice === "home_root"
      ? "Root"
      : choice === "keep_existing_default"
        ? "Keep default"
        : "Unavailable";
export function routingLabel(d: RoutingDiagnostic) {
  if (d.status === "pending") return "Routing…";
  if (d.mode === "shadow")
    return `Shadow: ${d.status === "ok" ? choiceLabel(d.choice) : "Fallback"}`;
  if (d.status !== "ok" || d.reason === "Below threshold; default preserved")
    return `Fallback: ${d.actual}`;
  if (d.reason === "Explicit route preserved")
    return d.actual === "Thread" ? "Kept thread" : "Kept root";
  return d.actual;
}
export function RoutingDecision({
  diagnostic: d,
  agentName,
}: {
  diagnostic: RoutingDiagnostic;
  agentName?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={agentName ?? d.agentId}
          className="text-[11px] text-muted-foreground hover:text-foreground"
          aria-label={`Routing details: ${routingLabel(d)}`}
        >
          {routingLabel(d)}
          {d.latencyMs !== undefined && ` · ${Math.round(d.latencyMs)} ms`}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] text-xs space-y-2"
      >
        <p className="font-medium">Routing decision</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>Agent</dt>
          <dd className="break-all">{agentName ?? d.agentId}</dd>
          <dt>Actual route</dt>
          <dd>{d.actual}</dd>
          <dt>Model choice</dt>
          <dd>{choiceLabel(d.choice)}</dd>
          {d.probabilities.map((p) => (
            <div key={p.value} className="contents">
              <dt>P({choiceLabel(p.value)})</dt>
              <dd>{(p.probability * 100).toFixed(1)}%</dd>
            </div>
          ))}
          <dt>Confidence</dt>
          <dd>
            {d.confidence === undefined
              ? "Unavailable"
              : d.confidence.toFixed(3)}
          </dd>
          <dt>Latency</dt>
          <dd>
            {d.latencyMs === undefined
              ? "Unavailable"
              : `${Math.round(d.latencyMs)} ms`}
          </dd>
          <dt>Est. cost</dt>
          <dd>
            {d.costUsd === null ? "Unpriced" : `USD ${d.costUsd.toFixed(8)}`}
          </dd>
        </dl>
        <p>{d.reason}</p>
        {d.costBasis === "uncached-estimate" && (
          <p className="text-muted-foreground">
            Cache breakdown unavailable; assumes all input at the uncached rate.
          </p>
        )}
        <p className="text-muted-foreground">
          Confidence is separate from choice probabilities. No written model
          explanation is returned. Cost is an estimate, not billing.
        </p>
      </PopoverContent>
    </Popover>
  );
}
