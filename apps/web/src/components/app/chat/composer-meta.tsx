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
  pickableOptions,
  resetsIn,
} from "./composer-meta-format";

const CHIP_CLASS =
  "inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50 disabled:pointer-events-none disabled:opacity-60 pointer-coarse:min-h-11";

/**
 * The strip under the composer: which model the session runs (a picker)
 * and what it has used (context, cost, tokens, and the plan's limits).
 */
export function ComposerMeta({
  agentId,
  agent,
  active,
  turnRunning,
  turnKey,
}: {
  agentId: string;
  agent: Agent | null;
  active: boolean;
  turnRunning: boolean;
  /** Changes when a turn starts or settles; the usage is read again then. */
  turnKey: string;
}): JSX.Element | null {
  const usage = useAgentUsage(agentId, active, turnRunning);
  const { refresh } = usage;
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new turn state only
  }, [turnKey]);
  if (!agent) return null;
  return (
    <div
      className="mt-1 flex min-w-0 items-center justify-between gap-2"
      data-testid="composer-meta"
    >
      <ModelChip agentId={agentId} agent={agent} active={active} />
      <UsageChip agent={agent} usage={usage.data} />
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
          className={CHIP_CLASS}
          disabled={disabled}
          title={
            running ? "Change the model" : "Start the agent to change its model"
          }
          data-testid="composer-model-chip"
        >
          <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
          {effortLabel ? (
            <span className="shrink-0 text-muted-foreground/70">
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
          className="h-8 text-xs"
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
                  className="text-xs"
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

function UsageChip({
  agent,
  usage,
}: {
  agent: Agent;
  usage: AgentUsageResponse | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const percent = contextPercent(usage);
  const cost = usage?.sessionCost;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(CHIP_CLASS, "shrink-0 tabular-nums")}
          title="Usage"
          data-testid="composer-usage-chip"
        >
          <Gauge className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {percent === null ? "Usage" : `${percent}% context`}
            {cost ? ` · ${formatCost(cost.amount, cost.currency)}` : ""}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="max-h-[70vh] w-80 space-y-4 overflow-y-auto p-3 text-xs"
        data-testid="composer-usage-panel"
      >
        <UsageDetails usage={usage} agentType={agent.type ?? null} />
        <PlanLimits engine={agent.type ?? ""} enabled={open} />
      </PopoverContent>
    </Popover>
  );
}

function Bar({ percent }: { percent: number }): JSX.Element {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
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

function UsageDetails({
  usage,
  agentType,
}: {
  usage: AgentUsageResponse | undefined;
  agentType: string | null;
}): JSX.Element {
  const catalog = useAgentModelCatalogData();
  if (!usage) {
    return <p className="text-muted-foreground">Loading usage…</p>;
  }
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

function PlanLimits({
  engine,
  enabled,
}: {
  engine: string;
  enabled: boolean;
}): JSX.Element {
  const plans = useProviderPlans(enabled);
  // The agent's own engine first.
  const providers = [...(plans.data?.providers ?? [])].sort(
    (a, b) => Number(b.engine === engine) - Number(a.engine === engine)
  );
  return (
    <section className="space-y-3" aria-label="Plan limits">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium text-foreground">Plan limits</h3>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
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
        <p className="text-muted-foreground">Checking plans…</p>
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
    <div className="space-y-1.5" data-testid={`usage-plan-${plan.engine}`}>
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
