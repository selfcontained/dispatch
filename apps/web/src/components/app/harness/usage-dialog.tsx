import type { HarnessUsageEngine } from "@dispatch/shared";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { ProviderIcon } from "./provider-icon";
import { useHarnessUsage } from "./use-harness-usage";

export function formatUsd(value: number): string {
  return value < 10 || !Number.isInteger(value)
    ? `$${value.toFixed(2)}`
    : `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function BudgetBar({
  spent,
  budget,
  label,
}: {
  spent: number;
  budget: number;
  label: string;
}): JSX.Element {
  const ratio = budget > 0 ? spent / budget : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  /** What a screen reader hears. */
  const text = `${label}: ${pct}% of budget used`;
  const tone =
    ratio >= 0.9
      ? "bg-status-blocked"
      : ratio >= 0.7
        ? "bg-status-waiting"
        : "bg-status-working";
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={text}
      aria-label={text}
      data-testid="harness-usage-bar"
      data-pct={pct}
    >
      <div
        className={cn("h-full rounded-full", tone)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function EngineRow({ engine }: { engine: HarnessUsageEngine }): JSX.Element {
  const cost = engine.costUsd;
  return (
    <section
      className="space-y-1.5 rounded-md border border-border/60 px-3 py-2"
      data-testid={`harness-usage-engine-${engine.id}`}
    >
      <div className="flex items-center gap-2 text-[12px]">
        <ProviderIcon provider={engine.id} />
        <span className="font-medium text-foreground">{engine.label}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {engine.reportsUsage
            ? formatTokens(engine.tokens)
            : "not reported over ACP"}
        </span>
        {engine.reportsUsage ? (
          <span className="tabular-nums text-foreground">
            {cost !== null ? formatUsd(cost) : "no cost reported"}
          </span>
        ) : null}
      </div>
      {cost !== null && engine.budgetUsd ? (
        <div className="space-y-1">
          <BudgetBar
            spent={cost}
            budget={engine.budgetUsd}
            label={engine.label}
          />
          {/* The bar alone never says what the fraction is of. */}
          <p
            className="text-right text-[10.5px] tabular-nums text-muted-foreground"
            data-testid="harness-usage-budget-caption"
          >
            {formatUsd(cost)} of {formatUsd(engine.budgetUsd)}
          </p>
        </div>
      ) : null}
      {engine.agents.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          no agents this month
        </p>
      ) : (
        <ul className="space-y-0.5 pl-5 text-[11px] text-muted-foreground">
          {engine.agents.map((a) => (
            <li key={a.agentId} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {a.name}
              </span>
              {engine.reportsUsage ? (
                <span className="tabular-nums">{formatTokens(a.tokens)}</span>
              ) : null}
              {a.costUsd !== null ? (
                <span className="tabular-nums">{formatUsd(a.costUsd)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What the engines have been used for this month, one card per engine,
 * opened from the composer's usage chip or the /usage command.
 */
export function UsageDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const usage = useHarnessUsage(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="harness-usage-dialog">
        <DialogHeader>
          <DialogTitle>Usage this month</DialogTitle>
          <DialogDescription>
            {usage.data
              ? `since ${new Date(usage.data.monthStart).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })} (UTC)`
              : "Usage this month"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {usage.isLoading ? (
            // The report is month-to-date turn rows out of the database, not
            // a call to anyone.
            <p className="text-xs text-muted-foreground">Loading usage…</p>
          ) : usage.error ? (
            <p className="text-xs text-destructive" role="alert">
              {usage.error.message}
            </p>
          ) : (
            usage.data?.engines.map((engine) => (
              <EngineRow key={engine.id} engine={engine} />
            ))
          )}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] text-muted-foreground">
            {usage.data
              ? `As of ${new Date(usage.data.generatedAt).toLocaleTimeString()}`
              : ""}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void usage.refetch()}
            disabled={usage.isFetching}
            data-testid="harness-usage-refresh"
          >
            <RefreshCw
              className={cn("mr-1 h-3 w-3", usage.isFetching && "animate-spin")}
            />
            Refresh
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
