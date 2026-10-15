import type {
  AgentConfigOption,
  AgentUsageResponse,
  PlanWindow,
  ProviderPlan,
} from "@dispatch/shared";
import { ChevronDown, Gauge, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
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
export function ComposerMeta({
  agentId,
  agent,
  active,
  turnRunning,
  turnKey,
}: {
  agentId: string | null;
  agent: Agent | null;
  active: boolean;
  turnRunning: boolean;
  /** Changes when a turn starts or settles; the usage is read again then. */
  turnKey: string;
}): JSX.Element | null {
  const usage = useAgentUsage(agentId, active, turnRunning);
  const { refresh } = usage;
  useEffect(() => {
    if (agentId) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new turn state only
  }, [turnKey]);
  if (agentId && !agent) return null;
  return (
    <div
      className="composer-meta min-w-0 items-center gap-3"
      data-testid="composer-meta"
    >
      {agentId && agent ? (
        <>
          <ModelChip agentId={agentId} agent={agent} active={active} />
          <UsageChip agent={agent} usage={usage.data} />
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
  const percent = contextPercent(usage);
  const cost = usage?.sessionCost;
  const usageLabel = percent === null ? "Usage" : `${percent}% context`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
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
            cost
              ? `${usageLabel} · ${formatCost(cost.amount, cost.currency)}`
              : usageLabel
          }
          data-testid="composer-usage-chip"
        >
          <Gauge className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="composer-usage-full">{usageLabel}</span>
          <span className="composer-usage-short hidden">
            {percent === null ? "Usage" : `${percent}% ctx`}
          </span>
          {cost ? (
            <span className="composer-usage-cost">
              · {formatCost(cost.amount, cost.currency)}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        // The shared popover's enter/exit classes need a plugin this app does
        // not load, so this panel brings its own: it opens like a drawer from
        // its chip, and Radix waits for the exit animation before unmounting.
        className={cn(
          "max-h-[70vh] w-80 space-y-4 overflow-y-auto p-3 text-xs",
          "data-[state=open]:animate-usage-panel-in-up data-[state=open]:data-[side=bottom]:animate-usage-panel-in-down",
          "data-[state=closed]:animate-usage-panel-out-up data-[state=closed]:data-[side=bottom]:animate-usage-panel-out-down",
          "motion-reduce:!animate-none"
        )}
        data-testid="composer-usage-panel"
      >
        {agent ? (
          <UsageDetails usage={usage} agentType={agent.type ?? null} />
        ) : null}
        <PlanLimits engine={agent?.type ?? ""} enabled={open} />
      </PopoverContent>
    </Popover>
  );
}

function Bar({ percent }: { percent: number }): JSX.Element {
  return (
    <div className={BAR_TRACK_CLASS}>
      <div
        className={cn(
          "h-full rounded-full",
          percent >= 90
            ? "bg-destructive"
            : percent >= 70
              ? "bg-status-waiting"
              : "bg-status-working"
        )}
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
    <section className="space-y-2" aria-label="This agent" aria-busy="true">
      <h3 className="text-[11px] font-medium text-foreground">This agent</h3>
      <div className="space-y-1">
        <div className="flex justify-between text-muted-foreground">
          <span>Context</span>
          <Line className="w-28" />
        </div>
        <div className={BAR_TRACK_CLASS} />
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
        {agentType === "claude" ? (
          <>
            <dt className="text-muted-foreground">Cost this session</dt>
            <dd className="flex justify-end">
              <Line className="w-12" />
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Tokens this session</dt>
        <dd className="flex justify-end">
          <Line className="w-10" />
        </dd>
        <dt className="pl-2 text-muted-foreground/80">input · output</dt>
        <dd className="flex justify-end">
          <Line className="w-16" />
        </dd>
        <dt className="pl-2 text-muted-foreground/80">cache read · write</dt>
        <dd className="flex justify-end">
          <Line className="w-16" />
        </dd>
        <dt className="text-muted-foreground">Tokens this month</dt>
        <dd className="flex justify-end">
          <Line className="w-10" />
        </dd>
      </dl>
    </section>
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
  return (
    <section className="space-y-2" aria-label="This agent">
      <h3 className="text-[11px] font-medium text-foreground">This agent</h3>
      <div className="space-y-1">
        <div className="flex justify-between text-muted-foreground">
          <span>Context</span>
          <span className="tabular-nums" data-testid="usage-context">
            {usage.context && percent !== null ? (
              <>
                {formatTokenCount(usage.context.used)} /{" "}
                {formatTokenCount(usage.context.size)} ({percent}%)
              </>
            ) : (
              "not reported yet"
            )}
          </span>
        </div>
        {percent !== null ? (
          <Bar percent={percent} />
        ) : (
          <div className={BAR_TRACK_CLASS} />
        )}
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
        {agentType === "claude" || usage.sessionCost ? (
          <>
            <dt className="text-muted-foreground">Cost this session</dt>
            <dd data-testid="usage-session-cost">
              {usage.sessionCost
                ? formatCost(
                    usage.sessionCost.amount,
                    usage.sessionCost.currency
                  )
                : "—"}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Tokens this session</dt>
        <dd data-testid="usage-session-tokens">
          {formatTokenCount(usage.session.total)}
        </dd>
        <dt className="pl-2 text-muted-foreground/80">input · output</dt>
        <dd className="text-muted-foreground">
          {formatTokenCount(usage.session.input)} ·{" "}
          {formatTokenCount(usage.session.output)}
        </dd>
        <dt className="pl-2 text-muted-foreground/80">cache read · write</dt>
        <dd className="text-muted-foreground">
          {formatTokenCount(usage.session.cacheRead)} ·{" "}
          {formatTokenCount(usage.session.cacheWrite)}
        </dd>
        <dt className="text-muted-foreground">Tokens this month</dt>
        <dd>{formatTokenCount(usage.month.total)}</dd>
      </dl>
      {usage.byModel.length > 1 ? (
        <ul className="space-y-0.5">
          {usage.byModel.map((m) => (
            <li
              key={m.model}
              className="flex justify-between gap-2 text-muted-foreground"
            >
              <span className="truncate" title={m.model}>
                {agentModelLabel(catalog, agentType, m.model)}
              </span>
              <span className="tabular-nums">
                {formatTokenCount(m.tokens.total)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const ENGINE_NAME: Record<ProviderPlan["engine"], string> = {
  claude: "Claude",
  codex: "Codex",
};

const ENGINES = Object.keys(ENGINE_NAME) as ProviderPlan["engine"][];

/**
 * The money rows each provider's card always carries: Claude bills extra
 * usage past its windows, Codex spends prepaid credits. Either shows "—"
 * until the provider reports it.
 */
const ENGINE_ROWS: Record<
  ProviderPlan["engine"],
  { spend: boolean; credits: boolean }
> = {
  claude: { spend: true, credits: false },
  codex: { spend: false, credits: true },
};

/** Windows a card shows before any report has ever been read here. */
const SKELETON_WINDOWS: Record<ProviderPlan["engine"], number> = {
  claude: 3,
  codex: 2,
};

const CARD_CLASS = "space-y-1.5 rounded-md border bg-muted/30 p-2";

/** One line, there whether or not it has anything to say; never wraps. */
const NOTE_CLASS = "h-4 truncate text-[11px] leading-4";

/** The agent's own engine first. */
function engineFirst<T extends { engine: string }>(
  items: T[],
  engine: string
): T[] {
  return [...items].sort(
    (a, b) => Number(b.engine === engine) - Number(a.engine === engine)
  );
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
function PlanLimitsSkeleton({ engine }: { engine: string }): JSX.Element {
  return (
    <>
      {engineFirst(
        ENGINES.map((id) => ({ engine: id })),
        engine
      ).map(({ engine: id }) => (
        <div key={id} className={CARD_CLASS} aria-busy="true">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-foreground">
              {ENGINE_NAME[id]}
            </span>
            <Line className="w-14" />
          </div>
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
          <div className={NOTE_CLASS} />
        </div>
      ))}
    </>
  );
}

function PlanLimits({
  engine,
  enabled,
}: {
  engine: string;
  enabled: boolean;
}): JSX.Element {
  const plans = useProviderPlans(enabled);
  const providers = engineFirst(plans.data?.providers ?? [], engine);
  const now = useNow(enabled);
  const busy = plans.isFetching || plans.refresh.isPending;
  const failure = plans.refresh.error ?? plans.error;
  return (
    <section className="space-y-2" aria-label="Plan limits">
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
      {plans.data ? (
        providers.map((plan) => (
          <ProviderLimits key={plan.engine} plan={plan} now={now} />
        ))
      ) : plans.error ? (
        <p className="text-destructive">{plans.error.message}</p>
      ) : (
        <PlanLimitsSkeleton engine={engine} />
      )}
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
  const rows = ENGINE_ROWS[plan.engine] ?? { spend: false, credits: false };
  return (
    <div
      className={CARD_CLASS}
      data-engine={plan.engine}
      data-testid={`usage-plan-${plan.engine}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground">
            {ENGINE_NAME[plan.engine] ?? plan.engine}
          </span>
          {plan.plan ? (
            <span className="text-muted-foreground"> · {plan.plan}</span>
          ) : null}
        </span>
        <span
          className={cn(
            "shrink-0 text-[11px] tabular-nums",
            age === "live" ? "text-status-working" : "text-muted-foreground"
          )}
          title={
            plan.observedAt
              ? `Reported ${new Date(plan.observedAt).toLocaleString()}${
                  plan.source === "local"
                    ? " — read from the engine's files on this machine"
                    : ""
                }`
              : undefined
          }
          data-testid={`usage-plan-age-${plan.engine}`}
        >
          {age ?? ""}
        </span>
      </div>
      {plan.windows.map((w) => (
        <PlanWindowRow key={w.id} window={w} now={now} />
      ))}
      {rows.spend || plan.spend ? (
        <div className="flex justify-between text-muted-foreground">
          <span>Extra usage</span>
          <span className="tabular-nums">
            {plan.spend
              ? `${formatCost(plan.spend.used, plan.spend.currency)} of ${formatCost(plan.spend.limit, plan.spend.currency)}`
              : "—"}
          </span>
        </div>
      ) : null}
      {rows.credits || plan.credits ? (
        <div className="flex justify-between text-muted-foreground">
          <span>Credits</span>
          <span className="tabular-nums">{formatCredits(plan.credits)}</span>
        </div>
      ) : null}
      {plan.limitReached ? (
        <p
          className={cn(
            NOTE_CLASS,
            "rounded-sm bg-destructive/10 px-1 text-destructive"
          )}
          role="status"
          title="Limit reached — requests are refused until a window resets"
          data-testid={`usage-plan-limit-${plan.engine}`}
        >
          Limit reached · refused until reset
        </p>
      ) : (
        <p
          className={cn(NOTE_CLASS, "text-muted-foreground/80")}
          title={plan.unavailableReason}
        >
          {plan.unavailableReason ?? ""}
        </p>
      )}
    </div>
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
    <div className="space-y-1">
      <div className="flex justify-between gap-2">
        <span>{window.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {Math.round(window.usedPercent)}% used
          {resets ? ` · resets ${resets}` : ""}
        </span>
      </div>
      <Bar percent={window.usedPercent} />
    </div>
  );
}
