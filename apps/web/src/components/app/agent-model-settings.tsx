import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  type AgentModelOption,
  useAgentModelCatalog,
} from "@/hooks/use-agent-model-catalog";
import { useTemplates } from "@/hooks/use-templates";
import { api } from "@/lib/api";
import { AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";
import {
  followsLatest,
  INITIAL_AVAILABILITY,
  modelAvailabilityAtom,
  simulateRelease,
  type TypeAvailability,
} from "@/lib/model-availability-preview";
import { cn } from "@/lib/utils";

type SavedChoice = {
  id: string;
  name: string;
  agentType: AgentType;
  model: string | null;
};

function useSavedChoices(agentType: AgentType) {
  const templates = useTemplates();
  const jobs = useQuery<SavedChoice[]>({
    queryKey: ["jobs"],
    queryFn: () => api("/api/v1/jobs"),
  });
  return (model: string) =>
    [
      ...(templates.data ?? []).map((t) => ({ ...t, kind: "Template" })),
      ...(jobs.data ?? []).map((j) => ({ ...j, kind: "Job" })),
    ].filter((c) => c.agentType === agentType && c.model === model);
}

function DefaultModelSelect({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string | null;
  options: readonly AgentModelOption[];
  onChange: (model: string) => void;
}): JSX.Element {
  return (
    <Select value={value ?? ""} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger id={id} className="h-11 sm:h-9">
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent>
        {options.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AgentModelSettings({
  agentType,
}: {
  agentType: AgentType;
}): JSX.Element {
  const { options, allOptions, engineDefault, defaultModel, loading, loaded } =
    useAgentModelCatalog(agentType);
  const [availability, setAvailability] = useAtom(modelAvailabilityAtom);
  const savedChoices = useSavedChoices(agentType);
  const [pending, setPending] = useState<AgentModelOption | null>(null);
  const [replacement, setReplacement] = useState<string | null>(null);
  const [returnFocus, setReturnFocus] = useState<string | null>(null);

  const state = availability[agentType] ?? INITIAL_AVAILABILITY;
  const typeLabel = AGENT_TYPE_LABELS[agentType];
  const update = (next: Partial<TypeAvailability>) =>
    setAvailability((all) => ({
      ...all,
      [agentType]: { ...state, ...next },
    }));

  const toggle = (model: AgentModelOption) => {
    if (state.off.includes(model.id)) {
      update({
        off: state.off.filter((id) => id !== model.id),
        ...(model.id === engineDefault ? { replacement: null } : {}),
      });
    } else if (model.id === defaultModel || savedChoices(model.id).length) {
      setReplacement(null);
      setReturnFocus(`model-${agentType}-${model.id}`);
      setPending(model);
    } else {
      update({ off: [...state.off, model.id] });
    }
  };

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

  const replacingDefault = pending !== null && pending.id === defaultModel;
  const affected = pending ? savedChoices(pending.id) : [];
  const overridden = !!engineDefault && state.off.includes(engineDefault);

  return (
    <div data-testid={`agent-models-${agentType}`}>
      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2.5">
        <span className="min-w-0">
          <span className="block text-sm">
            Turn on new models automatically
          </span>
          <span className="block text-xs text-muted-foreground">
            {state.autoEnable
              ? "New models and versions are available right away."
              : "New models and versions stay off until you turn them on."}
          </span>
        </span>
        <Switch
          aria-label={`Turn on new ${typeLabel} models automatically`}
          checked={state.autoEnable}
          onCheckedChange={(autoEnable) => update({ autoEnable })}
        />
      </label>

      {overridden ? (
        <div className="grid items-center gap-2 border-t border-border/60 px-3 py-2.5 sm:grid-cols-[1fr_13rem]">
          <label htmlFor={`default-model-${agentType}`} className="text-sm">
            Default model
          </label>
          <DefaultModelSelect
            id={`default-model-${agentType}`}
            value={defaultModel}
            options={options}
            onChange={(model) => update({ replacement: model })}
          />
        </div>
      ) : null}

      <ul
        aria-label={`${typeLabel} models`}
        className="border-t border-border/60 py-1"
      >
        {allOptions.map((model) => {
          const on = !state.off.includes(model.id);
          const last = on && options.length === 1;
          const blocked = on ? [] : savedChoices(model.id);
          const notes = [
            followsLatest(agentType, model.id, state) ? "Latest" : null,
            model.id === defaultModel ? "Default" : null,
          ].filter(Boolean);
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
                  onCheckedChange={() => toggle(model)}
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
                  ) : blocked.length ? (
                    <span className="block text-xs text-status-waiting">
                      Can’t launch: {blocked.map((c) => c.name).join(", ")}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {model.isNew ? (
                    <span className="text-primary">New</span>
                  ) : null}
                  {notes.join(" · ")}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <AlertDialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus) document.getElementById(returnFocus)?.focus();
          }}
        >
          <AlertDialogTitle className="text-base font-semibold">
            Turn off {pending?.label}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sm text-muted-foreground">
            Agents already running keep this model. New launches can’t use it.
          </AlertDialogDescription>
          {replacingDefault ? (
            <div className="space-y-1.5">
              <label
                htmlFor={`replacement-model-${agentType}`}
                className="text-sm"
              >
                New {typeLabel} default
              </label>
              <DefaultModelSelect
                id={`replacement-model-${agentType}`}
                value={replacement}
                options={options.filter((m) => m.id !== pending.id)}
                onChange={setReplacement}
              />
            </div>
          ) : null}
          {affected.length ? (
            <div className="space-y-1.5 text-sm">
              <p className="text-status-waiting">
                These won’t launch until you change their model or turn it back
                on:
              </p>
              <ul className="max-h-40 overflow-y-auto">
                {affected.map((choice) => (
                  <li
                    key={`${choice.kind}-${choice.id}`}
                    className="flex justify-between gap-3 py-1"
                  >
                    <span className="min-w-0 break-words">{choice.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {choice.kind}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="primary"
              disabled={replacingDefault && !replacement}
              onClick={() => {
                if (!pending) return;
                update({
                  off: [...state.off, pending.id],
                  ...(replacingDefault ? { replacement } : {}),
                });
                setPending(null);
              }}
            >
              Turn off
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
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
  const state = (agentType && availability[agentType]) || INITIAL_AVAILABILITY;
  return (
    <div className="flex max-w-lg flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="mr-auto">Design preview</span>
      {agentType === "claude" || agentType === "codex" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={state.release !== null}
          onClick={() =>
            setAvailability((all) => ({
              ...all,
              [agentType]: simulateRelease(agentType, state),
            }))
          }
        >
          Simulate new {AGENT_TYPE_LABELS[agentType]} model
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => setAvailability({})}>
        Reset
      </Button>
    </div>
  );
}
