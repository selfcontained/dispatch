import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { AgentModelSettings } from "@/components/app/agent-model-settings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  CLI_AGENT_TYPES,
} from "@/lib/agent-types";

type AgentTypeSettingsResponse = {
  enabledAgentTypes: AgentType[];
};

const AGENT_TYPE_DESCRIPTIONS: Record<AgentType, string> = {
  claude: "Claude Code CLI by Anthropic.",
  codex: "Codex CLI by OpenAI.",
  opencode: "OpenCode CLI with your configured model providers.",
};

type AgentTypeSettingsProps = {
  enabledAgentTypes: AgentType[];
  onChange: (agentTypes: AgentType[]) => void;
};

function AgentTypeRow({
  agentType,
  checked,
  disabled,
  onToggle,
  open,
  onOpenChange,
}: {
  agentType: AgentType;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { options, allOptions } = useAgentModelCatalog(agentType);
  const offCount = allOptions.length - options.length;
  const wasOpen = useRef(open);
  useEffect(() => {
    // New stays up while the list is open, and clears once it has been seen.
    if (wasOpen.current && !open)
      allOptions.forEach((option) => option.markSeen?.());
    wasOpen.current = open;
  }, [allOptions, open]);
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="rounded border border-border"
    >
      <div className="flex items-stretch">
        <label
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 transition-colors",
            disabled
              ? "cursor-not-allowed opacity-60"
              : "cursor-pointer hover:bg-muted/50"
          )}
        >
          <Checkbox
            checked={checked}
            disabled={disabled}
            onCheckedChange={onToggle}
            data-testid={`agent-type-toggle-${agentType}`}
          />
          <div className="min-w-0">
            <div className="text-body-md font-medium text-foreground">
              {AGENT_TYPE_LABELS[agentType]}
            </div>
            <div className="text-body-sm text-muted-foreground">
              {disabled
                ? "At least one type must stay enabled."
                : AGENT_TYPE_DESCRIPTIONS[agentType]}
            </div>
          </div>
        </label>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="group h-auto min-h-11 shrink-0 gap-1.5 rounded-none px-3 text-body-sm font-normal"
            aria-label={`${AGENT_TYPE_LABELS[agentType]} models: ${options.length} on, ${offCount} off`}
            data-testid={`agent-models-toggle-${agentType}`}
          >
            {allOptions.length ? (
              <span className="flex items-baseline gap-2 text-body-md tabular-nums">
                <span className="font-semibold text-foreground">
                  {options.length}
                </span>
                {offCount ? (
                  <span className="text-muted-foreground line-through">
                    {offCount}
                  </span>
                ) : null}
              </span>
            ) : null}
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="border-t border-border bg-muted/20">
        <AgentModelSettings agentType={agentType} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AgentTypeSettings({
  enabledAgentTypes,
  onChange,
}: AgentTypeSettingsProps): JSX.Element {
  const [agentTypes, setAgentTypes] = useState<AgentType[]>(enabledAgentTypes);
  const [searchParams, setSearchParams] = useSearchParams();
  const openType =
    CLI_AGENT_TYPES.find((type) => type === searchParams.get("models")) ?? null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setAgentTypes(enabledAgentTypes);
  }, [enabledAgentTypes]);

  useEffect(() => {
    let cancelled = false;

    void api<AgentTypeSettingsResponse>("/api/v1/app/settings/agent-types")
      .then((data) => {
        if (cancelled) return;
        setAgentTypes(data.enabledAgentTypes);
        onChange(data.enabledAgentTypes);
        setError("");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load agent type settings."
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [onChange]);

  const toggleAgentType = useCallback(
    async (agentType: AgentType) => {
      setError("");

      const next = agentTypes.includes(agentType)
        ? agentTypes.filter((item) => item !== agentType)
        : [...agentTypes, agentType];

      // Optimistic update
      setAgentTypes(next);
      onChange(next);

      try {
        const data = await api<AgentTypeSettingsResponse>(
          "/api/v1/app/settings/agent-types",
          {
            method: "POST",
            body: JSON.stringify({ enabledAgentTypes: next }),
          }
        );
        setAgentTypes(data.enabledAgentTypes);
        onChange(data.enabledAgentTypes);
      } catch (err) {
        // Revert on failure
        setAgentTypes(agentTypes);
        onChange(agentTypes);
        setError(
          err instanceof Error
            ? err.message
            : "Failed to save agent type settings."
        );
      }
    },
    [agentTypes, onChange]
  );

  if (loading) {
    return (
      <div className="p-6 text-body-md text-muted-foreground">Loading...</div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <div className="mb-1.5 section-label">Available agent types</div>
        <p className="mb-3 max-w-2xl text-body-md text-muted-foreground">
          Choose which agent types and models Dispatch offers for new launches.
        </p>
      </div>

      <div className="max-w-lg space-y-2">
        {CLI_AGENT_TYPES.map((agentType) => {
          const checked = agentTypes.includes(agentType);
          const disabled = checked && agentTypes.length === 1;
          return (
            <AgentTypeRow
              key={agentType}
              agentType={agentType}
              checked={checked}
              disabled={disabled}
              onToggle={() => void toggleAgentType(agentType)}
              open={openType === agentType}
              onOpenChange={(open) =>
                setSearchParams(
                  (params) => {
                    const next = new URLSearchParams(params);
                    if (open) next.set("models", agentType);
                    else next.delete("models");
                    return next;
                  },
                  { replace: true }
                )
              }
            />
          );
        })}
      </div>

      {error ? <p className="text-body-md text-destructive">{error}</p> : null}
    </div>
  );
}
