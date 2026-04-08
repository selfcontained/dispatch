import { useCallback, useEffect, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AGENT_TYPES, AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";

type AgentTypeSettingsResponse = {
  enabledAgentTypes: AgentType[];
};

type AgentTypeSettingsProps = {
  enabledAgentTypes: AgentType[];
  onChange: (agentTypes: AgentType[]) => void;
};

export function AgentTypeSettings({
  enabledAgentTypes,
  onChange,
}: AgentTypeSettingsProps): JSX.Element {
  const [agentTypes, setAgentTypes] = useState<AgentType[]>(enabledAgentTypes);
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
        setError(err instanceof Error ? err.message : "Failed to load agent type settings.");
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
        const data = await api<AgentTypeSettingsResponse>("/api/v1/app/settings/agent-types", {
          method: "POST",
          body: JSON.stringify({ enabledAgentTypes: next }),
        });
        setAgentTypes(data.enabledAgentTypes);
        onChange(data.enabledAgentTypes);
      } catch (err) {
        // Revert on failure
        setAgentTypes(agentTypes);
        onChange(agentTypes);
        setError(err instanceof Error ? err.message : "Failed to save agent type settings.");
      }
    },
    [agentTypes, onChange]
  );

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Available agent types
        </div>
        <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
          Choose which agent runtimes can be created from the app. Disabled types are removed from the create-agent dialog.
        </p>
      </div>

      <div className="max-w-lg space-y-2">
        {AGENT_TYPES.map((agentType) => {
          const checked = agentTypes.includes(agentType);
          const disabled = checked && agentTypes.length === 1;
          return (
            <label
              key={agentType}
              className={cn(
                "flex items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors",
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-muted/50",
              )}
            >
              <Checkbox
                checked={checked}
                disabled={disabled}
                onCheckedChange={() => void toggleAgentType(agentType)}
                data-testid={`agent-type-toggle-${agentType}`}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{AGENT_TYPE_LABELS[agentType]}</div>
                <div className="text-xs text-muted-foreground">
                  {disabled ? "At least one agent type must stay enabled." : "Available in the create-agent dialog."}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
