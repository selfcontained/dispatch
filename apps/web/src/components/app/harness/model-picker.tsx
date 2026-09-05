import { useEffect, useState } from "react";
import type { HarnessConfigOption } from "@dispatch/shared";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { configChoices, isConfigGroup } from "./use-harness-config";

export type ModelPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: HarnessConfigOption | undefined;
  effort: HarnessConfigOption | undefined;
  /** False while the agent has no live session: the picker explains and disables. */
  running: boolean;
  saving: boolean;
  error: string | null;
  /** Apply the changed options, in order; resolves when the session took them. */
  onApply: (changes: { configId: string; value: string }[]) => Promise<void>;
};

/**
 * The model and reasoning-effort picker for a Dispatch Harness session,
 * opened from the composer's chip or the /model command. Both selects are
 * fed by the session's own config options, so what is listed is what dsh
 * will accept, filtered to the providers the service has keys for.
 */
export function ModelPicker({
  open,
  onOpenChange,
  model,
  effort,
  running,
  saving,
  error,
  onApply,
}: ModelPickerProps): JSX.Element {
  const [modelValue, setModelValue] = useState(model?.currentValue ?? "");
  const [effortValue, setEffortValue] = useState(effort?.currentValue ?? "");
  // Re-seed from the session each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setModelValue(model?.currentValue ?? "");
    setEffortValue(effort?.currentValue ?? "");
  }, [open, model?.currentValue, effort?.currentValue]);

  const modelChanged = !!model && modelValue !== model.currentValue;
  const effortChanged = !!effort && effortValue !== effort.currentValue;
  const canApply = running && !saving && (modelChanged || effortChanged);
  const selectedModel = configChoices(model).find(
    (c) => c.value === modelValue
  );
  const selectedEffort = configChoices(effort).find(
    (c) => c.value === effortValue
  );

  const apply = async () => {
    const changes: { configId: string; value: string }[] = [];
    if (model && modelChanged) {
      changes.push({ configId: model.id, value: modelValue });
    }
    if (effort && effortChanged) {
      changes.push({ configId: effort.id, value: effortValue });
    }
    await onApply(changes);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="harness-model-picker">
        <DialogHeader>
          <DialogTitle>Model and effort</DialogTitle>
          <DialogDescription>
            {running
              ? "Applies to the next turn of this session."
              : "The agent has no live session; start it to change these."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label
              className="text-xs text-muted-foreground"
              htmlFor="harness-model"
            >
              Model
            </label>
            <Select
              value={modelValue}
              onValueChange={setModelValue}
              disabled={!running || !model}
            >
              <SelectTrigger
                id="harness-model"
                data-testid="harness-model-select"
              >
                <SelectValue placeholder="Choose a model" />
              </SelectTrigger>
              <SelectContent>
                {model?.options.map((entry) =>
                  isConfigGroup(entry) ? (
                    <SelectGroup
                      key={entry.groupId ?? entry.group ?? entry.name}
                    >
                      <SelectLabel>{entry.name}</SelectLabel>
                      {entry.options.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.name}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
            {selectedModel?.description ? (
              <p className="text-[11px] text-muted-foreground">
                {selectedModel.description}
              </p>
            ) : null}
          </div>
          {effort ? (
            <div className="space-y-1.5">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="harness-effort"
              >
                {effort.name}
              </label>
              <Select
                value={effortValue}
                onValueChange={setEffortValue}
                disabled={!running}
              >
                <SelectTrigger
                  id="harness-effort"
                  data-testid="harness-effort-select"
                >
                  <SelectValue placeholder="Choose an effort" />
                </SelectTrigger>
                <SelectContent>
                  {configChoices(effort).map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedEffort?.description ? (
                <p className="text-[11px] text-muted-foreground">
                  {selectedEffort.description}
                </p>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canApply}
              onClick={() => void apply()}
              data-testid="harness-model-apply"
            >
              {saving ? "Applying…" : "Apply"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
