import type {
  AgentConfigOption,
  AgentUsageResponse,
  PlanWindow,
  ProviderPlan,
} from "@dispatch/shared";
import { useAtom } from "jotai";
import { ChevronDown, Gauge, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
import { atomWithLocalStorage } from "@/lib/store";
import { cn } from "@/lib/utils";

import {
  choiceName,
  contextPercent,
  formatCost,
  pickableOptions,
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
      {usage.context && percent !== null ? (
        <div className="space-y-1">
          <div className="flex justify-between text-muted-foreground">
            <span>Context</span>
            <span className="tabular-nums">
              {formatTokenCount(usage.context.used)} /{" "}
              {formatTokenCount(usage.context.size)} ({percent}%)
            </span>
          </div>
          <Bar percent={percent} />
        </div>
      ) : (
        <p className="text-muted-foreground">
          The engine has not reported context usage yet.
        </p>
      )}
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
        {usage.sessionCost ? (
          <>
            <dt className="text-muted-foreground">Cost this session</dt>
            <dd data-testid="usage-session-cost">
              {formatCost(usage.sessionCost.amount, usage.sessionCost.currency)}
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

/** The agent's own engine first. */
function engineFirst<T extends { engine: string }>(
  items: T[],
  engine: string
): T[] {
  return [...items].sort(
    (a, b) => Number(b.engine === engine) - Number(a.engine === engine)
  );
}

/**
 * What each provider's block looked like last time, so the placeholder
 * matches: its windows, its spend row, the note shown when there is no
 * report, and the block's measured height (a note can wrap).
 */
type PlanShape = Record<
  string,
  { windows: number; spend: boolean; note?: boolean; height?: number }
>;

const DEFAULT_PLAN_SHAPE: PlanShape = Object.fromEntries(
  ENGINES.map((engine) => [engine, { windows: 2, spend: false }])
);

const planShapeAtom = atomWithLocalStorage<PlanShape>(
  "dispatch:usage-plan-shape",
  DEFAULT_PLAN_SHAPE,
  {
    validate: (value): value is PlanShape =>
      typeof value === "object" &&
      value !== null &&
      Object.values(value).every(
        (shape) =>
          typeof shape === "object" &&
          shape !== null &&
          typeof (shape as { windows?: unknown }).windows === "number" &&
          typeof (shape as { spend?: unknown }).spend === "boolean" &&
          ["boolean", "undefined"].includes(
            typeof (shape as { note?: unknown }).note
          ) &&
          ["number", "undefined"].includes(
            typeof (shape as { height?: unknown }).height
          )
      ),
  }
);

/** Every provider with the rows it had last time, values still loading. */
function PlanLimitsSkeleton({
  engine,
  shape,
}: {
  engine: string;
  shape: PlanShape;
}): JSX.Element {
  return (
    <>
      {engineFirst(
        ENGINES.map((id) => ({ engine: id, ...shape[id] })),
        engine
      ).map((plan) => (
        <div
          key={plan.engine}
          className="space-y-1.5"
          style={{ minHeight: plan.height }}
          aria-busy="true"
        >
          <div className="text-muted-foreground">
            {ENGINE_NAME[plan.engine]}
          </div>
          {Array.from({ length: plan.windows ?? 2 }, (_, i) => (
            <div key={i} className="space-y-1">
              <div className="flex justify-between gap-2">
                <Line className="w-12" />
                <Line className="w-32" />
              </div>
              <div className={BAR_TRACK_CLASS} />
            </div>
          ))}
          {plan.spend ? (
            <div className="flex justify-between text-muted-foreground">
              <span>Extra usage</span>
              <Line className="w-24" />
            </div>
          ) : null}
          {plan.note ? (
            <div className="text-[11px]">
              <Line className="w-56" />
            </div>
          ) : null}
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
  const [shape, setShape] = useAtom(planShapeAtom);
  const sectionRef = useRef<HTMLElement>(null);
  // Remember the answer's rows and the height each block took on screen.
  useLayoutEffect(() => {
    const data = plans.data;
    if (!data) return;
    const next: PlanShape = Object.fromEntries(
      data.providers.map((plan) => {
        const block = sectionRef.current?.querySelector<HTMLElement>(
          `[data-engine="${plan.engine}"]`
        );
        return [
          plan.engine,
          {
            windows: plan.windows.length,
            spend: !!plan.spend,
            note: !!plan.unavailableReason,
            ...(block ? { height: block.offsetHeight } : {}),
          },
        ];
      })
    );
    setShape((prev) =>
      JSON.stringify(prev) === JSON.stringify(next) ? prev : next
    );
  }, [plans.data, setShape]);
  return (
    <section ref={sectionRef} className="space-y-3" aria-label="Plan limits">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium text-foreground">Plan limits</h3>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px] pointer-coarse:min-h-11"
          onClick={() => plans.refresh.mutate()}
          disabled={plans.refresh.isPending}
          data-testid="usage-plans-refresh"
        >
          <RefreshCw
            className={cn(
              "mr-1 h-3 w-3",
              plans.refresh.isPending && "animate-spin"
            )}
          />
          Refresh
        </Button>
      </div>
      {plans.isLoading ? (
        <PlanLimitsSkeleton engine={engine} shape={shape} />
      ) : plans.error ? (
        <p className="text-destructive">{plans.error.message}</p>
      ) : (
        providers.map((plan) => (
          <ProviderLimits key={plan.engine} plan={plan} />
        ))
      )}
    </section>
  );
}

function ProviderLimits({ plan }: { plan: ProviderPlan }): JSX.Element {
  return (
    <div
      className="space-y-1.5"
      data-engine={plan.engine}
      data-testid={`usage-plan-${plan.engine}`}
    >
      <div className="text-muted-foreground">
        {ENGINE_NAME[plan.engine]}
        {plan.plan ? ` · ${plan.plan}` : ""}
      </div>
      {plan.windows.map((w) => (
        <PlanWindowRow key={w.id} window={w} />
      ))}
      {plan.spend ? (
        <div className="flex justify-between text-muted-foreground">
          <span>Extra usage</span>
          <span className="tabular-nums">
            {formatCost(plan.spend.used, plan.spend.currency)} of{" "}
            {formatCost(plan.spend.limit, plan.spend.currency)}
          </span>
        </div>
      ) : null}
      {plan.unavailableReason ? (
        <p className="text-[11px] text-muted-foreground/80">
          {plan.unavailableReason}
        </p>
      ) : null}
    </div>
  );
}

function PlanWindowRow({ window }: { window: PlanWindow }): JSX.Element {
  const resets = resetsIn(window.resetsAt);
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
