import type {
  HarnessTokenCounts,
  HarnessUsageProvider,
} from "@dispatch/shared";
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

import { useHarnessUsage } from "./use-harness-usage";

export function formatUsd(value: number): string {
  return value < 10
    ? `$${value.toFixed(2)}`
    : `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function totalTokens(t: HarnessTokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/** The spend figure the bar measures: the provider's own bill when we can read it. */
export function spendOf(provider: HarnessUsageProvider): {
  usd: number | null;
  source: "billed" | "logged";
} {
  if (provider.billed) return { usd: provider.billed.usd, source: "billed" };
  return { usd: provider.logged.usd, source: "logged" };
}

function BudgetBar({
  spent,
  budget,
}: {
  spent: number;
  budget: number;
}): JSX.Element {
  const ratio = budget > 0 ? spent / budget : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
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
      aria-label={`${pct}% of budget used`}
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

function ProviderRow({
  provider,
}: {
  provider: HarnessUsageProvider;
}): JSX.Element {
  const spend = spendOf(provider);
  const budget = provider.budgetUsd;
  return (
    <div
      className="rounded-md border border-border/60 px-3 py-2.5"
      data-testid="harness-usage-provider"
      data-provider={provider.id}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-foreground">
          {provider.label}
        </span>
        <span className="font-terminal text-[10.5px] text-muted-foreground">
          {provider.keyEnv}
          {provider.hasKey ? "" : " · not set"}
        </span>
        <span
          className="ml-auto text-sm tabular-nums text-foreground"
          data-testid="harness-usage-spend"
        >
          {spend.usd === null ? "—" : formatUsd(spend.usd)}
          {budget ? (
            <span className="text-muted-foreground">
              {" "}
              of {formatUsd(budget)}
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-1.5">
        {budget && spend.usd !== null ? (
          <BudgetBar spent={spend.usd} budget={budget} />
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {spend.usd === null
              ? "No spend figure: neither a billing API nor prices for these models."
              : "Spend this month. Set a budget in Settings → Agents → Usage budgets for a bar."}
          </p>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>
          {spend.source === "billed"
            ? "Billed by the provider"
            : "Estimated from the harness logs"}
        </span>
        {provider.balance ? (
          <span data-testid="harness-usage-balance">
            Balance {formatUsd(provider.balance.total)}{" "}
            {provider.balance.currency}
            {provider.balance.available ? "" : " · unavailable"}
          </span>
        ) : null}
        {provider.billed && provider.logged.usd !== null ? (
          <span>Logs say {formatUsd(provider.logged.usd)}</span>
        ) : null}
        <span>{formatTokens(totalTokens(provider.logged.tokens))} tokens</span>
      </div>
      {provider.logged.models.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5 font-terminal text-[10.5px] text-muted-foreground">
          {provider.logged.models.slice(0, 4).map((m) => (
            <li key={m.model} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {m.model}
              </span>
              <span className="tabular-nums">
                {formatTokens(totalTokens(m.tokens))}
              </span>
              <span className="w-14 text-right tabular-nums">
                {m.usd === null ? "—" : formatUsd(m.usd)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {provider.error ? (
        <p
          className="mt-1.5 text-[11px] text-status-waiting"
          data-testid="harness-usage-error"
        >
          {provider.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the provider keys have been used for this month, one card per key,
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
  const month = usage.data
    ? // The month starts at 00:00 UTC; local time would name the wrong month.
      new Date(usage.data.monthStart).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="harness-usage-dialog">
        <DialogHeader>
          <DialogTitle>API usage</DialogTitle>
          <DialogDescription>
            {month ? `Spend since the start of ${month}` : "Spend this month"},
            per provider key the harness can use.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {usage.isLoading ? (
            <p className="text-xs text-muted-foreground">
              Asking the providers…
            </p>
          ) : usage.error ? (
            <p className="text-xs text-destructive" role="alert">
              {usage.error.message}
            </p>
          ) : usage.data?.providers.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No provider keys are set in the server environment.
            </p>
          ) : (
            usage.data?.providers.map((p) => (
              <ProviderRow key={p.id} provider={p} />
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
