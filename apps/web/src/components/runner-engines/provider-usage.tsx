import type {
  AgentUsageResponse,
  PlanLimitResets,
  PlanWindow,
  ProviderPlan,
} from "@dispatch/shared";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  agentModelLabel,
  useAgentModelCatalogData,
} from "@/hooks/use-agent-model-catalog";
import {
  useConsumeCodexReset,
  useProviderPlans,
} from "@/hooks/use-agent-usage";
import { formatTokenCount } from "@/lib/format";
import { cn } from "@/lib/utils";

import {
  contextRemainingPercent,
  remainingPercent,
  formatCost,
  formatCredits,
  formatExtraUsage,
  formatLimitResets,
  formatResetExpiry,
  formatResetExpiryDate,
  hasExpiringResets,
  resetExpiresSoon,
  reportAge,
  resetsIn,
} from "@/components/app/chat/composer-meta-format";
import { Alert } from "@/components/ui/alert";

import { LOCAL_ENGINE_SCOPE } from "@/lib/engine-management";
import type { EngineScope } from "@dispatch/runner-protocol/engine-management";
/**
 * The bar's colour: the provider's own warning level when it gives one
 * ("normal", "warning", anything worse), else by used capacity.
 */
function barTone(percent: number, severity?: string): string {
  if (severity) {
    return severity === "normal"
      ? "bg-success"
      : severity === "warning"
        ? "bg-warning"
        : "bg-danger";
  }
  return percent >= 90
    ? "bg-danger"
    : percent >= 70
      ? "bg-warning"
      : "bg-success";
}

function Bar({
  percent,
  usedPercent,
  label,
  severity,
}: {
  percent: number | null;
  usedPercent: number;
  label: string;
  severity?: string;
}): JSX.Element {
  return (
    <div
      className={BAR_TRACK_CLASS}
      role="progressbar"
      aria-label={`${label} capacity left`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={
        percent === null ? "not reported yet" : `${percent}% left`
      }
      title={
        percent === null ? "Capacity not reported yet" : `${percent}% left`
      }
    >
      {percent !== null ? (
        <div
          className={cn("h-full rounded-full", barTone(usedPercent, severity))}
          style={{ width: `${percent}%` }}
        />
      ) : null}
    </div>
  );
}

/** A value still loading, the height of the text it will become. */
function Line({ className }: { className: string }): JSX.Element {
  return <Skeleton className={cn("my-0.5 h-3", className)} />;
}

const BAR_TRACK_CLASS = "h-1.5 w-full overflow-hidden rounded-full bg-muted";

/** The usage section with its rows in place and their values still loading. */
function UsageDetailsSkeleton({
  agentType,
}: {
  agentType: string | null;
}): JSX.Element {
  return (
    <section
      className={cn(CARD_CLASS, agentType ? ENGINE_CARD[agentType] : undefined)}
      aria-label="This agent"
      aria-busy="true"
    >
      <CardHeader engine={agentType} title="This agent" />
      <div className={CARD_BODY_CLASS}>
        <div className="space-y-1">
          <Row label="Context" value={<Line className="w-28" />} />
          <div className={BAR_TRACK_CLASS} />
        </div>
        <Row label="Session" value={<Line className="w-16" />} />
        <SplitRow label="input · output" value="" />
        <SplitRow label="cache read · write" value="" />
        {agentType === "claude" ? (
          <Row label="Session cost" value={<Line className="w-12" />} />
        ) : null}
      </div>
    </section>
  );
}

/** A label at the left and its value at the right, one line. */
function Row({
  label,
  value,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span
        className="truncate tabular-nums text-foreground"
        data-testid={testId}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Every row is always there, "—" or an empty bar before the engine reports,
 * so nothing moves when it does. Only the per-model list depends on the
 * answer, which is read while the agent is open, before the chip is.
 */
export function UsageDetails({
  usage,
  agentType,
}: {
  usage: AgentUsageResponse | undefined;
  agentType: string | null;
}): JSX.Element {
  const catalog = useAgentModelCatalogData();
  if (!usage) return <UsageDetailsSkeleton agentType={agentType} />;
  const percent = contextRemainingPercent(usage);
  const { session } = usage;
  return (
    <section
      className={cn(CARD_CLASS, agentType ? ENGINE_CARD[agentType] : undefined)}
      aria-label="This agent"
      data-testid="usage-agent-card"
    >
      <CardHeader engine={agentType} title="This agent" />
      <div className={CARD_BODY_CLASS}>
        <div className="space-y-1">
          <Row
            label="Context"
            testId="usage-context"
            value={
              usage.context && percent !== null
                ? `${formatTokenCount(usage.context.used)} / ${formatTokenCount(usage.context.size)} (${percent}% left)`
                : "not reported yet"
            }
          />
          <Bar
            percent={percent}
            label="Context"
            usedPercent={
              percent === null
                ? 0
                : Math.min(
                    100,
                    Math.round(
                      (usage.context!.used / usage.context!.size) * 100
                    )
                  )
            }
          />
        </div>
        <Row
          label="Session"
          testId="usage-session-tokens"
          value={`${formatTokenCount(session.total)} tokens`}
        />
        {/* How the session's tokens split, muted under the total. */}
        <SplitRow
          label="input · output"
          value={`${formatTokenCount(session.input)} · ${formatTokenCount(session.output)}`}
        />
        <SplitRow
          label="cache read · write"
          value={`${formatTokenCount(session.cacheRead)} · ${formatTokenCount(session.cacheWrite)}`}
        />
        {usage.byModel.length > 1
          ? usage.byModel.map((m) => (
              <SplitRow
                key={m.model}
                label={agentModelLabel(catalog, agentType, m.model)}
                title={m.model}
                value={formatTokenCount(m.tokens.total)}
              />
            ))
          : null}
        {agentType === "claude" || usage.sessionCost ? (
          <Row
            label="Session cost"
            testId="usage-session-cost"
            value={
              usage.sessionCost
                ? formatCost(
                    usage.sessionCost.amount,
                    usage.sessionCost.currency
                  )
                : "—"
            }
          />
        ) : null}
      </div>
    </section>
  );
}

/** A muted, indented detail under a row: a split of its value, or a model's share. */
function SplitRow({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 pl-2 text-label-sm text-faint">
      <span className="truncate" title={title}>
        {label}
      </span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </div>
  );
}

const ENGINE_NAME: Record<ProviderPlan["engine"], string> = {
  claude: "Claude",
  codex: "Codex",
};

/** The cards' order, the same every time: Codex above Claude. */
const ENGINES: ProviderPlan["engine"][] = ["codex", "claude"];

/**
 * Each engine's tint. Every card's icon badge wears it; only the agent's
 * own card also tints its edge, to call out which engine it runs on.
 */
const ENGINE_CARD: Record<string, string> = {
  codex: "border-l-engine-codex/line-strong",
  claude: "border-l-engine-claude/line-strong",
};
const ENGINE_ICON: Record<string, string> = {
  codex: "border-engine-codex/line bg-engine-codex/tint text-engine-codex",
  claude: "border-engine-claude/line bg-engine-claude/tint text-engine-claude",
};

/** A card's first row: the engine's icon and name, and a value at the right. */
function CardHeader({
  engine,
  title,
  detail,
  right,
}: {
  engine: string | null;
  title: string;
  detail?: string | null;
  right?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5 truncate">
        <AgentTypeIcon
          type={engine}
          className={cn("h-4 w-4", engine ? ENGINE_ICON[engine] : undefined)}
        />
        <h3 className="inline font-medium text-foreground">{title}</h3>
        {detail ? (
          <span className="truncate text-muted-foreground">· {detail}</span>
        ) : null}
      </span>
      {right}
    </div>
  );
}

/**
 * The money rows each provider's card always carries: Claude bills extra
 * usage past its windows, Codex spends prepaid credits. Either shows "—"
 * until the provider reports it.
 */
const ENGINE_ROWS: Record<
  ProviderPlan["engine"],
  { spend: boolean; credits: boolean; resets: boolean }
> = {
  claude: { spend: true, credits: false, resets: false },
  codex: { spend: false, credits: true, resets: true },
};

/** Windows a card shows before any report has ever been read here. */
const SKELETON_WINDOWS: Record<ProviderPlan["engine"], number> = {
  claude: 3,
  codex: 2,
};

const CARD_CLASS = "rounded-md border bg-surface-subtle p-2";
/** A card's rows, under its header and set in a little from it. */
const CARD_BODY_CLASS = "mt-3 space-y-1.5 px-1";

/** In the cards' fixed order; an engine the list does not know goes last. */
function inEngineOrder<T extends { engine: string }>(items: T[]): T[] {
  const rank = (engine: string) => {
    const index = ENGINES.indexOf(engine as ProviderPlan["engine"]);
    return index === -1 ? ENGINES.length : index;
  };
  return [...items].sort((a, b) => rank(a.engine) - rank(b.engine));
}

/** Now, again every 30s while `enabled`, for ages that keep counting. */
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

/** Only before anything was ever read here: a card per provider, values loading. */
function PlanLimitsSkeleton(): JSX.Element {
  return (
    <>
      {ENGINES.map((id) => (
        <div key={id} className={CARD_CLASS} aria-busy="true">
          <CardHeader
            engine={id}
            title={ENGINE_NAME[id]}
            right={<Line className="w-14" />}
          />
          <div className={CARD_BODY_CLASS}>
            {Array.from({ length: SKELETON_WINDOWS[id] }, (_, i) => (
              <div key={i} className="space-y-1">
                <div className="flex justify-between gap-2">
                  <Line className="w-12" />
                  <Line className="w-32" />
                </div>
                <div className={BAR_TRACK_CLASS} />
              </div>
            ))}
            {ENGINE_ROWS[id].spend ? (
              <div className="flex justify-between text-muted-foreground">
                <span>Extra usage</span>
                <Line className="w-24" />
              </div>
            ) : null}
            {ENGINE_ROWS[id].credits ? (
              <div className="flex justify-between text-muted-foreground">
                <span>Credits</span>
                <Line className="w-12" />
              </div>
            ) : null}
            {ENGINE_ROWS[id].resets ? (
              <div className="flex justify-between text-muted-foreground">
                <span>Limit resets</span>
                <Line className="w-16" />
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </>
  );
}

export function PlanLimits({
  enabled,
  plans,
  now,
  scope = LOCAL_ENGINE_SCOPE,
  allowReset = true,
  configured,
}: {
  allowReset?: boolean;
  enabled: boolean;
  plans: ReturnType<typeof useProviderPlans>;
  scope?: EngineScope;
  now: number;
  configured?: boolean;
}): JSX.Element {
  const providers = inEngineOrder(plans.data?.providers ?? []);
  const busy = plans.isFetching || plans.refresh.isPending;
  const failure = plans.refresh.error ?? plans.error;
  // The first open ever shows a guessed skeleton, and the answer can have
  // fewer rows (a plan with one window). Hold the skeleton's height for the
  // rest of that open so the panel never shrinks under the pointer; the next
  // open starts from the stored answer and needs no floor.
  const cardsRef = useRef<HTMLDivElement>(null);
  const [floor, setFloor] = useState<number>();
  useLayoutEffect(() => {
    if (!enabled) setFloor(undefined);
    else if (!plans.data && cardsRef.current)
      setFloor(cardsRef.current.offsetHeight);
  }, [enabled, plans.data]);
  return (
    <section className="space-y-3" aria-label="Plan limits">
      <div className="flex h-6 items-center justify-between gap-2">
        <h3 className="text-label-sm font-medium text-foreground">
          Plan limits
        </h3>
        {/* A failed refresh keeps the last values; say so in the header row
            rather than in a line that pushes the cards down. */}
        {failure && plans.data && configured !== false ? (
          <span
            className="ml-auto truncate text-label-sm text-danger"
            title={failure.message}
            data-testid="usage-plans-error"
          >
            Couldn&apos;t refresh
          </span>
        ) : null}
        {configured !== false && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0"
            onClick={() => plans.refresh.mutate()}
            disabled={plans.refresh.isPending}
            aria-busy={busy}
            data-testid="usage-plans-refresh"
          >
            <RefreshCw className={cn(busy && "animate-spin")} />
            Refresh
          </Button>
        )}
      </div>
      <div
        ref={cardsRef}
        className="space-y-3"
        style={{ minHeight: floor }}
        data-testid="usage-plan-cards"
      >
        {configured === false ? (
          <p className="text-muted-foreground">
            <Link
              className="underline"
              to={{
                pathname: "/settings/runners",
                search: `?${new URLSearchParams({ runner: scope.kind === "local" ? "local" : scope.runnerId })}`,
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
        ) : plans.data ? (
          providers.map((plan) => (
            <ProviderLimits
              key={plan.engine}
              plan={plan}
              now={now}
              scope={scope}
              allowReset={allowReset}
            />
          ))
        ) : plans.error ? (
          <p className="text-danger">{plans.error.message}</p>
        ) : (
          <PlanLimitsSkeleton />
        )}
      </div>
    </section>
  );
}

function ProviderLimits({
  plan,
  now,
  scope = LOCAL_ENGINE_SCOPE,
  allowReset,
}: {
  allowReset: boolean;
  plan: ProviderPlan;
  now: number;
  scope?: EngineScope;
}): JSX.Element {
  const age = reportAge(plan.observedAt, plan.source, now);
  const rows = ENGINE_ROWS[plan.engine] ?? {
    spend: false,
    credits: false,
    resets: false,
  };
  return (
    <div
      className={CARD_CLASS}
      data-engine={plan.engine}
      data-testid={`usage-plan-${plan.engine}`}
    >
      <CardHeader
        engine={plan.engine}
        title={ENGINE_NAME[plan.engine] ?? plan.engine}
        detail={plan.plan}
        right={<PlanState plan={plan} age={age} />}
      />
      <div className={CARD_BODY_CLASS}>
        {plan.windows.map((w) => (
          <PlanWindowRow key={w.id} window={w} now={now} />
        ))}
        {rows.spend || plan.spend ? (
          <div className="flex justify-between text-muted-foreground">
            <span>Extra usage</span>
            <span
              className="tabular-nums"
              data-testid={`usage-plan-spend-${plan.engine}`}
            >
              {formatExtraUsage(plan.spend)}
            </span>
          </div>
        ) : null}
        {rows.credits || plan.credits ? (
          <div className="flex justify-between text-muted-foreground">
            <span>Credits</span>
            <span className="tabular-nums">{formatCredits(plan.credits)}</span>
          </div>
        ) : null}
        {rows.resets || plan.limitResets ? (
          <div className="space-y-1">
            <div
              className="flex justify-between text-muted-foreground"
              title="Credits that reset the account's rate-limit windows at once"
            >
              <span>Limit resets</span>
              <span className="tabular-nums">
                {formatLimitResets(plan.limitResets)}
              </span>
            </div>
            {allowReset && (
              <UseResetButton plan={plan} now={now} scope={scope} />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Spend one of the account's Codex limit resets. Always offered, since a
 * reset can be used before a window is spent; nothing is sent until the
 * dialog is confirmed, and the answer shows in its place until closed.
 */
export function UseResetButton({
  plan,
  now,
  scope = LOCAL_ENGINE_SCOPE,
}: {
  plan: ProviderPlan;
  now: number;
  scope?: EngineScope;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const consume = useConsumeCodexReset(scope);
  const resets: PlanLimitResets | undefined = plan.limitResets;
  const available = resets?.available ?? 0;
  const expiry = formatResetExpiry(resets);
  const expiring = plan.engine === "codex" && hasExpiringResets(resets, now);
  // Every way out (button, Escape, overlay) forgets the last answer, so the
  // next open asks for confirmation again rather than showing an old result.
  const close = () => {
    setOpen(false);
    consume.reset();
  };
  const outcome = consume.data
    ? consume.data.code === "ok"
      ? `Reset applied: ${consume.data.windowsReset} window${consume.data.windowsReset === 1 ? "" : "s"} reset.`
      : consume.data.code === "nothing_to_reset"
        ? "Nothing to reset right now; the credit was kept."
        : "No reset credit was available."
    : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      {/* Each expiry gets its own row, with the action below the list. */}
      <div className="flex flex-col gap-2">
        <div
          className={cn(
            "min-w-0 text-label-sm",
            expiring ? "text-primary" : "text-faint"
          )}
          data-testid="usage-codex-reset-expiry"
          title={expiry ? `Resets expire: ${expiry}` : undefined}
        >
          {expiry ? (
            <ul className="space-y-1">
              {expiry.split("\n").map((date, index) => (
                <li key={index}>{date}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <DialogTrigger asChild>
          <Button
            type="button"
            size="xs"
            className="shrink-0 self-end"
            disabled={available === 0}
            data-testid="usage-codex-reset"
          >
            Use a reset…
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent busy={consume.isPending}>
        <DialogHeader>
          <DialogTitle>Use a Codex limit reset?</DialogTitle>
          <DialogDescription>
            Spends one of your {available} reset{available === 1 ? "" : "s"} and
            clears your Codex rate-limit windows right now. It cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {/* What the reset would clear: the windows as the card shows them. */}
          <div className="space-y-1.5 rounded-md border bg-surface-subtle p-3 text-body-sm">
            <div className="text-label-sm font-medium text-foreground">
              Current usage
            </div>
            {plan.windows.map((w) => (
              <PlanWindowRow key={w.id} window={w} now={now} />
            ))}
            <div className="flex justify-between text-muted-foreground">
              <span>Credits</span>
              <span className="tabular-nums">
                {formatCredits(plan.credits)}
              </span>
            </div>
          </div>
          {resets?.items?.length ? (
            <div className="space-y-1 text-body-sm">
              <div className="text-label-sm font-medium text-foreground">
                Reset expirations · oldest first
              </div>
              <ul className="space-y-1" data-testid="usage-codex-reset-list">
                {resets.items.map((item, index) => {
                  const expires = formatResetExpiryDate(item.expiresAt);
                  return (
                    <li
                      key={item.id}
                      className={cn(
                        "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-1",
                        plan.engine === "codex" &&
                          available > 0 &&
                          resetExpiresSoon(item.expiresAt, now)
                          ? "text-primary"
                          : "text-muted-foreground"
                      )}
                    >
                      <span className="min-w-0 break-words">
                        {item.title}
                        {index === 0 ? " · next" : ""}
                      </span>
                      <span className="whitespace-nowrap tabular-nums">
                        {expires
                          ? expires
                          : item.expiresAt == null
                            ? "no expiry"
                            : "expiry unknown"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {outcome ? (
            <p
              className="text-body-md"
              role="status"
              data-testid="usage-codex-reset-outcome"
            >
              {outcome}
            </p>
          ) : null}
        </DialogBody>
        {consume.error ? (
          <Alert title="Couldn’t use the reset." error={consume.error} />
        ) : null}
        <DialogFooter>
          <DialogCancel onClick={close}>
            {outcome ? "Done" : "Cancel"}
          </DialogCancel>
          {outcome ? null : (
            <Button
              type="button"
              variant="primary"
              onClick={() => consume.mutate()}
              pending={consume.isPending}
              data-testid="usage-codex-reset-confirm"
            >
              Use a reset
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The card's state in its header corner, so no card keeps a line for it:
 * the limit reached, or the report's age — with a warning sign when the
 * last refresh failed, and the reason and timestamp on hover.
 */
function PlanState({
  plan,
  age,
}: {
  plan: ProviderPlan;
  age: string | null;
}): JSX.Element {
  const reported = plan.observedAt
    ? `Reported ${new Date(plan.observedAt).toLocaleString()}${
        plan.source === "local"
          ? " — read from the engine's files on this machine"
          : ""
      }`
    : undefined;
  if (plan.limitReached) {
    return (
      <span
        className="shrink-0 text-label-sm text-danger"
        role="status"
        title={[
          "Limit reached — requests are refused until a window resets",
          reported,
        ]
          .filter(Boolean)
          .join("\n")}
        data-testid={`usage-plan-limit-${plan.engine}`}
      >
        Limit reached
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-label-sm tabular-nums",
        age === "live" ? "text-success" : "text-muted-foreground"
      )}
      title={[plan.unavailableReason, reported].filter(Boolean).join("\n")}
      data-testid={`usage-plan-age-${plan.engine}`}
    >
      {plan.unavailableReason ? (
        <AlertTriangle
          className="h-3 w-3 text-warning"
          aria-label="Could not refresh"
        />
      ) : null}
      {age ?? ""}
    </span>
  );
}

function PlanWindowRow({
  window,
  now,
}: {
  window: PlanWindow;
  now: number;
}): JSX.Element {
  const resets = resetsIn(window.resetsAt, now);
  const percent = remainingPercent(window.usedPercent);
  return (
    <div className="space-y-1.5 py-0.5">
      {/* The percentage stands alone at the right; the reset sits, muted, by the label. */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 whitespace-nowrap">{window.label}</span>
          {resets ? (
            <span className="truncate text-label-sm text-faint">
              resets {resets}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 tabular-nums text-foreground">
          {percent === null ? "not reported yet" : `${percent}% left`}
        </span>
      </div>
      <Bar
        percent={percent}
        usedPercent={window.usedPercent}
        label={window.label}
        severity={window.severity}
      />
    </div>
  );
}
