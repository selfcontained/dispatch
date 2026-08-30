import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { SwitchToggle } from "@/components/app/jobs-form-fields";

import { parseLoopItems } from "../../../../server/src/shared/lib/loop-text";

export type ContinuationDraft = {
  enabled: boolean;
  maxIterations: string;
  completionCriteria: string[];
  recoveryInstructions: string;
};

export const defaultContinuationDraft: ContinuationDraft = {
  enabled: false,
  maxIterations: "10",
  completionCriteria: [],
  recoveryInstructions: "",
};

export function continuationMaxIterations(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function loopItemsFromText(value: string): string[] {
  const lines = parseLoopItems(value);
  return lines.length ? lines : [""];
}

export function loopItemsToText(items: string[]): string {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `- ${item}`)
    .join("\n");
}

export function normalizeLoopItems(items: string[]): string[] | null {
  const normalized = items.map((item) => item.trim()).filter(Boolean);
  return normalized.length ? normalized : null;
}

export function LoopSetup({
  draft,
  onChange,
  idPrefix,
}: {
  draft: ContinuationDraft;
  onChange: (next: ContinuationDraft) => void;
  idPrefix: string;
}) {
  const maxIterationsValid =
    !draft.maxIterations.trim() ||
    Boolean(continuationMaxIterations(draft.maxIterations));

  return (
    <section className="rounded-md border border-border/70 bg-muted/20 p-4 text-sm">
      <div className="mb-3">
        <h3 className="font-medium text-foreground">Loop setup</h3>
      </div>
      <label className="flex items-center justify-between gap-3">
        <span>
          <span className="block font-medium text-foreground">
            Run as a loop
          </span>
          <span className="block text-xs text-muted-foreground">
            Keep starting new runs until the work is done.
          </span>
        </span>
        <SwitchToggle
          checked={draft.enabled}
          onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
          ariaLabel="Run as a loop"
        />
      </label>
      {draft.enabled ? (
        <div className="mt-4 grid gap-4 border-t border-border/70 pt-4">
          <p className="text-xs text-muted-foreground">
            The job prompt defines how each run works and where it keeps shared
            context. Each completed run passes its outcome, next step, relevant
            files, and blockers to the next run.
          </p>
          <div className="space-y-1">
            <label
              className="text-sm text-muted-foreground"
              htmlFor={`${idPrefix}-max-iterations`}
            >
              Maximum runs
            </label>
            <Input
              id={`${idPrefix}-max-iterations`}
              value={draft.maxIterations}
              onChange={(event) =>
                onChange({ ...draft, maxIterations: event.target.value })
              }
              placeholder="10"
              inputMode="numeric"
              aria-invalid={!maxIterationsValid}
              aria-describedby={
                maxIterationsValid
                  ? `${idPrefix}-max-iterations-help`
                  : `${idPrefix}-max-iterations-help ${idPrefix}-max-iterations-error`
              }
            />
            <p
              id={`${idPrefix}-max-iterations-help`}
              className="text-xs text-muted-foreground"
            >
              Leave blank for no limit.
            </p>
            {!maxIterationsValid ? (
              <p
                id={`${idPrefix}-max-iterations-error`}
                role="alert"
                className="text-xs text-status-blocked"
              >
                Use a positive whole number or leave this blank.
              </p>
            ) : null}
          </div>
          <div className="border-t border-border/70 pt-4">
            <div className="grid gap-4 md:grid-cols-2">
              <LoopListField
                id={`${idPrefix}-completionCriteria`}
                label="Done when"
                placeholder="Describe the result that ends the loop."
                value={draft.completionCriteria}
                onChange={(completionCriteria) =>
                  onChange({ ...draft, completionCriteria })
                }
              />
              <LoopListField
                id={`${idPrefix}-recoveryInstructions`}
                label="If a run is interrupted"
                placeholder="Optional instructions for resuming the work."
                value={loopItemsFromText(draft.recoveryInstructions)}
                onChange={(items) =>
                  onChange({
                    ...draft,
                    recoveryInstructions: loopItemsToText(items),
                  })
                }
              />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function LoopListField({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const items = value.length ? value : [""];

  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-medium text-foreground">{label}</legend>
      <div className="grid gap-2">
        {items.map((item, index) => (
          <div
            className="flex min-w-0 items-center gap-2"
            key={`${id}-${index}`}
          >
            <Input
              id={`${id}-${index}`}
              value={item}
              onChange={(event) => {
                const next = [...items];
                next[index] = event.target.value;
                onChange(next);
              }}
              placeholder={index === 0 ? placeholder : "Add another..."}
              aria-label={`${label} item ${index + 1}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              aria-label={`Remove ${label.toLowerCase()} item ${index + 1}`}
              onClick={() => {
                const next = items.filter(
                  (_, itemIndex) => itemIndex !== index
                );
                onChange(next);
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={!items.at(-1)?.trim()}
        onClick={() => onChange([...items, ""])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add item
      </Button>
    </fieldset>
  );
}
