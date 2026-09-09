import { useCallback, useEffect, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  CLI_AGENT_TYPES,
} from "@/lib/agent-types";

/**
 * Every type this card can toggle. The Dispatch Harness is not one: it has
 * its own setting (`DispatchHarnessSettings`), and the server answers 400 to
 * an agent-types POST that names it, so a checkbox here would be a switch
 * that cannot be saved.
 */
type ToggleableAgentType = Exclude<AgentType, "dispatch">;

function isToggleableAgentType(type: AgentType): type is ToggleableAgentType {
  return type !== "dispatch";
}

const TOGGLEABLE_CLI_AGENT_TYPES: ToggleableAgentType[] = (
  CLI_AGENT_TYPES as readonly AgentType[]
).filter(isToggleableAgentType);

type AgentTypeSettingsResponse = {
  enabledAgentTypes: AgentType[];
};

const AGENT_TYPE_DESCRIPTIONS: Record<ToggleableAgentType, string> = {
  claude: "Claude Code CLI by Anthropic.",
  codex: "Codex CLI by OpenAI.",
  cursor: "Cursor Agent CLI by Anysphere.",
  opencode: "OpenCode CLI, an open-source terminal agent.",
  terminal: "Raw shell session with no AI agent.",
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
}: {
  agentType: ToggleableAgentType;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <label
      className={cn(
        "flex items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors",
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
        <div className="text-sm font-medium text-foreground">
          {AGENT_TYPE_LABELS[agentType]}
        </div>
        <div className="text-xs text-muted-foreground">
          {disabled
            ? "At least one type must stay enabled."
            : AGENT_TYPE_DESCRIPTIONS[agentType]}
        </div>
      </div>
    </label>
  );
}

export function AgentTypeSettings({
  enabledAgentTypes,
  onChange,
}: AgentTypeSettingsProps): JSX.Element {
  // Filtered on the way in as well as out: a prerelease install can still
  // have `dispatch` in the persisted row, and letting it into this state
  // would put it in the next POST body, which the server refuses.
  const [agentTypes, setAgentTypes] = useState<ToggleableAgentType[]>(() =>
    enabledAgentTypes.filter(isToggleableAgentType)
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setAgentTypes(enabledAgentTypes.filter(isToggleableAgentType));
  }, [enabledAgentTypes]);

  useEffect(() => {
    let cancelled = false;

    void api<AgentTypeSettingsResponse>("/api/v1/app/settings/agent-types")
      .then((data) => {
        if (cancelled) return;
        setAgentTypes(data.enabledAgentTypes.filter(isToggleableAgentType));
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
    async (agentType: ToggleableAgentType) => {
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
        setAgentTypes(data.enabledAgentTypes.filter(isToggleableAgentType));
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
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Available agent types
        </div>
        <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
          Choose which agent runtimes can be created from the app. Disabled
          types are removed from the create-agent dialog. The Dispatch Harness
          has its own switch below.
        </p>
      </div>

      <div className="max-w-lg space-y-2">
        {TOGGLEABLE_CLI_AGENT_TYPES.map((agentType) => {
          const checked = agentTypes.includes(agentType);
          const disabled = checked && agentTypes.length === 1;
          return (
            <AgentTypeRow
              key={agentType}
              agentType={agentType}
              checked={checked}
              disabled={disabled}
              onToggle={() => void toggleAgentType(agentType)}
            />
          );
        })}
      </div>

      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Other
        </div>
      </div>

      <div className="max-w-lg space-y-2">
        <AgentTypeRow
          agentType="terminal"
          checked={agentTypes.includes("terminal")}
          disabled={agentTypes.includes("terminal") && agentTypes.length === 1}
          onToggle={() => void toggleAgentType("terminal")}
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
