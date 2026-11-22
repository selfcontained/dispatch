import { useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import {
  type ModelAvailabilityChange,
  useUpdateModelAvailability,
} from "@/hooks/use-model-availability";
import { AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

/** One agent type's model filter, inside its row in Settings → Agents. */
export function AgentModelSettings({
  agentType,
}: {
  agentType: AgentType;
}): JSX.Element {
  const { options, allOptions, autoEnable, loading, loaded } =
    useAgentModelCatalog(agentType);
  const { mutateAsync } = useUpdateModelAvailability();
  const [error, setError] = useState("");
  const typeLabel = AGENT_TYPE_LABELS[agentType];

  const save = (change: ModelAvailabilityChange) => {
    setError("");
    // Awaited per change: an observer only reports the latest one's failure.
    mutateAsync(change).catch((err: Error) =>
      setError(err.message || "Couldn’t save. Try again.")
    );
  };

  if (!loaded)
    return (
      <p
        role={loading ? "status" : "alert"}
        className={cn(
          "px-3 py-3 text-xs",
          loading ? "text-muted-foreground" : "text-destructive"
        )}
      >
        {loading
          ? "Loading models…"
          : "Couldn’t load models. Reload to try again."}
      </p>
    );

  return (
    <div data-testid={`agent-models-${agentType}`}>
      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2.5">
        <span className="text-sm">Auto-enable new models</span>
        <Switch
          aria-label={`Auto-enable new ${typeLabel} models`}
          checked={autoEnable}
          onCheckedChange={(next) => save({ agentType, autoEnable: next })}
        />
      </label>

      {error ? (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {allOptions.length === 0 ? (
        <p
          role="status"
          className="border-t border-border/60 px-3 py-3 text-xs text-muted-foreground"
        >
          Models appear after the first {typeLabel} agent starts.
        </p>
      ) : (
        <ul
          aria-label={`${typeLabel} models`}
          className="border-t border-border/60 py-1"
        >
          {allOptions.map((model) => {
            const on = options.some((option) => option.id === model.id);
            const last = on && options.length === 1;
            return (
              <li key={model.id}>
                <label
                  className={cn(
                    "flex min-h-11 items-center gap-3 px-3 py-1.5 transition-colors",
                    last
                      ? "cursor-not-allowed"
                      : "cursor-pointer hover:bg-muted/50"
                  )}
                >
                  <Checkbox
                    id={`model-${agentType}-${model.id}`}
                    checked={on}
                    disabled={last}
                    onCheckedChange={() =>
                      save({ agentType, model: model.id, enabled: !on })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block break-words text-sm",
                        !on && "text-muted-foreground"
                      )}
                    >
                      {model.label}
                    </span>
                    {last ? (
                      <span className="block text-xs text-muted-foreground">
                        At least one model must stay on.
                      </span>
                    ) : null}
                  </span>
                  {model.isNew ? (
                    <span className="shrink-0 text-xs text-primary">New</span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
