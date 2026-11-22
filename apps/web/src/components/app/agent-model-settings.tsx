import { useAtom, useSetAtom } from "jotai";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";
import {
  INITIAL_AVAILABILITY,
  modelAvailabilityAtom,
  seenModelsAtom,
  simulateRelease,
  type TypeAvailability,
} from "@/lib/model-availability-preview";
import { cn } from "@/lib/utils";

export function AgentModelSettings({
  agentType,
}: {
  agentType: AgentType;
}): JSX.Element {
  const { options, allOptions, loading, loaded } =
    useAgentModelCatalog(agentType);
  const [availability, setAvailability] = useAtom(modelAvailabilityAtom);

  const state = availability[agentType] ?? INITIAL_AVAILABILITY;
  const typeLabel = AGENT_TYPE_LABELS[agentType];
  const update = (next: Partial<TypeAvailability>) =>
    setAvailability((all) => ({
      ...all,
      [agentType]: { ...state, ...next },
    }));

  if (!loaded || allOptions.length === 0)
    return (
      <p
        role={loading || loaded ? "status" : "alert"}
        className={cn(
          "px-3 py-3 text-xs",
          loading || loaded ? "text-muted-foreground" : "text-destructive"
        )}
      >
        {loading
          ? "Loading models…"
          : loaded
            ? `Models appear after the first ${typeLabel} agent starts.`
            : "Couldn’t load models. Reload to try again."}
      </p>
    );

  return (
    <div data-testid={`agent-models-${agentType}`}>
      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2.5">
        <span className="text-sm">Auto-enable new models</span>
        <Switch
          aria-label={`Auto-enable new ${typeLabel} models`}
          checked={state.autoEnable}
          onCheckedChange={(autoEnable) => update({ autoEnable })}
        />
      </label>

      <ul
        aria-label={`${typeLabel} models`}
        className="border-t border-border/60 py-1"
      >
        {allOptions.map((model) => {
          const on = !state.off.includes(model.id);
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
                    update({
                      off: on
                        ? [...state.off, model.id]
                        : state.off.filter((id) => id !== model.id),
                    })
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
    </div>
  );
}

/** Controls for trying the design; removed with the preview state. */
export function ModelPreviewControls({
  agentType,
}: {
  agentType: AgentType | null;
}): JSX.Element {
  const [availability, setAvailability] = useAtom(modelAvailabilityAtom);
  const setSeen = useSetAtom(seenModelsAtom);
  const state = (agentType && availability[agentType]) || INITIAL_AVAILABILITY;
  return (
    <div className="flex max-w-lg flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="mr-auto">Design preview</span>
      {agentType === "codex" ? (
        <Button
          size="sm"
          variant="ghost"
          className="text-xs"
          disabled={state.released}
          onClick={() =>
            setAvailability((all) => ({
              ...all,
              [agentType]: simulateRelease(state),
            }))
          }
        >
          Simulate new {AGENT_TYPE_LABELS[agentType]} model
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        className="text-xs"
        onClick={() => {
          setAvailability({});
          setSeen([]);
        }}
      >
        Reset
      </Button>
    </div>
  );
}
