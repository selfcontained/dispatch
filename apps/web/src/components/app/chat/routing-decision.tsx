import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RoutingDiagnostic } from "@dispatch/shared";
const choiceLabel = (choice?: string) =>
  choice === "initiating_discussion"
    ? "Thread"
    : choice === "home_root"
      ? "Root"
      : choice === "keep_existing_default"
        ? "Keep default"
        : "Unavailable";
/** Routing fields inside the generic message metadata view. */
export function RoutingDecisionDetails({
  diagnostic: d,
  agentName,
}: {
  diagnostic: RoutingDiagnostic;
  agentName?: string;
}) {
  const applied = d.reason === "Recommendation applied";
  const modelChoice = choiceLabel(d.choice);
  const choiceProbability = d.probabilities.find(
    (p) => p.value === d.choice
  )?.probability;
  const decision =
    d.mode === "shadow"
      ? "Observed only"
      : applied
        ? "Recommendation used"
        : d.status === "pending"
          ? "Routing"
          : d.reason === "Explicit route preserved"
            ? "Explicit destination kept"
            : "Default kept";
  return (
    <section
      className="space-y-2 border-t border-border/60 pt-2 text-xs"
      aria-label={`Routing for ${agentName ?? d.agentId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Reply placement
        </h3>
        <span className="max-w-[60%] truncate text-[10px] text-muted-foreground">
          {agentName ?? d.agentId}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="border-primary/30 bg-primary/10 px-2 py-0.5 text-xs normal-case tracking-normal text-primary">
          {d.actual}
        </Badge>
        <span
          className={cn(
            "text-[11px]",
            applied ? "text-primary" : "text-muted-foreground"
          )}
        >
          {decision}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground">
        {d.reason === "Below threshold; default preserved"
          ? "Override requirements not met"
          : d.reason === "Recommendation applied"
            ? `Router recommended ${modelChoice}`
            : d.reason}
      </p>
      <div className="space-y-1.5 rounded-md bg-muted/25 px-2 py-1.5">
        <div className="text-[10px] text-muted-foreground">
          Override gate · both require ≥80%
        </div>
        {[
          { label: `${modelChoice} preference`, value: choiceProbability },
          { label: "Decision confidence", value: d.confidence },
        ].map((score) => (
          <div
            key={score.label}
            className="grid grid-cols-[8rem_1fr_2.5rem] items-center gap-2 text-[10px]"
          >
            <span className="truncate text-muted-foreground">
              {score.label}
            </span>
            <div className="relative h-1 overflow-hidden rounded-full bg-muted">
              <span
                className={cn(
                  "block h-full rounded-full",
                  score.value !== undefined && score.value >= 0.8
                    ? "bg-primary"
                    : "bg-primary/50"
                )}
                style={{ width: `${(score.value ?? 0) * 100}%` }}
              />
              <span className="absolute inset-y-0 left-[80%] w-px bg-foreground/60" />
            </div>
            <span className="text-right tabular-nums">
              {score.value === undefined
                ? "—"
                : `${Math.round(score.value * 100)}%`}
            </span>
          </div>
        ))}
      </div>
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center justify-between py-1 text-[10px] text-muted-foreground hover:text-foreground">
          Decision details{" "}
          <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-1 text-[10px]">
          <div className="text-muted-foreground">
            Destination preferences · total 100%
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            {d.probabilities.map((p) => (
              <div key={p.value} className="contents">
                <dt
                  className={
                    p.value === d.choice
                      ? "font-medium text-primary"
                      : "text-muted-foreground"
                  }
                >
                  {choiceLabel(p.value)}
                  {p.value === d.choice ? " · recommended" : ""}
                </dt>
                <dd className="text-right tabular-nums">
                  {(p.probability * 100).toFixed(1)}%
                </dd>
              </div>
            ))}
          </dl>
          <div className="border-t border-border/40 pt-2">
            <p className="mb-1 text-muted-foreground">Override requires both</p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">
                Recommended destination ≥80%
              </dt>
              <dd className="text-right tabular-nums">
                {choiceProbability === undefined
                  ? "—"
                  : `${(choiceProbability * 100).toFixed(1)}% ${choiceProbability >= 0.8 ? "✓" : "×"}`}
              </dd>
              <dt className="text-muted-foreground">API confidence ≥80%</dt>
              <dd className="text-right tabular-nums">
                {d.confidence === undefined
                  ? "—"
                  : `${(d.confidence * 100).toFixed(1)}% ${d.confidence >= 0.8 ? "✓" : "×"}`}
              </dd>
            </dl>
            <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
              Preferences compare destinations; confidence scores the decision
              as a whole.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <Collapsible className="border-t border-border/40 pt-1">
        <CollapsibleTrigger className="group flex w-full items-center justify-between py-1 text-[10px] text-muted-foreground hover:text-foreground">
          Routing API usage{" "}
          <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 py-1 text-[10px]">
            <dt className="text-muted-foreground">Latency · est. cost</dt>
            <dd className="text-right tabular-nums">
              {d.latencyMs === undefined
                ? "—"
                : `${Math.round(d.latencyMs)} ms`}{" "}
              · {d.costUsd === null ? "Unpriced" : `$${d.costUsd.toFixed(8)}`}
              {d.costBasis === "uncached-estimate" ? " (uncached)" : ""}
            </dd>
            <dt className="text-muted-foreground">Input tokens</dt>
            <dd className="text-right tabular-nums">
              {d.inputTokens ?? "Unavailable"}
            </dd>
            <dt className="text-muted-foreground">Cache read / write</dt>
            <dd className="text-right tabular-nums">
              {d.cachedReadTokens ?? "—"} / {d.cacheWriteTokens ?? "—"}
            </dd>
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
