import type {
  AgentConfigOption,
  AgentUsageResponse,
  PlanLimitResets,
  PlanWindow,
  ProviderPlan,
} from "@dispatch/shared";
import {
  AlertTriangle,
  ChevronDown,
  Gauge,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  agentModelLabel,
  useAgentModelCatalogData,
} from "@/hooks/use-agent-model-catalog";
import {
  useAgentConfig,
  useAgentUsage,
  useConsumeCodexReset,
  useProviderPlans,
  useSetAgentConfig,
} from "@/hooks/use-agent-usage";
import { formatTokenCount } from "@/lib/format";
import { cn } from "@/lib/utils";

import {
  choiceName,
  contextPercent,
  formatCost,
  formatCredits,
  formatExtraUsage,
  formatLimitResets,
  formatResetExpiry,
  hasExpiringResets,
  resetExpiresSoon,
  pickableOptions,
  reportAge,
  resetsIn,
} from "./composer-meta-format";

const CHIP_CLASS =
  "inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50 disabled:pointer-events-none disabled:opacity-60 pointer-coarse:min-h-11";

/**
 * Controls beside the recipients under the composer: which model the session runs (a picker)
 * and what it has used (context, cost, tokens, and the plan's limits). With no
 * agent selected, the usage chip still opens the plans' limits.
 */
/** The newest turn's usage as the stream delivers it: context so far, and cost where the engine reports one. */
type LiveUsage = { used: number; size: number; costUsd: number | null };

/**
 * The usage report with a running turn's figures laid over it. The report
 * is read when a turn starts or settles; while one runs, the stream's own
 * turn entry carries the context as it fills, so nothing needs polling. A
 * settled turn is never laid over the report: the report is the newer word.
 */
export function withLiveUsage(
  usage: AgentUsageResponse | undefined,
  live: LiveUsage | null
): AgentUsageResponse | undefined {
  if (!usage || !live) return usage;
  return {
    ...usage,
    context: { used: live.used, size: live.size },
    sessionCost:
      live.costUsd === null
        ? usage.sessionCost
        : { amount: live.costUsd, currency: "USD" },
  };
}

export function ComposerMeta({
  agentId,
  agent,
  active,
  liveUsage,
  turnKey,
}: {
  agentId: string | null;
  agent: Agent | null;
  active: boolean;
  /** The newest turn's usage from the stream, when it has reported any. */
  liveUsage: LiveUsage | null;
  /** Changes when a turn starts or settles; the usage is read again then. */
  turnKey: string;
}): JSX.Element | null {
  const query = useAgentUsage(agentId, active);
  const { refresh } = query;
  useEffect(() => {
    if (agentId) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new turn state only
  }, [turnKey]);
  const usage = withLiveUsage(query.data, liveUsage);
  if (agentId && !agent) return null;
  return (
    <div
      className="composer-meta min-w-0 items-center gap-3"
      data-testid="composer-meta"
    >
      {agentId && agent ? (
        <>
          <ModelChip agentId={agentId} agent={agent} active={active} />
          <UsageChip agent={agent} usage={usage} />
        </>
      ) : (
        <UsageChip agent={null} usage={undefined} />
      )}
    </div>
  );
}

function ModelChip({
  agentId,
  agent,
  active,
}: {
  agentId: string;
  agent: Agent;
  active: boolean;
}): JSX.Element {
  const catalog = useAgentModelCatalogData();
  const config = useAgentConfig(agentId, active);
  const setConfig = useSetAgentConfig(agentId);
  const [open, setOpen] = useState(false);
  const options = useMemo(
    () => pickableOptions(config.data?.options ?? []),
    [config.data]
  );
  const running = config.data?.running ?? false;
  const [model, effort] = [
    options.find((o) => o.category === "model" || o.id === "model"),
    options.find((o) => o.category !== "model" && o.id !== "model"),
  ];
  const label =
    choiceName(model) ??
    (agent.model
      ? agentModelLabel(catalog, agent.type, agent.model)
      : "Default model");
  const effortLabel = choiceName(effort);
  const disabled = !running || options.length === 0;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfig.reset();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(CHIP_CLASS, "max-w-full justify-self-start")}
          disabled={disabled}
          title={
            running ? "Change the model" : "Start the agent to change its model"
          }
          data-testid="composer-model-chip"
        >
          <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
          {effortLabel ? (
            <span className="composer-model-effort shrink-0 text-muted-foreground/70">
              · {effortLabel}
            </span>
          ) : null}
          {disabled ? null : (
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-72 space-y-3 p-3"
        data-testid="composer-model-picker"
      >
        {options.map((option) => (
          <ConfigSelect
            key={option.id}
            option={option}
            disabled={setConfig.isPending}
            onChange={(value) =>
              setConfig.mutate({ configId: option.id, value })
            }
          />
        ))}
        <p className="text-[11px] text-muted-foreground">
          {setConfig.isPending
            ? "Applying…"
            : "Applies from the next turn of this session."}
        </p>
        {setConfig.error ? (
          <p role="alert" className="text-[11px] text-destructive">
            {setConfig.error.message}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ConfigSelect({
  option,
  disabled,
  onChange,
}: {
  option: AgentConfigOption;
  disabled: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  const groups = useMemo(() => {
    const byGroup = new Map<string, AgentConfigOption["choices"]>();
    for (const choice of option.choices) {
      const key = choice.group ?? "";
      byGroup.set(key, [...(byGroup.get(key) ?? []), choice]);
    }
    return [...byGroup.entries()];
  }, [option.choices]);
  const id = `composer-config-${option.id}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-[11px] text-muted-foreground">
        {option.name}
      </label>
      <Select
        value={option.currentValue}
        onValueChange={(value) => {
          if (value !== option.currentValue) onChange(value);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          className="h-8 text-xs pointer-coarse:min-h-11"
          data-testid={`composer-config-${option.id}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {groups.map(([group, choices]) => (
            <SelectGroup key={group || "_"}>
              {group ? <SelectLabel>{group}</SelectLabel> : null}
              {choices.map((choice) => (
                <SelectItem
                  key={choice.value}
                  value={choice.value}
                  className="text-xs pointer-coarse:min-h-11"
                >
                  {choice.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** With no agent, only the plans' limits: there is no session to report. */
function UsageChip({
  agent,
  usage,
}: {
  agent: Agent | null;
  usage: AgentUsageResponse | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Read once on mount (including a closed chip), then use the shared cache.
  // No network polling: the local clock alone keeps expiry reminders current.
  const plans = useProviderPlans(true);
  const { isStale, refetch } = plans;
  const now = useNow(true);
  const expiring = (plans.data?.providers ?? []).some(
    (plan) =>
      plan.engine === "codex" && hasExpiringResets(plan.limitResets, now)
  );
  const percent = contextPercent(usage);
  const usageLabel = percent === null ? "Usage" : `${percent}% context`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Preserve the old open-time stale refresh without forcing a provider read.
        if (next && isStale) void refetch();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            CHIP_CLASS,
            "shrink-0 tabular-nums",
            !agent && "col-start-2"
          )}
          title="Usage"
          aria-label={
            expiring
              ? `${usageLabel} · Codex reset credit expires within seven days`
              : usageLabel
          }
          data-testid="composer-usage-chip"
        >
          <span className="relative inline-flex shrink-0">
            <Gauge className="h-3 w-3" aria-hidden="true" />
            {expiring ? (
              <span
                className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background"
                aria-hidden="true"
                data-testid="composer-usage-expiry-dot"
              />
            ) : null}
          </span>
          <span className="composer-usage-full">{usageLabel}</span>
          <span className="composer-usage-short hidden">
            {percent === null ? "Usage" : `${percent}% ctx`}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        // The shared popover's enter/exit classes need a plugin this app does
        // not load, so this panel brings its own: it opens like a drawer from
        // its chip, and Radix waits for the exit animation before unmounting.
        className={cn(
          "max-h-[70vh] w-[22rem] max-w-[calc(100vw-1rem)] space-y-4 overflow-y-auto p-3 text-xs",
          "data-[state=open]:animate-usage-panel-in-up data-[state=open]:data-[side=bottom]:animate-usage-panel-in-down",
          "data-[state=closed]:animate-usage-panel-out-up data-[state=closed]:data-[side=bottom]:animate-usage-panel-out-down",
          "motion-reduce:!animate-none"
        )}
        data-testid="composer-usage-panel"
      >
        {agent ? (
          <UsageDetails usage={usage} agentType={agent.type ?? null} />
        ) : null}
        <PlanLimits enabled={open} plans={plans} now={now} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The bar's colour: the provider's own warning level when it gives one
 * ("normal", "warning", anything worse), else by how full it is.
 */
function barTone(percent: number, severity?: string): string {
  if (severity) {
    return severity === "normal"
      ? "bg-status-working"
      : severity === "warning"
        ? "bg-status-waiting"
        : "bg-destructive";
  }
  return percent >= 90
    ? "bg-destructive"
    : percent >= 70
      ? "bg-status-waiting"
      : "bg-status-working";
}

function Bar({
  percent,
  severity,
}: {
  percent: number;
  severity?: string;
}): JSX.Element {
  return (
    <div className={BAR_TRACK_CLASS}>
      <div
        className={cn("h-full rounded-full", barTone(percent, severity))}
        style={{ width: `${Math.max(2, percent)}%` }}
      />
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
function UsageDetails({
  usage,
  agentType,
}: {
  usage: AgentUsageResponse | undefined;
  agentType: string | null;
}): JSX.Element {
  const catalog = useAgentModelCatalogData();
  if (!usage) return <UsageDetailsSkeleton agentType={agentType} />;
  const percent = contextPercent(usage);
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
                ? `${formatTokenCount(usage.context.used)} / ${formatTokenCount(usage.context.size)} (${percent}%)`
                : "not reported yet"
            }
          />
          {percent !== null ? (
            <Bar percent={percent} />
          ) : (
            <div className={BAR_TRACK_CLASS} />
          )}
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
    <div className="flex items-center justify-between gap-3 pl-2 text-[11px] text-muted-foreground/80">
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
  codex: "border-l-engine-codex/60",
  claude: "border-l-engine-claude/60",
};
const ENGINE_ICON: Record<string, string> = {
  codex: "border-engine-codex/40 bg-engine-codex/15 text-engine-codex",
  claude: "border-engine-claude/40 bg-engine-claude/15 text-engine-claude",
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

const CARD_CLASS = "rounded-md border bg-muted/30 p-2";
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
function useNow(enabled: boolean): number {
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

function PlanLimits({
  enabled,
  plans,
  now,
}: {
  enabled: boolean;
  plans: ReturnType<typeof useProviderPlans>;
  now: number;
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
        <h3 className="text-[11px] font-medium text-foreground">Plan limits</h3>
        {/* A failed refresh keeps the last values; say so in the header row
            rather than in a line that pushes the cards down. */}
        {failure && plans.data ? (
          <span
            className="ml-auto truncate text-[11px] text-destructive"
            title={failure.message}
            data-testid="usage-plans-error"
          >
            Couldn&apos;t refresh
          </span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 px-1.5 text-[11px] pointer-coarse:min-h-11"
          onClick={() => plans.refresh.mutate()}
          disabled={plans.refresh.isPending}
          aria-busy={busy}
          data-testid="usage-plans-refresh"
        >
          <RefreshCw className={cn("mr-1 h-3 w-3", busy && "animate-spin")} />
          Refresh
        </Button>
      </div>
      <div
        ref={cardsRef}
        className="space-y-3"
        style={{ minHeight: floor }}
        data-testid="usage-plan-cards"
      >
        {plans.data ? (
          providers.map((plan) => (
            <ProviderLimits key={plan.engine} plan={plan} now={now} />
          ))
        ) : plans.error ? (
          <p className="text-destructive">{plans.error.message}</p>
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
}: {
  plan: ProviderPlan;
  now: number;
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
            <UseResetButton plan={plan} now={now} />
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
}: {
  plan: ProviderPlan;
  now: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const consume = useConsumeCodexReset();
  const resets: PlanLimitResets | undefined = plan.limitResets;
  const available = resets?.available ?? 0;
  const expiry = formatResetExpiry(resets, now);
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
      {/* When the resets lapse at the left, the action at the right. */}
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "truncate text-[11px]",
            expiring ? "text-primary" : "text-muted-foreground/80"
          )}
          data-testid="usage-codex-reset-expiry"
          title={expiry ? `Resets expire: ${expiry}` : undefined}
        >
          {expiry ?? ""}
        </span>
        <DialogTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-6 shrink-0 px-2 text-[11px] pointer-coarse:min-h-11"
            disabled={available === 0}
            data-testid="usage-codex-reset"
          >
            Use a reset…
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Use a Codex limit reset?</DialogTitle>
          <DialogDescription>
            Spends one of your {available} reset{available === 1 ? "" : "s"} and
            clears your Codex rate-limit windows right now. It cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {/* What the reset would clear: the windows as the card shows them. */}
        <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-xs">
          <div className="text-[11px] font-medium text-foreground">
            Current usage
          </div>
          {plan.windows.map((w) => (
            <PlanWindowRow key={w.id} window={w} now={now} />
          ))}
          <div className="flex justify-between text-muted-foreground">
            <span>Credits</span>
            <span className="tabular-nums">{formatCredits(plan.credits)}</span>
          </div>
        </div>
        {resets?.items?.length ? (
          <div className="space-y-1 text-xs">
            <div className="text-[11px] font-medium text-foreground">
              Your resets · the oldest is used first
            </div>
            <ul className="space-y-0.5" data-testid="usage-codex-reset-list">
              {resets.items.map((item, index) => (
                <li
                  key={item.id}
                  className={cn(
                    "flex justify-between gap-2",
                    plan.engine === "codex" &&
                      available > 0 &&
                      resetExpiresSoon(item.expiresAt, now)
                      ? "text-primary"
                      : "text-muted-foreground"
                  )}
                >
                  <span className="truncate">
                    {item.title}
                    {index === 0 ? " · next" : ""}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {item.expiresAt
                      ? `expires ${new Date(item.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                      : "no expiry"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {outcome ? (
          <p
            className="text-sm"
            role="status"
            data-testid="usage-codex-reset-outcome"
          >
            {outcome}
          </p>
        ) : null}
        {consume.error ? (
          <p role="alert" className="text-sm text-destructive">
            {consume.error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="default" onClick={close}>
            {outcome ? "Close" : "Cancel"}
          </Button>
          {outcome ? null : (
            <Button
              type="button"
              variant="primary"
              onClick={() => consume.mutate()}
              disabled={consume.isPending}
              data-testid="usage-codex-reset-confirm"
            >
              {consume.isPending ? "Resetting…" : "Use a reset"}
            </Button>
          )}
        </div>
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
        className="shrink-0 text-[11px] text-destructive"
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
        "flex shrink-0 items-center gap-1 text-[11px] tabular-nums",
        age === "live" ? "text-status-working" : "text-muted-foreground"
      )}
      title={[plan.unavailableReason, reported].filter(Boolean).join("\n")}
      data-testid={`usage-plan-age-${plan.engine}`}
    >
      {plan.unavailableReason ? (
        <AlertTriangle
          className="h-3 w-3 text-status-waiting"
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
  return (
    <div className="space-y-1.5 py-0.5">
      {/* The percentage stands alone at the right; the reset sits, muted, by the label. */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 whitespace-nowrap">{window.label}</span>
          {resets ? (
            <span className="truncate text-[11px] text-muted-foreground/80">
              resets {resets}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 tabular-nums text-foreground">
          {Math.round(window.usedPercent)}%
        </span>
      </div>
      <Bar percent={window.usedPercent} severity={window.severity} />
    </div>
  );
}
