import type {
  HarnessAuthStatus,
  HarnessEngineId,
  HarnessProviderPlan,
  HarnessUsageEngine,
} from "@dispatch/shared";
import { LogIn, RefreshCw } from "lucide-react";

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
import { AuthStatusBadge } from "./auth-status-badge";
import { useHarnessAuth } from "./use-harness-auth";
import { useHarnessProviderUsage } from "./use-provider-usage";

export type ContextUsage = {
  used: number;
  size: number;
  costUsd: number | null;
};

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

function UsageBar({
  spent,
  budget,
  label,
  remaining = false,
}: {
  spent: number;
  budget: number;
  label: string;
  remaining?: boolean;
}): JSX.Element {
  const ratio = budget > 0 ? spent / budget : 0;
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const shown = Math.round(remaining ? 100 - pct : pct);
  const text = `${label}: ${shown}% ${remaining ? "left" : "of budget used"}`;
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
      aria-valuenow={shown}
      aria-valuetext={text}
      aria-label={text}
      data-testid="harness-usage-bar"
      data-pct={shown}
    >
      <div
        className={cn("h-full rounded-full", tone)}
        style={{ width: `${shown}%` }}
      />
    </div>
  );
}

function resetLabel(value: string | null): string | null {
  if (!value) return null;
  const reset = new Date(value);
  if (Number.isNaN(reset.valueOf())) return null;
  const delta = reset.valueOf() - Date.now();
  if (delta <= 0) return "reset due";
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `resets in ${hours}h`;
  return `resets in ${Math.ceil(hours / 24)}d`;
}

function ProviderPlan({ plan }: { plan?: HarnessProviderPlan }): JSX.Element {
  return (
    <section className="space-y-2" data-testid="harness-provider-plan">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-foreground">Provider plan</h3>
        {plan?.plan ? (
          <span className="text-[11px] text-muted-foreground">{plan.plan}</span>
        ) : null}
      </div>
      {plan?.windows.length ? (
        <div className="space-y-2.5 rounded-md border border-border/60 px-3 py-2.5">
          {plan.windows.map((window) => (
            <div className="space-y-1" key={window.id}>
              <div className="flex items-center justify-between gap-3 text-[11px]">
                <span>{window.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {plan.engineId === "codex"
                    ? `${Math.round(100 - window.usedPercent)}% left`
                    : `${Math.round(window.usedPercent)}% used`}
                  {resetLabel(window.resetsAt)
                    ? ` · ${resetLabel(window.resetsAt)}`
                    : ""}
                </span>
              </div>
              <UsageBar
                spent={window.usedPercent}
                budget={100}
                label={`${window.label} provider limit`}
                remaining={plan.engineId === "codex"}
              />
            </div>
          ))}
          {plan.spend ? (
            <p className="text-[11px] tabular-nums text-muted-foreground">
              Extra usage: {formatUsd(plan.spend.used)} of{" "}
              {formatUsd(plan.spend.limit)}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rounded-md border border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
          {plan?.unavailableReason ??
            "Provider plan usage is not available yet."}
        </p>
      )}
    </section>
  );
}

function ContextSection({
  usage,
}: {
  usage: ContextUsage | null;
}): JSX.Element {
  const percent = usage?.size ? (usage.used / usage.size) * 100 : 0;
  return (
    <section className="space-y-2" data-testid="harness-context-usage">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-foreground">Current context</h3>
        {usage ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {formatTokens(usage.used)} of {formatTokens(usage.size)} ·{" "}
            {Math.round(percent)}%
          </span>
        ) : null}
      </div>
      {usage ? (
        <UsageBar
          spent={usage.used}
          budget={usage.size}
          label="Model context"
        />
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Available after this provider reports usage for the current session.
        </p>
      )}
    </section>
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
          <UsageBar
            spent={cost}
            budget={engine.budgetUsd}
            label={engine.label}
          />
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

function ApiUsage({
  usage,
  selectedUsage,
}: {
  usage: ReturnType<typeof useHarnessUsage>;
  selectedUsage?: HarnessUsageEngine;
}): JSX.Element {
  return (
    <section className="space-y-2" data-testid="harness-api-usage">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-foreground">API usage</h3>
        <span className="text-[10.5px] text-muted-foreground">
          {usage.data
            ? `since ${new Date(usage.data.monthStart).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`
            : ""}
        </span>
      </div>
      {usage.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading usage…</p>
      ) : usage.error ? (
        <p className="text-xs text-destructive" role="alert">
          {usage.error.message}
        </p>
      ) : selectedUsage ? (
        <EngineRow engine={selectedUsage} />
      ) : (
        <p className="text-xs text-muted-foreground">
          API usage is not available for this provider yet.
        </p>
      )}
      <p className="text-[10.5px] text-muted-foreground">
        Reported through ACP and may differ from the provider invoice.
      </p>
    </section>
  );
}

function UnknownBilling({
  auth,
  onLogin,
  loginPending,
}: {
  auth?: HarnessAuthStatus;
  onLogin?: () => void | Promise<void>;
  loginPending: boolean;
}): JSX.Element {
  const signedOut = auth?.kind === "not_signed_in";
  return (
    <section className="space-y-2" data-testid="harness-billing-unknown">
      <h3 className="text-xs font-medium text-foreground">Billing usage</h3>
      <p className="rounded-md border border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
        {signedOut
          ? "Sign in to this provider to see its billing usage."
          : "Could not determine whether this provider uses a subscription or API key."}
      </p>
      {signedOut && onLogin ? (
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={() => void onLogin()}
          disabled={loginPending}
          data-testid="harness-usage-login"
        >
          <LogIn className="mr-1.5 h-3.5 w-3.5" />
          {loginPending ? "Opening Console…" : "Log in"}
        </Button>
      ) : null}
    </section>
  );
}

export function UsageDialog({
  open,
  onOpenChange,
  providerId,
  contextUsage,
  loginRequired = false,
  loginPending = false,
  onLogin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId?: HarnessEngineId;
  contextUsage?: ContextUsage | null;
  loginRequired?: boolean;
  loginPending?: boolean;
  onLogin?: () => void | Promise<void>;
}): JSX.Element {
  const usage = useHarnessUsage(open);
  const auth = useHarnessAuth(open);
  const providerUsage = useHarnessProviderUsage(open);
  const selectedPlan = providerUsage.data?.providers.find(
    (item) => item.engineId === providerId
  );
  const selectedUsage = usage.data?.engines.find(
    (item) => item.id === providerId
  );
  const selectedAuth = auth.data?.engines.find(
    (item) => item.engineId === providerId
  );
  const billingMethod = loginRequired
    ? "unknown"
    : selectedAuth?.kind === "subscription"
      ? "subscription"
      : selectedAuth?.kind === "api_key"
        ? "api_key"
        : "unknown";
  const displayedAuth = loginRequired
    ? selectedAuth
      ? {
          ...selectedAuth,
          kind: "not_signed_in" as const,
          label: "Sign in required",
        }
      : providerId
        ? {
            engineId: providerId,
            kind: "not_signed_in" as const,
            label: "Sign in required",
          }
        : undefined
    : selectedAuth;
  const providerLabel = selectedUsage?.label ?? "Selected provider";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(85vh,46rem)] max-w-md overflow-y-auto"
        data-testid="harness-usage-dialog"
      >
        <DialogHeader>
          <DialogTitle>Usage</DialogTitle>
          <DialogDescription>
            {providerLabel}{" "}
            {billingMethod === "subscription"
              ? "subscription usage"
              : billingMethod === "api_key"
                ? "API usage"
                : "usage"}
          </DialogDescription>
        </DialogHeader>
        {displayedAuth ? <AuthStatusBadge auth={displayedAuth} /> : null}
        <ContextSection usage={contextUsage ?? null} />
        {billingMethod === "subscription" ? (
          <ProviderPlan plan={selectedPlan} />
        ) : billingMethod === "api_key" ? (
          <ApiUsage usage={usage} selectedUsage={selectedUsage} />
        ) : (
          <UnknownBilling
            auth={displayedAuth}
            onLogin={onLogin}
            loginPending={loginPending}
          />
        )}
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
            onClick={() => {
              void usage.refetch();
              void auth.refetch();
              void providerUsage.refetch();
            }}
            disabled={
              usage.isFetching || auth.isFetching || providerUsage.isFetching
            }
            data-testid="harness-usage-refresh"
          >
            <RefreshCw
              className={cn(
                "mr-1 h-3 w-3",
                (usage.isFetching ||
                  auth.isFetching ||
                  providerUsage.isFetching) &&
                  "animate-spin"
              )}
            />
            Refresh
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
