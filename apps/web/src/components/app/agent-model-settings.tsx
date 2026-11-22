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
import { Alert } from "@/components/ui/alert";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { SettingRow } from "@/components/ui/setting-row";

/** One agent type's model filter, inside its row in Settings → Agents. */
export function AgentModelSettings({
  agentType,
}: {
  agentType: AgentType;
}): JSX.Element {
  const { options, allOptions, autoEnable, loading, loaded } =
    useAgentModelCatalog(agentType);
  const { mutateAsync } = useUpdateModelAvailability();
  const [error, setError] = useState<unknown>();
  const typeLabel = AGENT_TYPE_LABELS[agentType];

  const save = (change: ModelAvailabilityChange) => {
    setError(undefined);
    // Awaited per change: an observer only reports the latest one's failure.
    mutateAsync(change).catch(setError);
  };

  if (!loaded)
    return loading ? (
      <LoadingSkeleton label="Loading models…" className="w-auto p-3" />
    ) : (
      <Alert title="Couldn’t load models." className="m-3">
        Reload to try again.
      </Alert>
    );

  return (
    <div data-testid={`agent-models-${agentType}`}>
      <SettingRow
        label="Auto-enable new models"
        className="rounded-none border-0 bg-transparent"
      >
        <Switch
          aria-label={`Auto-enable new ${typeLabel} models`}
          checked={autoEnable}
          onCheckedChange={(next) => save({ agentType, autoEnable: next })}
        />
      </SettingRow>

      {error ? (
        <Alert
          title="Couldn’t save changes."
          error={error}
          className="mx-3 mb-2"
        />
      ) : null}

      {allOptions.length === 0 ? (
        <p
          role="status"
          className="border-t border-border-subtle px-3 py-3 text-body-sm text-muted-foreground"
        >
          Models appear after the first {typeLabel} agent starts.
        </p>
      ) : (
        <ul
          aria-label={`${typeLabel} models`}
          className="border-t border-border-subtle py-1"
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
                      : "cursor-pointer hover:bg-surface-hover"
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
                        "block break-words text-body-md",
                        !on && "text-muted-foreground"
                      )}
                    >
                      {model.label}
                    </span>
                    {last ? (
                      <span className="block text-body-sm text-muted-foreground">
                        At least one model must stay on.
                      </span>
                    ) : null}
                  </span>
                  {model.isNew ? (
                    <span className="shrink-0 text-body-sm text-primary">
                      New
                    </span>
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
