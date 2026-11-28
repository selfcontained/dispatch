import {
  PlanLimits,
  UsageDetails,
  useNow,
} from "@/components/runner-engines/provider-usage";
export { UseResetButton } from "@/components/runner-engines/provider-usage";
import { LOCAL_ENGINE_SCOPE } from "@/lib/engine-management";
import type { AgentConfigOption, AgentUsageResponse } from "@dispatch/shared";
import { ChevronDown, Gauge, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EffortPicker } from "@/components/app/effort-picker";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
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
import { cn } from "@/lib/utils";

import {
  choiceName,
  contextRemainingPercent,
  hasExpiringResets,
  pickableOptions,
} from "./composer-meta-format";

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
  const setEffort = useSetAgentConfig(agentId);
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
  const disabled = !running || !model;

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setConfig.reset();
        }}
      >
        <PopoverTrigger asChild>
          <Hint
            label={
              running
                ? "Change the model"
                : "Start the agent to change its model"
            }
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="min-w-0 max-w-full justify-self-start disabled:pointer-events-auto"
              disabled={disabled}
              data-testid="composer-model-chip"
            >
              <Sparkles aria-hidden="true" />
              <span className="truncate">{label}</span>
              {disabled ? null : <ChevronDown aria-hidden="true" />}
            </Button>
          </Hint>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="w-72 space-y-3 p-3"
          data-testid="composer-model-picker"
        >
          {(model ? [model] : []).map((option) => (
            <ConfigSelect
              key={option.id}
              option={option}
              disabled={setConfig.isPending}
              onChange={(value) =>
                setConfig.mutate({ configId: option.id, value })
              }
            />
          ))}
          <p className="text-label-sm text-muted-foreground">
            {setConfig.isPending
              ? "Applying…"
              : "Applies from the next turn of this session."}
          </p>
          {setConfig.error ? (
            <p role="alert" className="text-label-sm text-danger">
              {setConfig.error.message}
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
      {effort ? (
        <EffortPicker
          id="composer-effort-chip"
          onOpenChange={(open) => {
            if (!open) setEffort.reset();
          }}
          compact
          value={effort.currentValue}
          choices={effort.choices}
          allowDefault={effort.choices.some(
            (choice) => choice.value === "default"
          )}
          disabled={!running}
          pending={setEffort.isPending}
          error={setEffort.error?.message}
          description="Applies from the next turn of this session."
          onChange={(value) =>
            setEffort.mutateAsync({
              configId: effort.id,
              value: value ?? "default",
            })
          }
        />
      ) : null}
    </div>
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
      <label htmlFor={id} className="text-label-sm text-muted-foreground">
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
          className="h-8 text-body-sm pointer-coarse:min-h-11"
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
                  className="text-body-sm pointer-coarse:min-h-11"
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
  const scope = agent?.engineScope ?? LOCAL_ENGINE_SCOPE;
  const plans = useProviderPlans(true, scope);
  const { isStale, refetch } = plans;
  const now = useNow(true);
  const expiring = (plans.data?.providers ?? []).some(
    (plan) =>
      plan.engine === "codex" && hasExpiringResets(plan.limitResets, now)
  );
  const percent = contextRemainingPercent(usage);
  const usageLabel = percent === null ? "Usage" : `Context: ${percent}% left`;
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
        <Hint label={usageLabel}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={cn("shrink-0 tabular-nums", !agent && "col-start-2")}
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
            <span className="composer-usage-full">
              {percent === null ? "Usage" : `${percent}% left · context`}
            </span>
            <span className="composer-usage-short hidden">
              {percent === null ? "Usage" : `${percent}% left`}
            </span>
          </Button>
        </Hint>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        // The shared popover's enter/exit classes need a plugin this app does
        // not load, so this panel brings its own: it opens like a drawer from
        // its chip, and Radix waits for the exit animation before unmounting.
        className={cn(
          "z-drawer-panel max-h-[70vh] w-[22rem] max-w-[calc(100vw-1rem)] space-y-4 overflow-y-auto p-3 text-body-sm",
          "data-[state=open]:animate-usage-panel-in-up data-[state=open]:data-[side=bottom]:animate-usage-panel-in-down",
          "data-[state=closed]:animate-usage-panel-out-up data-[state=closed]:data-[side=bottom]:animate-usage-panel-out-down",
          "motion-reduce:!animate-none"
        )}
        data-testid="composer-usage-panel"
      >
        {agent ? (
          <UsageDetails usage={usage} agentType={agent.type ?? null} />
        ) : null}
        <PlanLimits enabled={open} plans={plans} now={now} scope={scope} />
      </PopoverContent>
    </Popover>
  );
}
